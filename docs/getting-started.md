# Getting started

`lapp-js` lets you describe your AI providers in one local profile, then call them from the terminal (`@openlapp/cli`) or from TypeScript (`@openlapp/lapp`).

```text
.lapp profile  →  @openlapp/lapp SDK  →  protocol adapter  →  provider API
```

It is a **client, not a gateway**: no server, no proxying, no billing — your process talks to the provider directly.

## Install

```bash
npm install -g @openlapp/cli     # the CLI
npm install @openlapp/lapp       # the SDK (in a project)
```

Requires Node 18.18 or newer.

## 1 · Configure a provider (once)

A profile is just a directory (by default `~/.lapp`) holding a few JSON files. The fastest way to create one is `lapp provider add`, which registers a provider and (with `--model`) sets your default model in one command. For well-known providers, a **preset** fills in the protocol, base URL, and suggested secret automatically.

**OpenAI** — set your key, then add:

```bash
export OPENAI_API_KEY=sk-...
lapp provider add --id openai --model gpt-4o --yes
```

`lapp provider add` takes:
- `--id <id|preset>` — a name **you** pick (used to address this provider later), or a known preset id like `openai` / `anthropic` / `ollama` (`lapp presets` lists them all).
- `--protocol` / `--base-url` — how to talk to it. Required for custom providers; **omitted when a preset supplies them**.
- `--secret env://NAME` — read the key from an environment variable (recommended). A preset fills the conventional `env://<PROVIDER>_API_KEY` if you omit it. Plaintext also works but stays on disk.
- `--model` — register a model **and** make it the default in one step.
- `--yes` — apply the change (write commands show a plan first; use `--dry-run` to preview).

## 2 · Chat (every time)

```bash
lapp chat "Say hi in five words."          # uses the default model
lapp chat --stream "Count to ten"          # stream the reply
```

Pick a different target inline — `provider/model` as the first word:

```bash
lapp chat openai/gpt-4o-mini "Quick one."  # inline target
```

…or with flags (handy when the message itself contains a slash):

```bash
lapp chat "Compare A/B testing" --provider openai --model gpt-4o-mini
```

You can also **change the default** and then keep using the one-liner:

```bash
lapp default set --provider openai --model gpt-4o-mini --kind chat --yes
lapp chat "Now this uses gpt-4o-mini."
```

## 3 · Add a second provider

`lapp provider add` appends to an existing profile. Use `--force` if you instead want to reset the profile to just the new provider.

```bash
export ANTHROPIC_API_KEY=sk-ant-...
lapp provider add --id anthropic --model claude-sonnet-4 --yes
```

Now `lapp chat "Hi"` routes to the most recently relevant default, and `lapp chat openai/gpt-4o "Hi"` reaches OpenAI.

## 4 · Look around

```bash
lapp inspect              # human-readable summary (secrets redacted)
lapp validate             # structural + semantic checks
lapp doctor               # validate + can every enabled provider become a client?
lapp ping openai/gpt-4o   # 1-token test request
lapp presets              # list built-in provider presets
```

## Provider recipes

Two ways to add a provider — preset (one line) or fully explicit:

```bash
# Preset
lapp provider add --id openai --model gpt-4o --yes

# Fully explicit (custom/self-hosted)
lapp provider add --id my-proxy --protocol openai-chat-completions \
  --base-url https://my-proxy.example.com/v1 --secret env://MY_PROXY_KEY --yes
```

Common `--protocol` and `--base-url` values (for the explicit form):

| Provider | `--protocol` | `--base-url` | Auth |
|----------|--------------|--------------|------|
| OpenAI | `openai-chat-completions` | `https://api.openai.com/v1` | `env://OPENAI_API_KEY` |
| OpenAI Responses | `openai-responses` | `https://api.openai.com/v1` | `env://OPENAI_API_KEY` |
| Anthropic | `anthropic-messages` | `https://api.anthropic.com` | `env://ANTHROPIC_API_KEY` |
| DeepSeek | `openai-chat-completions` | `https://api.deepseek.com/v1` | `env://DEEPSEEK_API_KEY` |
| OpenRouter | `openai-chat-completions` | `https://openrouter.ai/api/v1` | `env://OPENROUTER_API_KEY` |
| Ollama (local) | `openai-chat-completions` | `http://localhost:11434/v1` | `--no-auth` |
| LM Studio (local) | `openai-chat-completions` | `http://localhost:1234/v1` | `--no-auth` |
| vLLM (local) | `openai-chat-completions` | `http://localhost:8000/v1` | `--no-auth` |

Notes:
- `lapp-js` never auto-appends `/v1` for OpenAI-compatible providers — include it in `--base-url` if your provider needs it. Don't end `--base-url` with `/`.
- Anthropic's adapter dedups a trailing `/v1` only when it is the sole last segment.
- For local servers, pass `--no-auth` to skip the auth header. Full walkthrough: [local-providers.md](local-providers.md).

### Pull the model list from the provider

For OpenAI-compatible providers, sync the model list from their `/models` endpoint:

```bash
lapp models sync --provider ollama                 # preview
lapp models sync --provider ollama --apply --yes   # write it in
lapp models sync --provider ollama --apply --set-default --yes   # write + set first chat model as default
```

Anthropic has no public model-list endpoint; set `provider.links.models` to point at one (see [protocols.md](protocols.md)).

## From TypeScript

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

// Target a specific provider/model
const cc = createLappClient({ profile, provider: "anthropic", model: "claude-sonnet-4", resolveSecrets: true });
```

`resolveSecrets: true` is required to actually call a provider — the SDK never reads `process.env` unless you opt in. See [sdk.md](sdk.md) for the full API.

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
