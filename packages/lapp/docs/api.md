# @openlapp/lapp API Reference (v1.0.0)

This is a quick tour of the v1 public API. TypeScript definitions in
`dist/index.d.ts` are the source of truth; this document is a navigation
index and examples guide.

## Loading profiles

### `loadProfile(options?) → LappProfile`

Read and validate a `.lapp` tree. Resolution order: explicit `path` option →
`LAPP_HOME` env var → `~/.lapp`.

```ts
import { loadProfile } from "@openlapp/lapp";

const profile = loadProfile();                          // default
const profile = loadProfile({ path: "/etc/lapp" });     // explicit
const profile = loadProfile({ skipValidate: true });    // parse-only
```

`LappProfile` is normalized: providers with `enabled: false` are kept (for
round-tripping), models with no `models.json` produce `models: null`.

### `inspectProfile(profile, { revealSecrets? }) → ProfileSummary`

Human-friendly view: redacted secrets, per-provider model list, diagnostics.

```ts
const summary = inspectProfile(profile);
// summary.providers[].protocol, .baseUrl, .models, .secret (redacted)
```

`revealSecrets: true` is for trusted paths only.

### `validateProfile(profile) → ValidationResult`

Runs both JSON-schema (ajv) and semantic checks (alias dup, global ref
existence, secret-scheme warnings, sensitive-header warnings). Returns
`{ valid, diagnostics, errors, warnings, infos }`.

### `resolveLappRoot(explicit?) → string`

Resolve the root directory without loading any profile.

## Profile management (pure, immutable)

| Function | Purpose |
| --- | --- |
| `createProfile(input)` | Empty in-memory profile (no disk write). |
| `upsertProvider(profile, input)` | Insert or update a provider; preserves unspecified fields. |
| `upsertModel(profile, input)` | Insert or update a model under a provider. |
| `removeProvider(profile, id)` | Remove a provider and any default references to it. |
| `removeModel(profile, { providerId, model })` | Remove by id or alias; clears any default that pointed at it. |
| `replaceProviderModels(profile, id, models)` | Replace the whole `models.json` for a provider (sync flow). |
| `setDefaultModelRef(profile, key, target)` | Set any default slot (`defaultModel`, `defaultEmbeddingModel`, ...). |
| `setDefaultModel(profile, target)` | Set `defaultModel` (chat slot) — convenience wrapper. |
| `isSupportedProtocol(protocol)` | True for the 3 v1 core protocols. |
| `planChanges(before, after)` | File-level create/modify/delete diff. |
| `writeProfileAtomic(profile, { before? })` | Validate → write temp → fsync → rename; unlink orphans. |

## Secrets

| Function | Purpose |
| --- | --- |
| `parseSecretRef(raw)` | Parse a `plaintext` / `env://NAME` / `keychain://` / `file://` string. |
| `redactSecret(raw)` | Redact a secret for safe display. |
| `resolveSecret(ref, { resolve, env })` | Returns the resolved value or an error. **Opt-in**; never reads `process.env` unless `resolve: true`. |

Supported in v1: `plaintext` and `env://`. `keychain://` and `file://` are
parsed but throw `UnsupportedSecretSchemeError` at runtime.

## Client

### `createLappClient({ profile, provider?, model?, resolveSecrets?, allowUnauthenticated?, env?, fetchImpl? }) → LappClient`

Resolve a target and return a client bound to the appropriate protocol
adapter.

```ts
const client = createLappClient({
  profile,
  resolveSecrets: true,  // required to actually call a provider
  env: { OPENAI_API_KEY: "sk-..." },  // optional override
});
const resp = await client.chat({ messages });
```

Target resolution priority: explicit `provider`/`model` → `global.defaultModel`
(only if compatible) → first enabled provider's first enabled model.

**Client methods:**

| Method | Returns | Notes |
| --- | --- | --- |
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
  usage?: { inputTokens?, outputTokens?, totalTokens? };
  finishReason?: string;
  toolCalls?: ParsedToolCall[];
  raw: unknown;  // the full provider response, untouched
}
```

## Profile query

### `listModels(profile, options?) → FlatModelEntry[]`

Flatten a profile into one record per model.

```ts
const models = listModels(profile, { providerId: "openai" });
// [{ providerId, modelId, protocol, baseUrl, type, capabilities, ... }, ...]
```

Options: `providerId`, `includeDisabled`, `includeDisabledModels`.

## Model sync

| Function | Purpose |
| --- | --- |
| `fetchProviderModels(profile, providerId, options?)` | Fetch the model list from a provider's `/models` endpoint. Throws `ModelSyncUnsupportedError` for Anthropic without `links.models`. |
| `buildModelSyncResult(before, fetched, protocol)` | Compute `{ models, added, removed, updated }` diff. |
| `syncProviderModels(profile, providerId, options?)` | Fetch + diff in one call. |
| `applySyncedModels(before, result)` | Merge into a `ModelsConfig`, preserving user-curated fields. Marks result with `__lappUpdatedAtSource: "sync"` so the writer re-stamps `updatedAt`. |

## env-export

### `exportEnv(profile, { format, resolve?, allowPlaintext? }) → string`

Emit shell statements (bash/zsh/fish/powershell/cmd) for a profile's
plaintext + env-scheme secrets. `resolve: true` is required to read
`process.env`; `allowPlaintext: true` is required to include plaintext
secrets (without it, plaintext entries are omitted).

```ts
const out = exportEnv(profile, { format: "bash", resolve: true, allowPlaintext: false });
```

## Error types

| Error | When thrown |
| --- | --- |
| `TargetResolutionError` | Provider/model not found, all providers disabled, no enabled models. |
| `UnsupportedProtocolError` | Provider's protocol is not one of the 3 v1 core protocols. |
| `MissingEnvSecretError` | `env://NAME` and `process.env[NAME]` is unset. |
| `UnsupportedSecretSchemeError` | `keychain://` or `file://` scheme (v1 limitation). |
| `ModelSyncUnsupportedError` | Sync flow for a protocol without a public model list. |
| `StreamingUnsupportedError` | The protocol adapter has no `parseStream`. |
