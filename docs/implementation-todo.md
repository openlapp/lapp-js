# lapp-js Implementation TODO

This TODO is the build plan for the first TypeScript SDK + CLI implementation.

## Phase 0 — Scaffold

- [ ] Create pnpm monorepo.
- [ ] Add `packages/lapp` for SDK.
- [ ] Add `packages/cli` for CLI.
- [ ] Add shared TypeScript config.
- [ ] Add test runner.
- [ ] Add lint/format only if it does not slow down the MVP.
- [ ] Import or reference LAPP JSON Schemas from `../lapp/schema`.

Acceptance:

- [ ] `pnpm install` works.
- [ ] `pnpm test` runs a placeholder test.
- [ ] `pnpm build` builds both packages.

## Phase 1 — SDK Read and Validate

- [ ] Implement LAPP path discovery:
  - explicit path
  - `LAPP_HOME`
  - default `~/.lapp`
- [ ] Read `.json` and `.jsonc` files.
- [ ] Parse provider, models, global, manifest.
- [ ] Normalize profile into typed in-memory object.
- [ ] Validate required provider fields.
- [ ] Validate model aliases and duplicate aliases.
- [ ] Validate global default references.
- [ ] Redact secret values in summaries.

Acceptance:

- [ ] SDK loads `../lapp/examples/en/minimal/.lapp`.
- [ ] SDK loads `../lapp/examples/en/full/.lapp` with warning for non-core protocol.
- [ ] SDK detects `../lapp/tools/validator/fixtures/invalid/missing-base-url/.lapp` as invalid.

## Phase 2 — SDK Write and Manage

- [ ] Implement `createProfile()`.
- [ ] Implement `upsertProvider()`.
- [ ] Implement `removeProvider()`.
- [ ] Implement `upsertModel()`.
- [ ] Implement `removeModel()`.
- [ ] Implement `setDefaultModel()`.
- [ ] Implement `planChanges()`.
- [ ] Implement same-directory atomic writes.
- [ ] Write new files as `.json`.
- [ ] Do not preserve comments in v1.
- [ ] Do not create backups.
- [ ] Do not use temporary directories.

Acceptance:

- [ ] Write operation never leaves a partial target file.
- [ ] Failed write removes only its own temp file.
- [ ] `--dry-run` equivalent can show planned files without writing.

## Phase 3 — Secret Resolution and Env Export

- [ ] Parse plaintext secrets.
- [ ] Parse and resolve `env://NAME`.
- [ ] Parse `keychain://` but return unsupported for resolution.
- [ ] Parse `file://` but return unsupported for resolution.
- [ ] Implement `exportEnv()`.
- [ ] Support bash/zsh, fish, PowerShell, cmd output formats.
- [ ] Redact by default in inspect paths.

Acceptance:

- [ ] `env://` resolves only when explicitly requested.
- [ ] Missing env var returns structured error.
- [ ] CLI never prints full secrets unless explicit option is passed.

## Phase 4 — Client SDK

- [ ] Implement target resolution by provider/model.
- [ ] Implement global default target resolution.
- [ ] Implement protocol adapter interface.
- [ ] Implement `openai-chat-completions` adapter.
- [ ] Implement `openai-responses` adapter.
- [ ] Implement `anthropic-messages` adapter.
- [ ] Implement `chat()` returning normalized `LappResponse`.
- [ ] Implement `rawChat()` returning provider-native response.
- [ ] Implement `testConnection()`.
- [ ] Add clear `UnsupportedProtocolError`.

Acceptance:

- [ ] Client can build a request without network for each supported adapter.
- [ ] Mocked provider responses normalize into `{ text, provider, model, protocol, raw }`.
- [ ] Unsupported protocols fail clearly.

## Phase 5 — CLI Thin Wrapper

- [ ] Implement `lapp validate [path]`.
- [ ] Implement `lapp inspect [path]`.
- [ ] Implement `lapp init [path]`.
- [ ] Implement `lapp provider add|set|remove`.
- [ ] Implement `lapp model add|set|remove`.
- [ ] Implement `lapp default set`.
- [ ] Implement `lapp env [path]`.
- [ ] Implement `lapp ping [provider[/model]]`.
- [ ] Implement `lapp chat [provider[/model]] <message>`.
- [ ] Implement `lapp doctor [path]`.

Acceptance:

- [ ] CLI uses SDK APIs for all logic.
- [ ] Write commands support `--dry-run`.
- [ ] Write commands support `--yes`.
- [ ] Secrets are redacted by default.

## Phase 6 — Real Tool Validation

- [ ] Validate `lapp env` with Aider-style env variables.
- [ ] Validate `lapp env` with Continue.dev-compatible variables where applicable.
- [ ] Validate `lapp env` with Codex CLI-compatible user-level env usage where applicable.
- [ ] Validate direct SDK client against at least one test provider using a throwaway key.
- [ ] Write real integration notes from results.

Acceptance:

- [ ] At least one real provider call succeeds through SDK client.
- [ ] At least one CLI `chat` call succeeds through SDK client.
- [ ] Integration notes clearly separate verified paths from unverified paths.

## Decisions Locked for v1

- [x] SDK and CLI live in `lapp-js` first.
- [x] SDK is core; CLI is thin wrapper.
- [x] Write new profile files as JSON.
- [x] No rollback or backup system.
- [x] Atomic writes use same-directory temporary files only.
- [x] Secret resolution supports plaintext and `env://` first.
- [x] Client SDK supports direct provider calls.
- [x] This is a client, not a gateway.
- [x] Supported v1 protocols: OpenAI Chat Completions, OpenAI Responses, Anthropic Messages.
- [x] Unified response shape with raw response preserved.
