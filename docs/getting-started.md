# Getting started with lapp-js

`lapp-js` is the TypeScript implementation of LAPP (Local AI Provider Profiles). It gives you a client SDK (`@openlapp/lapp`) and a thin CLI (`lapp`) for reading, validating, and writing `.lapp` profiles, then sending requests directly to configured providers.

```text
.lapp profile
  -> @openlapp/lapp SDK
  -> protocol adapter
  -> provider API
```

`lapp-js` is a client, not a gateway: there is no persistent server, no proxying for other apps, and no billing.

## Install

CLI:

```bash
npm install -g @openlapp/cli
```

SDK in a project:

```bash
npm install @openlapp/lapp
```

Requires Node 18.18 or newer.

## Hello, CLI

Create a profile at `~/.lapp` and chat with the default model:

```bash
lapp init ~/.lapp \
  --provider openai \
  --protocol openai-chat-completions \
  --base-url https://api.openai.com/v1 \
  --secret env://OPENAI_API_KEY \
  --model gpt-4o \
  --yes

lapp validate
lapp chat "Say hi in five words."
lapp doctor
```

Write commands always show a change plan first and require `--yes` to apply (or `--dry-run` to preview only).

## Hello, SDK

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
for await (const ev of client.stream({ messages: [{ role: "user", content: "Hello!" }] })) {
  if (ev.kind === "delta") process.stdout.write(ev.text);
}
```

## Local servers (Ollama, LM Studio, vLLM)

Local OpenAI-compatible servers usually do not need authentication. Use `--no-auth` when initializing:

```bash
lapp init ~/.lapp \
  --provider ollama \
  --protocol openai-chat-completions \
  --base-url http://localhost:11434/v1 \
  --no-auth \
  --model llama3 \
  --yes
```

See [local-providers.md](local-providers.md) for a full walkthrough.

## Supported protocols

| Protocol | Chat | Stream | Tool calls | Model-list sync |
| --- | --- | --- | --- | --- |
| `openai-chat-completions` | yes | yes | yes | yes (`GET /models`) |
| `openai-responses` | yes | yes | yes | yes (`GET /models`) |
| `anthropic-messages` | yes | yes | yes | no public API; set `provider.links.models` to override |

## Where to go next

- [CLI reference](cli.md) — every `lapp` command, flag, and exit code
- [SDK tour](sdk.md) — how to use `@openlapp/lapp` from TypeScript
- [Configuration](configuration.md) — profile anatomy, path resolution, multi-protocol providers
- [Security](security.md) — secret schemes, redaction, and opt-in resolution
- [Protocols](protocols.md) — per-protocol behavior and capability inference
- [Local providers](local-providers.md) — Ollama, LM Studio, vLLM
- [Troubleshooting](troubleshooting.md) — typed errors, warnings, and FAQ
- [Migrating](migrating.md) — changes and known limitations since v1.0.0

## v1 known limitations

- `keychain://` and `file://` secret schemes are parsed but not resolved (only `plaintext` and `env://`).
- Capability inference for synced models is a best-effort heuristic (prefix + token match); providers that don't expose capability metadata can be augmented by editing `models.json` directly.
- `err.raw` on chat errors is deep-scrubbed for common key shapes, but providers that embed credentials in non-string fields are not protected.
