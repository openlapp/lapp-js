# SDK tour

`@openlapp/lapp` is the TypeScript SDK for LAPP. It reads, validates, writes, and manages `.lapp` profiles and sends requests directly to configured providers.

## Install

```bash
npm install @openlapp/lapp
```

Requires Node 18.18 or newer.

## Mental model

```text
.lapp profile
  -> @openlapp/lapp SDK
  -> protocol adapter
  -> provider API
```

The SDK is the product; the CLI is only its first consumer. All profile logic belongs in the SDK.

## Loading profiles

### `loadProfile(options?)`

Read and validate a `.lapp` tree. Resolution order: explicit `path` option → `LAPP_HOME` env var → `~/.lapp`.

```ts
import { loadProfile } from "@openlapp/lapp";

const profile = loadProfile();                          // default
const profile = loadProfile({ path: "/etc/lapp" });     // explicit
const profile = loadProfile({ skipValidate: true });    // parse-only
```

`loadProfile` returns a normalized `LappProfile`. Providers with `enabled: false` are kept so writes can round-trip the on-disk file. Models with no `models.json` produce `models: null`.

### `resolveLappRoot(explicit?)`

Resolve the root directory without loading the profile.

```ts
const root = resolveLappRoot();
```

### `inspectProfile(profile, { revealSecrets? })`

Human-friendly summary: redacted secrets, per-provider model list, diagnostics.

```ts
const summary = inspectProfile(profile);
```

`revealSecrets: true` is for trusted environments only.

### `validateProfile(profile)`

Run both JSON Schema (ajv) and semantic checks (duplicate aliases, global-ref existence, secret-scheme warnings, sensitive-header warnings). Returns `{ valid, diagnostics, errors, warnings, infos }`.

```ts
const result = validateProfile(profile);
```

## Managing profiles (pure, immutable)

All mutation functions return a new `LappProfile` and never touch disk.

| Function | Purpose |
|----------|---------|
| `createProfile(input)` | Empty in-memory profile (no disk write). |
| `upsertProvider(profile, input)` | Insert or update a provider; preserves unspecified fields. |
| `upsertModel(profile, input)` | Insert or update a model under a provider. |
| `removeProvider(profile, id)` | Remove a provider and any default references to it. |
| `removeModel(profile, { providerId, model })` | Remove by id or alias; clears any default that pointed at it. |
| `replaceProviderModels(profile, id, models)` | Replace the whole `models.json` for a provider (sync flow). |
| `setDefaultModelRef(profile, key, target)` | Set any default slot (`defaultModel`, `defaultEmbeddingModel`, ...). |
| `setDefaultModel(profile, target)` | Set `defaultModel` (chat slot) — convenience wrapper. |
| `isSupportedProtocol(protocol)` | True for the 3 v1 core protocols. |

Example:

```ts
let profile = createProfile({ rootDir: "~/.lapp" });
profile = upsertProvider(profile, {
  id: "openai",
  protocol: "openai-chat-completions",
  baseUrl: "https://api.openai.com/v1",
  auth: { secret: "env://OPENAI_API_KEY" },
});
profile = upsertModel(profile, {
  providerId: "openai",
  id: "gpt-4o",
  type: "chat",
  aliases: ["gpt4o"],
});
profile = setDefaultModel(profile, { providerId: "openai", model: "gpt-4o" });
```

## Planning and writing

### `planChanges(before, after)`

Compute a file-level create/modify/delete diff.

```ts
const plan = planChanges(before, after);
```

### `writeProfileAtomic(profile, { before? })`

Validate in memory, then write atomically:

1. Build complete content in memory.
2. Validate before writing.
3. Write to a hidden temporary file in the same directory as the target file.
4. Close the temporary file.
5. Rename it over the target path.
6. On failure, remove only the temporary file.

There is no backup, no rollback, and no temporary directory. Pass `options.before` so orphan `provider.json`/`models.json` files are unlinked after the write succeeds.

```ts
await writeProfileAtomic(profile, { before });
```

New files are written as `.json`. Existing `.jsonc` files are treated as `.json` write targets.

## Secrets

| Function | Purpose |
|----------|---------|
| `parseSecretRef(raw)` | Parse a `plaintext` / `env://NAME` / `keychain://` / `file://` string. |
| `redactSecret(raw)` | Redact a secret for safe display. |
| `resolveSecret(ref, { resolve, env })` | Returns the resolved value or an error. **Opt-in**; never reads `process.env` unless `resolve: true`. |

Supported in v1: `plaintext` and `env://`. `keychain://` and `file://` are parsed but throw `UnsupportedSecretSchemeError` at runtime.

```ts
const ref = parseSecretRef("env://OPENAI_API_KEY");
const value = resolveSecret(ref, { resolve: true });
```

See [security.md](security.md) for the full secret policy.

## Client

### `createLappClient(options)`

Resolve a target and return a client bound to the appropriate protocol adapter.

```ts
const client = createLappClient({
  profile,
  resolveSecrets: true,  // required to actually call a provider
  env: { OPENAI_API_KEY: "sk-..." },  // optional override
});
```

Target resolution priority:

1. Explicit `provider` / `model` options.
2. `global.defaultModel` (only if compatible).
3. First enabled provider's first enabled model.

Options:

- `provider`, `model` — explicit target
- `resolveSecrets` — opt-in to resolve secrets
- `allowUnauthenticated` — skip auth header for local/self-hosted providers
- `env` — environment overrides
- `fetchImpl` — custom `fetch` implementation

### Client methods

| Method | Returns | Notes |
|--------|---------|-------|
| `client.chat(input)` | `Promise<LappResponse>` | Non-streaming. Throws if `input.stream: true` (use `stream()`). |
| `client.rawChat(input)` | `Promise<unknown>` | Provider-native response. |
| `client.stream(input)` | `AsyncIterable<LappStreamEventUnion>` | `delta` / `tool-call` / `usage` / `finish` / `error`. |
| `client.executeWithTools(input, tools, handlers, options?)` | `Promise<{ text, turns, messages }>` | Multi-turn tool loop. |
| `client.testConnection()` | `Promise<TestConnectionResult>` | Sends a 1-token ping. |
| `client.providerId` / `client.model` / `client.protocol` | `string` | Resolved target. |

### `LappResponse`

```ts
{
  text: string;
  provider: string;
  model: string;
  protocol: string;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  finishReason?: string;
  toolCalls?: ParsedToolCall[];
  raw: unknown;  // the full provider response, untouched
}
```

### Streaming

```ts
for await (const ev of client.stream({ messages })) {
  if (ev.kind === "delta") process.stdout.write(ev.text);
  if (ev.kind === "tool-call") console.log("tool:", ev.name, ev.arguments);
  if (ev.kind === "usage") console.log("usage:", ev.inputTokens, ev.outputTokens);
  if (ev.kind === "finish") console.log("finish:", ev.reason);
  if (ev.kind === "error") console.error("error:", ev.message);
}
```

## Profile query

### `listModels(profile, options?)`

Flatten a profile into one record per model.

```ts
const models = listModels(profile, { providerId: "openai" });
// [{ providerId, modelId, protocol, baseUrl, type, capabilities, ... }, ...]
```

Options: `providerId`, `includeDisabled`, `includeDisabledModels`.

## Model sync

| Function | Purpose |
|----------|---------|
| `fetchProviderModels(profile, providerId, options?)` | Fetch the model list from a provider's `/models` endpoint. Throws `ModelSyncUnsupportedError` for Anthropic without `links.models`. |
| `buildModelSyncResult(before, fetched, protocol)` | Compute `{ models, added, removed, updated }` diff. |
| `syncProviderModels(profile, providerId, options?)` | Fetch + diff in one call. |
| `applySyncedModels(before, result)` | Merge into a `ModelsConfig`, preserving user-curated fields. Marks the result with `__lappUpdatedAtSource: "sync"` so the writer re-stamps `updatedAt`. |

## Env export

### `exportEnv(profile, { format, resolve?, allowPlaintext? })`

Emit shell statements for a profile's secrets.

```ts
const out = exportEnv(profile, { format: "bash", resolve: true, allowPlaintext: false });
```

`resolve: true` is required to read `process.env`; `allowPlaintext: true` is required to include plaintext secrets.

## Error types

| Error | When thrown |
|-------|-------------|
| `TargetResolutionError` | Provider/model not found, all providers disabled, no enabled models. |
| `UnsupportedProtocolError` | Provider's protocol is not one of the 3 v1 core protocols. |
| `MissingEnvSecretError` | `env://NAME` and `process.env[NAME]` is unset. |
| `UnsupportedSecretSchemeError` | `keychain://` or `file://` scheme (v1 limitation). |
| `ModelSyncUnsupportedError` | Sync flow for a protocol without a public model list. |
| `StreamingUnsupportedError` | The protocol adapter has no `parseStream`. |

## TypeScript definitions

`dist/index.d.ts` is the source of truth for types. For a symbol-by-symbol navigation index, see [packages/lapp/docs/api.md](../packages/lapp/docs/api.md).
