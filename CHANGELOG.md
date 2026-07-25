# Changelog

All notable changes to `@openlapp/lapp` and `@openlapp/cli` are documented
in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.1.2] - 2026-07-25

### Added

- Direct image-generation and speech-synthesis clients, normalized generation
  results, bounded artifact downloads, and shared media conformance fixtures.

### Changed

- Canonical schemas, documents, and conformance fixtures are pinned to an
  immutable LAPP commit instead of a working-tree snapshot.
- Manager snapshots include Vault-only mutations in their opaque revision, so
  stale credential rotations fail with `PROFILE_CONFLICT`.

## [0.1.1] - 2026-07-20

The workspace currently uses internal `0.x` package versions published only to
the machine-local beta Registry. No npmjs package or GitHub Release exists yet;
a future public package release will use a fresh `1.x` version and matching Git
tag. The protocol itself is already LAPP v1 and continues to use
`schemaVersion: "1.0"`.

### Added

- A browser-safe manager contract and Node-owned manager host with sanitized
  snapshots, semantic compare-and-swap transactions, a current-user global
  writer lock shared across every Profile root,
  and Vault rollback when a Profile commit fails.
- The former React/Vue renderer packages were removed after their UX, security,
  accessibility, and behavior contracts moved to the future Tauri manager's
  design repository.
- The Electron integration example is an unsupported Node-host embedding
  reference, not a complete GUI or the basis of the standalone Manager.

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
  both public packages and verified by the package smoke test.
- Device-local shared Vault credentials through the current user's native
  credential store, with strict provider/origin/auth binding, asynchronous
  resolution, rotation-aware direct clients, and typed credential errors.
- High-level credential-aware provider management and CLI
  `credential set/status/delete` commands. Newly entered secrets default to
  `vault://provider/default` without passing raw values in process arguments.

### Changed

- Release and pack verification cover the SDK and CLI, including ESM/CJS
  consumers and checks that neither tarball restores removed renderer/UI
  artifacts.
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
- Internal `0.x` packages publish only to the machine-local Registry without a
  Git tag or GitHub Release. Public release automation is reserved for
  `1.0.0+`, requires the tag to match all three workspace manifests, runs every
  quality gate, and verifies installed packed tarballs before npmjs publish.

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
