# Changelog

All notable changes to `@openlapp/lapp` and `@openlapp/cli` are documented in
this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [1.0.0] - 2026-07-15

This is the first public v1 release. Because earlier drafts were never
released, the repository adopts the final v1 contract directly and carries no
compatibility or migration layer for them.

### Added

- Standard-JSON LAPP Profile support with `global.json`, plus one
  `provider.json` and authoritative `models.json` for every Provider.
- Strict v1 Schemas, semantic validation, redacted damaged-Profile inspection,
  filename-safe Provider IDs, path containment, and atomic per-file writes.
- SDK entry points for `loadProfile`, `inspectProfile`, `listModels`,
  `resolveConnection`, `refreshModels`, immutable Profile editing, and explicit
  persistence.
- Direct SDK clients for `openai-chat-completions`, `openai-responses`, and
  `anthropic-messages`, including streaming and validated tool execution.
- A strict CLI for Profile management, local model listing, explicit model
  refresh, connection resolution, direct ping/chat, presets, and stable
  versioned JSON output.
- A bilingual user agreement and risk disclosure template distributed with
  both npm packages and verified by the package smoke test.
- Device-local shared Vault credentials through the current user's native
  credential store, with strict provider/origin/auth binding, asynchronous
  resolution, rotation-aware direct clients, and typed credential errors.
- High-level credential-aware provider management and CLI
  `credential set/status/delete` commands. Newly entered secrets default to
  `vault://provider/default` without passing raw values in process arguments.

### Changed

- `models.json` is local authoritative data. Remote refresh is explicit, returns
  an in-memory result, appends only unknown IDs, may fill missing display names,
  and never removes or overwrites existing models.
- Connection selection uses ordered string protocol IDs and the caller's
  `supportedProtocols`; model-level protocol lists may only narrow their
  Provider list.
- Authentication is a strict `none`, `bearer`, `header`, or `query` union.
  Secrets are plaintext, `env://NAME`, or
  `vault://provider/credential`; plaintext produces a warning and requires
  explicit opt-in in high-level writers.
- Credentials resolve only for the selected connection and remain hidden from
  inspection and every CLI output. Direct clients resolve again before each
  request rather than caching plaintext credentials.
- Release automation now starts only from pushed `v*` tags, requires the tag to
  match both committed package versions, runs all quality gates, publishes
  prereleases under `next`, and verifies installed packed tarballs before publish.

### Removed

- Unreleased draft compatibility, background services, traffic routing,
  remote Profile coordination, persistent conversation storage, and credential
  shell generation are outside the v1 package surface.
- Public `keychain://`, `file://`, custom secret schemes, raw `--secret`
  arguments, and CLI secret reveal/export are not part of the final v1 contract.

### Verification

- CI builds, type-checks, tests, and validates docs and Schemas on Node 18, 20,
  and 22. Packed artifacts receive real package/bin smoke tests on Ubuntu;
  Windows additionally verifies native Vault write/read/rotate/delete behavior
  and cleanup.
