# lapp-js

The TypeScript SDK and CLI for **LAPP** (Local AI Provider Profiles). LAPP is a
local provider registry: applications discover models and connection details,
then communicate with the upstream provider directly.

> **Languages:** [English](README.md) | [中文](README_zh.md)

```text
Direct: app -> read ~/.lapp -> upstream API
SDK:    app -> @openlapp/lapp -> upstream API
CLI:    app -> lapp JSON output -> upstream API
```

Applications always communicate with upstream providers directly; no
background service or request-routing component is required.

| Package | Purpose |
|---------|---------|
| [`@openlapp/lapp`](docs/sdk.md) | Load and manage profiles, list and refresh models, resolve credentials, and optionally call supported chat APIs. |
| [`@openlapp/cli`](docs/cli.md) | Thin command-line wrapper with stable JSON output. |

## Install

```bash
npm install @openlapp/lapp
npm install -g @openlapp/cli
```

Node.js 18.18 or newer is required.

## Profile

LAPP v1 uses standard JSON and three file types:

```text
~/.lapp/
├── global.json
└── providers/
    └── openai/
        ├── provider.json
        └── models.json
```

`models.json` is the local authoritative model list. Remote discovery happens
only when explicitly requested and only appends newly discovered models; it
never removes models or overwrites existing local fields.

See [Configuration](docs/configuration.md) for the complete contract.

## CLI quick start

```bash
export OPENAI_API_KEY=sk-...
lapp provider add --id openai --model gpt-4o-mini --env OPENAI_API_KEY --yes
lapp default set --task chat --provider openai --model gpt-4o-mini --yes
lapp models list --json
lapp resolve --default chat --json
lapp chat "Hello" --default chat
```

Refresh a configured remote model directory explicitly:

```bash
lapp models refresh --provider openai                 # preview
lapp models refresh --provider openai --apply --yes   # append new models
```

Resolved credentials are never printed. For a newly entered raw key, the
interactive CLI uses the current user's Vault by default; `--env NAME` keeps an
externally managed environment reference instead.

## SDK quick start

```ts
import {
  createLappClient,
  listModels,
  loadProfile,
  resolveConnection,
} from "@openlapp/lapp";

const profile = loadProfile();
const models = listModels(profile);

const connection = await resolveConnection(
  profile,
  { default: "chat" },
  { supportedProtocols: ["openai-responses", "openai-chat-completions"] },
);

// Use connection with your own upstream client, or use the convenience client:
const client = createLappClient({ profile, default: "chat" });
const response = await client.chat({
  messages: [{ role: "user", content: "Hello" }],
});

console.log(models.length, connection.modelId, response.text);
```

`resolveConnection` asynchronously resolves plaintext, `env://NAME`, or
`vault://provider/credential` at call time and returns the selected protocol,
canonical model ID, endpoint, headers, and authentication. The client resolves
again immediately before each direct request, so Vault rotation is picked up
without rebuilding the client.

## Supported protocols

| Connection protocol | Direct chat client | Model discovery |
|---------------------|--------------------|-----------------|
| `openai-chat-completions` | Chat, stream, tools | `openai-models` |
| `openai-responses` | Chat, stream, tools | `openai-models` |
| `anthropic-messages` | Chat, stream, tools | `anthropic-models` |

Profiles may contain other protocol IDs for applications that implement them.
The bundled chat client returns `TargetResolutionError` with code
`PROTOCOL_NOT_SUPPORTED` instead of guessing how to call them.

## Documentation

- **[Getting started](docs/getting-started.md)** — the three consumption paths
- **[CLI reference](docs/cli.md)** — commands, JSON output, and exit codes
- **[SDK guide](docs/sdk.md)** — discovery, resolution, refresh, and direct calls
- [Configuration](docs/configuration.md) — v1 JSON profile contract
- [Security](docs/security.md) — trust boundary and credential handling
- [Protocols](docs/protocols.md) — protocol selection and model discovery
- [Local providers](docs/local-providers.md) — Ollama, LM Studio, and vLLM
- [Troubleshooting](docs/troubleshooting.md) — errors and common fixes
- [User agreement and risk disclosure](packages/lapp/USER_AGREEMENT.en.md) —
  distribution template included in both packages
- [API reference](packages/lapp/docs/api.md) · [CHANGELOG](CHANGELOG.md)

## v1 boundaries

- Secrets are plaintext, `env://NAME`, or `vault://provider/credential`.
  Official SDK writes default to the current user's system Vault; plaintext
  creation requires explicit opt-in.
- Remote model refresh is explicit, non-destructive, and not a background cache.
- LAPP does not protect credentials from another trusted process running as the
  same OS user after that process explicitly resolves a connection.

## License

MIT
