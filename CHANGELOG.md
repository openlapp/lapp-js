# Changelog

All notable changes to `@openlapp/lapp` and `@openlapp/cli` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-07-07

### Added

- **Multi-protocol support** (`protocols` array). A provider can now declare an ordered
  list of supported protocols with per-protocol `baseUrl` and `requestHeaders` overrides.
  The SDK picks the first supported entry; legacy `protocol` (singular string) still works.
  - `packages/lapp/src/protocols.ts`: normalization helpers
  - `types.ts`: new `ProtocolEntry` / `ResolvedProtocolEntry` types
  - `ProfileSummary`: now exposes `protocols: ResolvedProtocolEntry[]`
- **`listModels()` convenience API** (`@openlapp/lapp`): flatten a profile into
  one `{ providerId, modelId, protocol, baseUrl, type, capabilities, ... }` record
  per model. Filters: `providerId`, `includeDisabled`, `includeDisabledModels`.
- **CLI**: `lapp models sync` and `lapp models list` for managing model lists.
- **CLI**: `--stream` and `--tool` flags for `lapp chat`.
- **CLI**: `--no-auth` for `lapp init` / `lapp provider add` (local/self-hosted providers).
- **CLI**: `--kind <chat|embedding|image|tts|video>` for `lapp default set`.
- **Streaming** (`client.stream()`) for all three v1 protocols.
- **Tool calling** with `client.executeWithTools()` multi-turn loop.
- **Model sync** against OpenAI-compatible `/models` endpoints with `add/remove/update`
  diff and source-aware merge (manual entries survive a sync).
- **`allowUnauthenticated`** on `createLappClient` for local/self-hosted providers.

### Changed

- `ProviderConfig.protocol` is still the legacy single-string field; new profiles
  should prefer `protocols: [...]`. `loadProfile` synthesizes `protocol` from the
  first `protocols` entry when absent.
- `ProfileSummary` now includes a `protocols` array alongside the single `protocol` field.

### Fixed

- **`err.raw` redaction**: provider response bodies attached to thrown errors are
  now deep-scrubbed for common key shapes (`sk-...`, `Bearer ...`, etc.) on every
  string leaf, so `console.log(err.raw)` no longer leaks echoed credentials. The
  redacted copy preserves structural shape (arrays, objects, depth up to 64).
- **openai-responses adapter**: multi-turn `assistant` history is now kept as
  `role: "assistant"` (was incorrectly remapped to `role: "developer"`, which
  the Responses API treats as a high-priority system instruction).
- **`ajv` silent-pass when schemas are missing**: `validateProfile` now emits a
  one-time `WARN` diagnostic if no JSON schemas could be loaded, so callers
  can see that structural validation did not run.
- **`updatedAt` semantics**: `models.json`'s `updatedAt` is now only re-stamped
  by the sync flow (`applySyncedModels` tags it with an internal marker); manage
  edits preserve whatever `updatedAt` the caller set.
- **Sync heuristic over-match**: `inferCapabilitiesFromProviderEntry` now matches
  by prefix and word tokens, so chat models with substrings like `image` or
  `m3` in their id are no longer miscategorized as image-generation / embedding.
- **Sync dead code**: `fetchProviderModels` for Anthropic without a `modelsUrl`
  now explicitly `throw`s the result of `fetchAnthropicModels` instead of falling
  through to a generic `UnsupportedProtocolError`.
- **CLI**: `default set` now supports any of the 5 default model slots via `--kind`.

### Notes for v1

- All public API in this release is considered stable until v2.0.0.
- See `docs/code-review-plan.md` for the full review history. All
  Round 1 / Round 2 residuals (carried forward with confidence < 80) have
  been cleaned up in the v1.0.0 release: 313/313 tests pass, build is clean,
  and no Major / Minor residuals remain.

### Fixed (post-v1.0.0 review, Round 4)

- **openai-responses stream tool-call correlation**: `parseStream` keyed the
  accumulator by `chunk.item.call_id` but `function_call_arguments.delta`
  events correlate via top-level `item_id` (which equals `item.id`, not
  `call_id`). Streamed tool-call arguments were silently empty for the
  OpenAI Responses API. Key the accumulator by `item.id`.
- **Duplicate tool-call emission (all 3 adapters)**: in-loop flush
  (`finish_reason` / `response.completed` / `message_stop`) did not clear
  the accumulator, so the post-loop truncated-stream flush re-emitted the
  same tool calls on every normal completion. Added a `flushed` guard.
- **Anthropic stream `input_tokens` dropped**: `message_delta` does not
  carry `input_tokens`; capture them from `message_start` so the yielded
  usage event has the full accounting.
- **`redactRawObject` depth cap leaked secrets**: the depth-64 cap
  short-circuited before string leaves could be scrubbed. Strings are
  scrubbed at every depth; the cap only bounds structural recursion.
- **Sync dropped `requestHeaders`**: `fetchOpenAiCompatModels` only set
  `Content-Type` and the auth header, so a provider requiring a non-auth
  static header (e.g. `X-Tenant-Id`) failed sync while chat worked. Now
  spreads `ctx.requestHeaders` with the same auth-strip discipline.
- **`upsertProvider` wiped multi-protocol array**: passing the legacy
  `protocol` field (no `protocols`) collapsed an existing multi-entry
  array to `[input.protocol]`, violating the overlay-only invariant.
  Preserve `existing.config.protocols` unless the caller passes `protocols`.
- **Sync marker survived manage edits**: `upsertModel` / `removeModel`
  reused the `models` object that carried `__lappUpdatedAtSource: "sync"`,
  so a sync-then-manage sequence silently re-stamped `updatedAt` on what
  was actually a manage edit. Manage edits now clear the marker.
- **CLI `models sync` no `allowUnauthenticated`**: local/unauthenticated
  providers (Ollama with `auth.type:"none"`) threw on sync. The CLI now
  passes `allowUnauthenticated: true` for the documented local-provider
  use case.
- **CLI `model set` wiped aliases**: omitting `--alias` defaulted to
  `[id]`, clobbering user-curated aliases. The `set` subcommand now omits
  aliases when not supplied, preserving them per the overlay-only invariant.
- **CLI `--enabled`/`--disabled` silently ignored**: `cmdProvider` never
  read `flags.enabled`/`flags.disabled`. Now honored.
- **Shared redaction + adapter header helpers**: extracted
  `packages/lapp/src/redact.ts` (canonical `SECRET_PATTERNS` / `redactErrorText`
  / `redactRawObject`) and `packages/lapp/src/client/http.ts`
  (`buildAuthHeaders` / `buildAuthHeadersWith`) so the three adapters and
  the sync layer share a single source of truth for auth-strip and
  secret-scrubbing.
- **`idHasToken` image-generation dead code**: the literal token
  `"image-generation"` was split by the delimiter into two tokens, so the
  `idHasToken` branch never matched. Replaced with a substring check via
  a new `lowerIdHasToken` helper.
