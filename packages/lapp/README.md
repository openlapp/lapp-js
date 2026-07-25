# @openlapp/lapp

> `0.x` builds are internal betas served only by the loopback OpenLAPP
> Registry. Configure the local `@openlapp` scope before using the install
> command below. Public npmjs installation starts with `1.0.0`.

TypeScript SDK for [LAPP](https://github.com/openlapp/lapp), a local AI
provider and model registry. Load connection details and credentials, then call
the upstream provider directly.

The package does not run a server or route traffic for other applications.

## Install

```bash
npm install @openlapp/lapp
```

Node.js 18.18 or newer is required. ESM and CommonJS entry points are included.

## Discover and resolve

```ts
import {
  listModels,
  loadProfile,
  resolveConnection,
  selectConnection,
} from "@openlapp/lapp";

const profile = loadProfile();
const models = listModels(profile);
const plan = selectConnection(profile, { default: "chat" });
const connection = await resolveConnection(
  profile,
  { default: "chat" },
  { supportedProtocols: ["openai-responses", "openai-chat-completions"] },
);
```

`listModels()` and `selectConnection()` are synchronous pure operations and do
not resolve credentials. `resolveConnection()` is asynchronous and returns the
canonical model ID, selected protocol, endpoint, headers, and resolved auth for
a trusted caller. It accepts injected `env`, `vault`, or `resolver` options;
credential schemes never fall back to one another.

The official planner defaults new raw credentials to a pending write for the
current user's system Vault and places a `vault://provider/credential`
reference in the profile. Plaintext remains an explicit warned option;
`env://NAME` remains available for externally managed secrets.

```ts
import { prepareProviderUpdate } from "@openlapp/lapp";

const result = prepareProviderUpdate(profile, {
  id: "openai",
  baseUrl: "https://api.openai.com/v1",
  protocols: ["openai-responses"],
  auth: { type: "bearer", credential: { secret: userInput } },
});
```

The call is side-effect free and may return `vaultWrite`. Pass the prepared
profile, optional Vault write, and stable-read revision to
`commitProfileTransaction()` so one current-user global lock covers CAS,
Profile persistence, Vault mutation, and rollback. `writeProfileAtomic()` and
`openSystemCredentialVault()` remain low-level single-store primitives.

## Refresh the local model directory

```ts
import { refreshModels } from "@openlapp/lapp";

const result = await refreshModels(profile, "openai");
```

Refresh is explicit and does not write by itself. It only appends new remote
IDs and may fill missing display names; it never removes or overwrites existing
local models.
Commit `result.nextProfile` with `commitProfileTransaction()` and the revision
from the stable read; do not write the multi-file Profile outside the global
writer lock.

## Optional direct-call client

```ts
import { createLappClient } from "@openlapp/lapp";

const client = createLappClient({ profile, default: "chat" });
const response = await client.chat({
  messages: [{ role: "user", content: "Hello" }],
});
console.log(response.text);
```

The factory is synchronous and does not resolve credentials. Each provider
operation resolves again immediately before use, so Vault rotation is visible
on the next operation and resolved plaintext is not cached by the client.
Successful responses redact the resolved credential by default. Exact upstream
success preservation requires explicit `redactSuccessfulSecrets: false`;
errors and diagnostics are always redacted.

The bundled client supports `openai-chat-completions`, `openai-responses`, and
`anthropic-messages`, including streaming and tool calls. Other protocol IDs
remain available through `resolveConnection()` for applications that implement
them.

Separate media factories provide generic `openai-images` image generation and
`openai-audio-speech` synthesis/streaming. Video and music public types are
present, but LAPP 1.0 intentionally bundles no wire adapter for them and returns
`PROTOCOL_NOT_SUPPORTED` before network access. Media routing ignores the
optional `providerType` metadata.

## Documentation

- [SDK guide](https://github.com/openlapp/lapp-js/blob/main/docs/sdk.md)
- [API reference](https://github.com/openlapp/lapp-js/blob/main/packages/lapp/docs/api.md)
- [Configuration](https://github.com/openlapp/lapp-js/blob/main/docs/configuration.md)
- [Security](https://github.com/openlapp/lapp-js/blob/main/docs/security.md)
- [Protocol](./spec.en.md) · [协议](./spec.zh-CN.md)
- [User agreement](./USER_AGREEMENT.en.md) · [用户协议](./USER_AGREEMENT.zh-CN.md)
- [中文文档](https://github.com/openlapp/lapp-js/blob/main/README_zh.md)

TypeScript declarations in `dist/index.d.ts` are the final API source of truth.

## License

MIT
