# lapp-js

TypeScript SDK and CLI workspace for LAPP (Local AI Provider Profiles) **v1.0.0**.

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

## v1.0.0 Scope

- TypeScript monorepo, Node 18.18+.
- JSON output for newly written profile files.
- Read existing JSON or JSONC where practical.
- Atomic writes using same-directory temporary files and rename.
- Secret support: plaintext and `env://` only.
- Supported client protocols:
  - `openai-chat-completions`
  - `openai-responses`
  - `anthropic-messages`
- Unified response shape with raw provider response preserved.
- Native streaming (`client.stream`) and tool calling (`client.executeWithTools`).
- Model-list sync against OpenAI-compatible `/models` endpoints.
- Local/self-hosted providers (Ollama, LM Studio, vLLM) via `allowUnauthenticated`.
- Multi-protocol support: a single provider can declare `protocols: [...]` in preference order; the SDK picks the first supported entry.

See `docs/sdk-cli-design.md` and `docs/code-review-plan.md`.

## Quick start

```ts
import { loadProfile, createLappClient, listModels } from "@openlapp/lapp";

const profile = loadProfile();

// List every available model across all providers
const models = listModels(profile);
// [{ providerId, modelId, protocol, baseUrl, type, capabilities, ... }, ...]

// Chat with the global default
const client = createLappClient({ profile, resolveSecrets: true });
const resp = await client.chat({
  messages: [{ role: "user", content: "Hello!" }],
});
console.log(resp.text);

// Streaming
for await (const ev of client.stream({ messages })) {
  if (ev.kind === "delta") process.stdout.write(ev.text);
}
```

## Local servers (Ollama, LM Studio, vLLM)

Local OpenAI-compatible servers don't need authentication. Use `allowUnauthenticated: true` to skip the auth header (the SDK still fails fast on other resolve errors):

```ts
const client = createLappClient({
  profile,
  provider: "ollama",
  model: "llama3",
  allowUnauthenticated: true,
});
```

In the CLI, pass `--no-auth` to `lapp init` or `lapp provider add`:

```bash
lapp init ~/.lapp \
  --provider ollama \
  --protocol openai-chat-completions \
  --base-url http://localhost:11434/v1 \
  --no-auth \
  --model llama3
```

Sync a local model's model list the same way as any OpenAI-compatible provider — the `name` field Ollama returns is accepted in addition to `id`:

```bash
lapp models sync ~/.lapp --provider ollama --apply --yes
```

## Releasing

1. Tag a release: `git tag v1.0.0 && git push origin v1.0.0`
2. CI runs tests → builds → publishes both packages to npm → creates a GitHub Release.

Or trigger manually from the [Actions tab](https://github.com/openlapp/lapp-js/actions/workflows/release.yml) with the `workflow_dispatch` input.

**Prerequisite:** Add an `NPM_TOKEN` secret to the repo (Settings → Secrets and variables → Actions).

## Supported protocols

| Protocol | Chat | Stream | Tool calls | Model-list sync |
| --- | --- | --- | --- | --- |
| `openai-chat-completions` | yes | yes | yes | yes (`GET /models`) |
| `openai-responses` | yes | yes | yes | yes (`GET /models`) |
| `anthropic-messages` | yes | yes | yes | no public API; set `provider.links.models` to override |

## v1 known limitations

- `keychain://` and `file://` secret schemes are parsed but not resolved (only `plaintext` and `env://`).
- Capability inference for synced models is a best-effort heuristic (prefix + token match); providers that don't expose capability metadata can be augmented by editing `models.json` directly.
- `err.raw` on chat errors is deep-scrubbed for common key shapes, but providers that embed credentials in non-string fields are not protected.

