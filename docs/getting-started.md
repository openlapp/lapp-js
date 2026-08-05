# Getting started

LAPP lets AI applications share one local provider and model registry. The
application still sends requests directly to the selected upstream API.

The official SDK is recommended for application integrations so applications
do not have to reproduce credential and concurrency rules. Direct protocol
implementations and the native `lappx` CLI remain open, conforming paths:

1. Use `@openlapp/lapp` from TypeScript.
2. Read the JSON profile and implement the LAPP rules yourself.
3. Invoke [`lappx`](https://github.com/openlapp/lapp-manager/blob/main/docs/cli.md)
   and consume its stable JSON output.

## Install

```bash
npm install @openlapp/lapp
```

Node.js 18.18 or newer is required.

## Create a profile

The native `lappx` CLI is the quickest way to create the standard Provider file pair.
`global.json` is created when you set a default. Presets fill in known
endpoints, protocols, auth shape, and model-discovery URL.

```bash
export OPENAI_API_KEY=sk-...
lappx provider add --id openai --model gpt-4o-mini --env OPENAI_API_KEY --yes
lappx validate
lappx models list
```

For a custom upstream, provide the fields explicitly:

```bash
lappx provider add \
  --id custom \
  --base-url https://ai.example.com/v1 \
  --protocol openai-chat-completions \
  --env CUSTOM_AI_KEY \
  --models-protocol openai-models \
  --models-url https://ai.example.com/v1/models \
  --model chat-model \
  --yes
```

For an interactive raw-key flow, omit `--env`: the CLI prompts without echo and
stores the key as `vault://<provider>/default`. Non-interactive raw input uses
`--vault <credential-id> --stdin`. Use `--no-auth` for a loopback provider that
requires no credential. Write commands preview their file plan and require
`--yes`; `--dry-run` performs no profile or Vault write.

## Keep the local model directory current

`models.json` remains authoritative. Refresh is explicit and non-destructive:

```bash
lappx models refresh --provider openai                 # preview additions
lappx models refresh --provider openai --apply --yes   # write additions
```

Refresh preserves every existing model and local field. Set a default
separately:

```bash
lappx default set --task chat --provider openai --model gpt-4o-mini --yes
```

## Option 1: read the profile directly

Applications in any language may read `global.json`, `provider.json`, and
`models.json`. A conforming implementation must still enforce the schemas and
semantic rules: directory/ID equality, unique IDs and aliases, enabled state,
protocol selection, same-origin discovery, strict auth, secret-reference
grammar and canonical defaults. Implementations that do not provide a Vault
backend must still recognize `vault://` and fail explicitly only when a remote
operation needs that credential.

This route is useful when a TypeScript dependency or subprocess is undesirable.
See [Configuration](configuration.md) for the complete file contract.

## Option 2: use the TypeScript SDK

```ts
import {
  listModels,
  loadProfile,
  refreshModels,
  resolveConnection,
} from "@openlapp/lapp";

const profile = loadProfile();

const models = listModels(profile, { providerId: "openai" });

const connection = await resolveConnection(
  profile,
  { providerId: "openai", model: "gpt-4o-mini" },
  { supportedProtocols: ["openai-responses", "openai-chat-completions"] },
);

// connection contains the canonical model id, endpoint, headers and resolved auth.

const preview = await refreshModels(profile, "openai");
console.log(preview.added);
// Persist preview.nextProfile only after your application chooses to apply it.
```

`listModels()` is pure and performs no I/O or secret resolution.
`resolveConnection()` asynchronously resolves the selected credential.
`refreshModels()`
contacts exactly one configured discovery endpoint and returns a new in-memory
profile without writing disk.

The SDK also offers `createLappClient()` for direct chat calls:

```ts
import { createLappClient } from "@openlapp/lapp";

const client = createLappClient({ profile, default: "chat" });
const response = await client.chat({
  messages: [{ role: "user", content: "Hello" }],
});
console.log(response.text);
```

## Option 3: consume `lappx` JSON

```bash
lappx models list --json
lappx resolve --default chat --protocol openai-responses --json
```

Machine output is one document shaped as `{ "ok": true, "result": ... }`. The CLI
never emits a resolved credential; `resolve` reports its scheme and status, and
`credential status` checks a known Vault reference without revealing it. See
the [`lappx` CLI reference](https://github.com/openlapp/lapp-manager/blob/main/docs/cli.md)
for exit codes and the exact command surface.

## Next steps

- [SDK guide](sdk.md)
- [Configuration](configuration.md)
- [Security](security.md)
- [Protocols](protocols.md)
- [Local providers](local-providers.md)
- [Troubleshooting](troubleshooting.md)
