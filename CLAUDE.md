# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`lapp-js` is a TypeScript monorepo implementing the LAPP (Local AI Provider Profiles) convention: a **client SDK** (`@openlapp/lapp`) that reads, validates, writes, manages `.lapp` profiles and calls providers directly, plus a **thin CLI** (`lapp`) that wraps the SDK. It is explicitly **not a gateway** — no persistent server, no proxying for other apps, no billing.

The canonical LAPP spec, JSON Schemas, example profiles, and validator fixtures live in a **sibling repo** at `../lapp` (see `scripts/lapp-paths.mts`). This repo imports schemas from there and its tests load `../lapp/examples` and `../lapp/tools/validator/fixtures`. The build copies schemas into `packages/lapp/schema/` so the published package is self-contained.

## Commands

Run from repo root. Workspace uses **pnpm** (`packageManager: pnpm@10.29.2`), Node `>=18.18.0`.

- `pnpm install` — install workspace deps.
- `pnpm build` — builds `@openlapp/lapp` then `lapp` (filtered order matters: CLI depends on the SDK). The SDK's `prebuild` runs `copy-schema` first.
- `pnpm test` — run vitest once (`vitest run`). Tests are in `packages/**/test/**/*.test.ts`.
- `pnpm test:watch` — vitest watch mode.
- Run a single test file: `pnpm vitest run packages/lapp/test/client.test.ts`
- Run a single test by name: `pnpm vitest run -t "resolves alias to real model id"`
- `pnpm lint` — runs `pnpm -r run lint`; **note**: no package defines a `lint` script today, so this is currently a no-op. Add scripts per-package before relying on it.
- `pnpm clean` — `rimraf` each package's `dist` (and the SDK's copied `schema/*.schema.json`).

Per-package build: `pnpm --filter @openlapp/lapp run build`. The SDK builds with `tsup` (ESM+CJS, sourcemaps) then `tsc --emitDeclarationOnly` for `.d.ts`; the CLI builds with `tsup` (ESM only, `#!/usr/bin/env node` banner). Both target ES2022 / NodeNext module resolution (see `tsconfig.base.json`: strict, `noUncheckedIndexedAccess`, `isolatedModules`).

## Architecture

### SDK layers (`packages/lapp/src/`)

The SDK is the product; the CLI is only its first consumer. **All profile logic belongs in the SDK** — the CLI must not implement parsing, editing, or request building itself.

- **`config/`** — `discovery.ts` resolves the root (explicit path > `LAPP_HOME` env > `~/.lapp`), scans `providers/<id>/provider.json|jsonc`, loads `models.json|jsonc`, `global.json|jsonc`, `manifest.json|jsonc`, and normalizes into `LappProfile`. `jsonc.ts` strips comments — **ported verbatim** from `../lapp/tools/validator/lapp-validate.mjs::stripJsonc` so parsing matches upstream exactly; do not "improve" it divergently.
- **`validate/`** — two layers stacked: (1) JSON Schema via ajv against the LAPP schemas, (2) custom semantic rules in code. The semantic layer exists because the schemas use `additionalProperties: true` for forward-compat (spec: "safely ignore unknown fields"), so checks like alias duplicates, global-ref existence, secret-scheme warnings, and sensitive-header warnings live in `validate/index.ts`, not the schema. `constants.ts` holds `CORE_PROTOCOLS` (the 3 v1 protocols) and `SENSITIVE_HEADERS`.
- **`manage/`** — pure/immutable profile mutation: `createProfile`, `upsertProvider`, `upsertModel`, `removeProvider`, `removeModel`, `setDefaultModel`. Each returns a **new** `LappProfile` (uses `structuredClone`); they never touch disk. `upsert*` overlays only the fields the caller supplied onto the existing entry so a partial update (e.g. `model set --type`) doesn't wipe siblings.
- **`plan.ts`** — `planChanges(before, after)` computes a file-level create/modify/delete diff so the CLI can show what would happen before writing. Treats existing `.jsonc` as `.json` write targets (new files are always `.json`).
- **`write/atomic.ts`** — `writeProfileAtomic` implements the design's atomic-write rule: build in memory → validate → write a hidden same-dir temp file → `fsync` → rename over target → on failure remove only that temp. **No backup, no rollback, no temp directory.** Validates before touching disk and refuses to write invalid profiles. Pass `options.before` (the on-disk profile before the edit) so removed providers' orphan `provider.json`/`models.json` get unlinked after writes succeed. `stableStringify` sorts keys and strips `__`-prefixed internal fields for deterministic output.
- **`secret/`** — `parseSecretRef`, `redactSecret`, `resolveSecret`. v1 resolves only `plaintext` and `env://NAME`; `keychain://` and `file://` are parsed but return `UnsupportedSecretSchemeError` at runtime. **Never reads `process.env` unless `resolve: true`** — opt-in is mandatory.
- **`env-export/`** — `exportEnv` emits shell statements (bash/zsh/fish/powershell/cmd) for the profile's secrets, for sourcing into tools that read keys from env (Aider, Continue.dev, Codex CLI). Same opt-in policy; plaintext requires both `resolve` and `allowPlaintext`.
- **`client/`** — `createLappClient({ profile, provider, model })` resolves a target, picks a protocol adapter, exposes `chat` / `rawChat` / `testConnection`. Requests go **directly** to the provider. Three adapters: `openai-chat`, `openai-responses`, `anthropic-messages`, all implementing the `ProtocolAdapter` interface in `adapter.ts` (`buildRequest` + `parseResponse` into the unified `LappResponse` shape with `raw` preserved). Unsupported protocols throw `UnsupportedProtocolError`.

### CLI (`packages/cli/src/index.ts`)

Single-file CLI. Parse args → call SDK → print. Write commands always show the `planChanges` diff first and require `--yes` to apply (or `--dry-run` to only preview). Secrets are redacted by default; `--reveal-secrets` opts in. Error text is scrubbed with `redactAll` (regex `SECRET_PATTERNS`) as defense-in-depth before printing — note the model's reply in `chat` is printed **verbatim** and deliberately not redacted (redaction would mangle legitimate key-shaped content).

### Cross-cutting rules to preserve

- **Disabled providers** (`enabled: false`) are kept in `profile.providers` during load so writes can round-trip the on-disk file, but are **skipped** by the client (target resolution) and by `env-export`. Don't filter them at load time.
- **Secrets**: redact by default everywhere (inspect, diagnostics, CLI output). Resolving `env://` requires explicit opt-in. The client fails fast on unresolved secrets rather than sending a placeholder — never substitute a bogus value.
- **Auth-header dedup**: adapters strip auth-carrying keys (`authorization`, `x-api-key`) from user `requestHeaders` case-insensitively before adding their own, so a user-supplied `X-Api-Key` doesn't produce two distinct headers. When `auth.queryParam` is set, the client strips header auth to avoid leaking the secret in both URL and header logs.
- **URL handling**: the SDK never auto-appends `/v1` for OpenAI-compatible providers (many include it in `baseUrl`); Anthropic's adapter dedups a trailing `/v1` only when it's the sole last segment. `baseUrl` should not end with `/` (warned).
- **Internal fields**: `__file`, `__dirName`, and any `__`-prefixed keys are bookkeeping only — stripped on write by `stableStringify`.

## Testing notes

Tests import paths from `scripts/lapp-paths.mts`, which resolves `../lapp` relative to this repo. **If the sibling `lapp` repo is not checked out alongside `lapp-js`, the example/fixture-based tests in `load.test.ts` will fail** (the SDK's own unit tests in `client.test.ts`, `manage-write.test.ts`, `secret.test.ts`, `env-export.test.ts`, `jsonc.test.ts` use in-memory profiles and a stubbed `fetchImpl` and run without it). `vitest.config.ts` sets `globals: false` (import `describe`/`it`/`expect` from `vitest`) and `environment: "node"`.
