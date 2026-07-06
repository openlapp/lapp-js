# lapp-js

TypeScript SDK and CLI workspace for LAPP.

This repository is planned as the first real consumer of the LAPP protocol:

- `@openlapp/lapp`: core SDK for reading, writing, validating, and using LAPP profiles.
- `@openlapp/cli`: thin CLI wrapper over the SDK (installs the `lapp` command).

## Current Decision

LAPP remains a local configuration convention. `lapp-js` adds a client SDK, not a gateway:

```text
.lapp profile
  -> @openlapp/lapp SDK
  -> protocol adapter
  -> provider API
```

The CLI must stay thin. All profile parsing, writing, validation, env export, and client request logic belongs in the SDK.

## First Version Scope

- TypeScript monorepo.
- JSON output for newly written profile files.
- Read existing JSON or JSONC where practical.
- Atomic writes using same-directory temporary files and rename.
- Secret support: plaintext and `env://` only.
- Supported client protocols:
  - `openai-chat-completions`
  - `openai-responses`
  - `anthropic-messages`
- Unified response shape with raw provider response preserved.

See `docs/sdk-cli-design.md` and `docs/implementation-todo.md`.

## Releasing

1. Tag a release: `git tag v0.1.0 && git push origin v0.1.0`
2. CI runs tests → builds → publishes both packages to npm → creates a GitHub Release.

Or trigger manually from the [Actions tab](https://github.com/openlapp/lapp-js/actions/workflows/release.yml) with the `workflow_dispatch` input.

**Prerequisite:** Add an `NPM_TOKEN` secret to the repo (Settings → Secrets and variables → Actions).
