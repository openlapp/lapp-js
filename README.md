# lapp-js

The TypeScript SDK and CLI for **LAPP** (Local AI Provider Profiles): describe your AI providers once in a local profile, then call them from the terminal or from TypeScript. **v1.0.0**

> **Languages:** [English](README.md) | [中文](README_zh.md)

`lapp-js` is a **client, not a gateway** — no persistent server, no proxying for other apps, no billing. Your process talks to the provider directly.

```text
.lapp profile  →  @openlapp/lapp SDK  →  protocol adapter  →  provider API
```

| Package | What it is |
|---------|------------|
| [`@openlapp/cli`](docs/cli.md) | The `lapp` command — configure and chat from your terminal. |
| [`@openlapp/lapp`](docs/sdk.md) | The SDK — read, write, and use profiles from TypeScript. |

## Install

```bash
npm install -g @openlapp/cli     # the CLI
npm install @openlapp/lapp       # the SDK, in a project
```

Requires Node 18.18 or newer.

## The 30-second tour

**Setup is once. Chat is every time.** You write a small profile that says where your provider lives and which model to use — then chatting is a one-liner. For well-known providers, a preset fills in the protocol, base URL, and suggested secret for you.

```bash
# 1) One-time setup — a preset does the heavy lifting (see `lapp presets`)
lapp provider add --id openai --model gpt-4o --yes

# 2) Chat — one line, uses the default model you just set
lapp chat "Say hi in five words."

# 3) Switch model on the fly — inline…
lapp chat openai/gpt-4o-mini "Quick question."

# …or with flags
lapp chat "Another one" --provider openai --model gpt-4o-mini

# 4) Stream the reply
lapp chat "Count to ten" --stream
```

> **No preset for your provider?** Pass the protocol and base URL explicitly:
> `lapp provider add --id my-proxy --protocol openai-chat-completions --base-url https://my-proxy/v1 --secret env://MY_PROXY_KEY --yes`. Every write command shows a change plan first and needs `--yes` to apply (use `--dry-run` to preview).

### Copy-paste recipes

Pick your provider, copy the block, set the env var, chat.

**OpenAI**

```bash
export OPENAI_API_KEY=sk-...
lapp provider add --id openai --model gpt-4o --yes
lapp chat "Hello."
```

**Anthropic**

```bash
export ANTHROPIC_API_KEY=sk-ant-...
lapp provider add --id anthropic --model claude-sonnet-4 --yes
lapp chat "Hello."
```

**DeepSeek** (OpenAI-compatible)

```bash
export DEEPSEEK_API_KEY=sk-...
lapp provider add --id deepseek --model deepseek-chat --yes
lapp chat "Hello."
```

**Ollama** (local, no auth)

```bash
lapp provider add --id ollama --yes
lapp models sync --provider ollama --apply --set-default --yes   # pull the model list
lapp chat "Hello, Ollama."
```

## Use it from TypeScript

```bash
npm install @openlapp/lapp
```

```ts
import { loadProfile, createLappClient, listModels } from "@openlapp/lapp";

const profile = loadProfile();

// Every available model, across all providers
const models = listModels(profile);

// Chat with the global default
const client = createLappClient({ profile, resolveSecrets: true });
const resp = await client.chat({ messages: [{ role: "user", content: "Hello!" }] });
console.log(resp.text);

// Stream
for await (const ev of client.stream({ messages: [{ role: "user", content: "Hello!" }] })) {
  if (ev.kind === "delta") process.stdout.write(ev.text);
}
```

## Supported protocols

| Protocol | Chat | Stream | Tool calls | Model-list sync |
| --- | --- | --- | --- | --- |
| `openai-chat-completions` | yes | yes | yes | yes (`GET /models`) |
| `openai-responses` | yes | yes | yes | yes (`GET /models`) |
| `anthropic-messages` | yes | yes | yes | no public API; set `provider.links.models` to override |

## Documentation

- **[Getting started](docs/getting-started.md)** — install, first provider, first chat (start here)
- **[CLI reference](docs/cli.md)** — every `lapp` command, flag, and exit code
- **[SDK tour](docs/sdk.md)** — using `@openlapp/lapp` from TypeScript
- [Configuration](docs/configuration.md) — profile anatomy, path resolution, multi-protocol providers
- [Security](docs/security.md) — secret schemes, redaction, opt-in resolution
- [Protocols](docs/protocols.md) — per-protocol behavior and capability inference
- [Local providers](docs/local-providers.md) — Ollama, LM Studio, vLLM
- [Troubleshooting](docs/troubleshooting.md) — typed errors, warnings, FAQ
- [Migrating](docs/migrating.md) — changes and known limitations since v1.0.0
- [API reference](packages/lapp/docs/api.md) · [CHANGELOG](CHANGELOG.md) · [中文文档](README_zh.md)

## v1 known limitations

- `keychain://` and `file://` secret schemes are parsed but not resolved (only `plaintext` and `env://`).
- Capability inference for synced models is a best-effort heuristic (prefix + token match); providers that don't expose capability metadata can be augmented by editing `models.json` directly.
- `err.raw` on chat errors is deep-scrubbed for common key shapes, but providers that embed credentials in non-string fields are not protected.

## License

MIT
