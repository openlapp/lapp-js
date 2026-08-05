# lapp-js

The official TypeScript SDK for **LAPP** (Local AI Provider Profiles).
LAPP is an open local provider-profile protocol: applications discover models
and connection details, then communicate with the upstream provider directly.

> **Languages:** [English](README.md) | [中文](README_zh.md)

```text
Recommended: app -> @openlapp/lapp -> upstream API
Direct:      app -> read ~/.lapp -> upstream API
```

Applications always communicate with upstream providers directly; there is no
daemon, gateway, proxy, or request-routing service. Official integrations
should prefer an SDK so applications do not need to handle credential storage
details, while direct protocol implementations remain conforming open
integration paths. The user-facing `lappx` CLI is maintained in the companion
Manager repository.

| Package | Purpose |
|---------|---------|
| [`@openlapp/lapp`](docs/sdk.md) | Load and manage profiles, list and refresh models, resolve credentials, and optionally call supported chat APIs. |

## Install

> The packages are currently distributed only through the machine-local beta
> Registry. The npmjs commands below become active with the first public
> `1.0.0` release. Contributors can use the [local beta Registry](dev/registry/README.md).

```bash
npm install @openlapp/lapp
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

## CLI

The legacy `@openlapp/cli` package and its `lapp` executable are removed. Use
the native [`lappx` CLI](https://github.com/openlapp/lapp-manager/blob/main/docs/cli.md)
for profile management, diagnostics, connection tests, and Work/Chat sessions.

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

## Manager status

There is not yet a stable supported GUI release. The standalone
[`openlapp/lapp-manager`](https://github.com/openlapp/lapp-manager) repository
now contains an Alpha implementation built with Tauri 2, Vue 3, TypeScript,
and Naive UI. It links the public Rust SDK in-process—never through a sidecar,
daemon, gateway, or proxy. Current source and tests are implementation
evidence; a signed, validated installer and a stable UI contract remain
release work.

The former `@openlapp/react` and `@openlapp/vue` packages remain removed. Their
reusable product, security, accessibility, and behavior contracts are
maintained as Manager documentation rather than restored as public framework
packages.

The [Electron bridge example](examples/electron-manager/README.md) is an
unsupported integration reference for the current Node manager host. It is not
a complete GUI or the basis of the standalone Manager.

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
- **[SDK guide](docs/sdk.md)** — discovery, resolution, refresh, and direct calls
- **[Manager](https://github.com/openlapp/lapp-manager)** — standalone Tauri/Vue/Naive UI Alpha source and contracts
- **[Local beta Registry](dev/registry/README.md)** — private Verdaccio publishing and clean installs
- [Configuration](docs/configuration.md) — v1 JSON profile contract
- [Security](docs/security.md) — trust boundary and credential handling
- [Protocols](docs/protocols.md) — protocol selection and model discovery
- [Local providers](docs/local-providers.md) — Ollama, LM Studio, and vLLM
- [Troubleshooting](docs/troubleshooting.md) — errors and common fixes
- [User agreement and risk disclosure](packages/lapp/USER_AGREEMENT.en.md) —
  distribution template included in the SDK package
- [API reference](packages/lapp/docs/api.md) · [CHANGELOG](CHANGELOG.md)

## v1 boundaries

- Secrets are plaintext, `env://NAME`, or `vault://provider/credential`.
  Official SDK writes default to the current user's system Vault; plaintext
  creation requires explicit opt-in.
- Remote model refresh is explicit, non-destructive, and not a background cache.
- LAPP does not protect credentials from another trusted process running as the
  same OS user after that process explicitly resolves a connection.
- Official Profile + Vault mutations share one current-user global writer lock;
  normal writers never steal it based on age, PID, or heartbeat.
- Successful SDK responses redact resolved credentials by default. Only an
  explicit `redactSuccessfulSecrets: false` preserves them; errors and
  diagnostics are always redacted.

## License

MIT
