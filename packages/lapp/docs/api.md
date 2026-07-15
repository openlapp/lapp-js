# @openlapp/lapp API reference

This page indexes the v1 package-root API. TypeScript declarations in
`dist/index.d.ts` are authoritative.

## Profile loading

### `loadProfile(options?) -> LappProfile`

Reads standard JSON from `{ path }`, `LAPP_HOME`, or `~/.lapp`, validates the
complete profile, and returns a normalized domain object. Throws
`ProfileValidationError` on any ERROR diagnostic.

```ts
const profile = loadProfile();
const explicit = loadProfile({ path: "/etc/lapp" });
```

### `inspectProfile(options?) -> ProfileInspection`

Reads as much as possible from the same location and returns redacted provider
summaries plus diagnostics. It is safe to call when `loadProfile()` fails and
has no secret-reveal option.

### `resolveLappRoot(explicit?) -> string`

Resolves a root path without loading it.

### `validateProfile(profile) -> ValidationResult`

Runs the packaged JSON Schemas and cross-file semantic validation. Returns
`{ valid, diagnostics, errors, warnings, infos }`.

## Query and connection resolution

### `listModels(profile, options?) -> ModelDescriptor[]`

Pure in-memory listing. Options are `{ providerId?, includeDisabled? }`.
Credentials are not resolved and no I/O occurs.

### `selectConnection(profile, selector, options?) -> ConnectionPlan`

Selectors are:

```ts
type ModelSelector =
  | { providerId: string; model: string }
  | { default: string };
```

Options are `{ supportedProtocols? }`. IDs and aliases normalize to a canonical
model ID; protocol selection preserves declared order. This function is
synchronous and pure: the returned `ConnectionPlan` contains the unresolved
`auth` configuration and credential binding, and it performs no credential or
network I/O.

```ts
const plan = selectConnection(
  profile,
  { providerId: "openai", model: "fast-chat" },
  { supportedProtocols: ["openai-responses"] },
);
```

### `resolveConnection(profile, selector, options?) -> Promise<ResolvedConnection>`

Options are `{ supportedProtocols?, env?, vault?, resolver? }`. The function
first selects the target, then asynchronously resolves plaintext,
`env://NAME`, or `vault://provider/credential` auth. A supplied `resolver`
takes precedence over `env` and `vault`; otherwise Vault is opened lazily only
when a Vault reference is encountered. The returned auth contains the usable
secret and must be treated as sensitive.

```ts
const connection = await resolveConnection(
  profile,
  { providerId: "openai", model: "fast-chat" },
  {
    supportedProtocols: ["openai-responses"],
    env: { OPENAI_API_KEY: process.env.OPENAI_API_KEY },
    vault: testVault,
  },
);
```

There is no fallback between credential schemes. A missing environment value,
Vault record, native backend, or matching binding fails before a connection is
returned.

## Credential resolution and Vault

### `openSystemCredentialVault() -> Promise<CredentialVault>`

Opens an adapter for the current OS user's native credential store. It never
creates a file, environment-variable, or plaintext fallback. A missing native
module fails this call; an unavailable system credential service may fail the
first operation. Both use `CredentialError` code
`VAULT_BACKEND_UNAVAILABLE`.

`CredentialVault` has these asynchronous operations:

| Method | Purpose |
|--------|---------|
| `put(reference, secret, binding, options?)` | Store a `VaultEnvelopeV1`; `{ overwrite: true }` is required to replace an existing record. |
| `resolve(reference, expectedBinding, options?)` | Validate the record and exact binding, then return the plaintext secret. |
| `status(reference, expectedBinding, options?)` | Return `{ reference, exists, bindingMatches? }` without revealing the secret. |
| `delete(reference, options?)` | Delete one record and report whether it existed. |

System records use service `dev.lapp.vault.v1` and account
`<providerId>/<credentialId>`. A binding contains the provider ID, normalized
exact origin (not the base URL path), and authentication type/name. Header
names are normalized to lowercase; query parameter names remain
case-sensitive.

### `createCredentialResolver(options?) -> CredentialResolver`

Options are `{ env?, vault? }`. The resolver exposes `resolve(raw, binding)`
and `status(raw, binding)`. It supports only plaintext, `env://NAME`, and
`vault://provider/credential`; unsupported schemes produce a typed error. The
system Vault is loaded lazily and no plaintext secret is cached by the
resolver.

## Model refresh

### `refreshModels(profile, providerId, options?) -> Promise<RefreshModelsResult>`

Options are `{ env?, vault?, resolver?, fetch?, signal? }`. Requests one
configured same-origin discovery endpoint, resolves credentials immediately
before use, rejects redirects, validates every response page, and returns:

```ts
{
  nextProfile: LappProfile;
  added: ModelDescriptor[];
  diagnostics: Diagnostic[];
}
```

The input and disk are unchanged. Existing model fields and order are
preserved; unknown IDs are sorted and appended, missing display names may be
filled, and no model is removed.

## Immutable profile management

| Export | Purpose |
|--------|---------|
| `createProfile({ rootDir })` | Create an empty in-memory profile. |
| `upsertProvider(profile, input)` | Add or patch a provider. New providers require `baseUrl`, `protocols`, and `auth`. |
| `upsertProviderWithCredential(profile, input, options?)` | Add or patch a provider while applying the SDK's credential-storage policy. |
| `upsertModel(profile, input)` | Add or patch a model under an existing provider. |
| `removeProvider(profile, id)` | Remove a provider unless a default references it. |
| `removeModel(profile, target)` | Remove by canonical ID or unique alias unless a default references it. |
| `setDefault(profile, task, target)` | Resolve the target and store its canonical IDs. |

Omitted fields in `upsertProvider` and `upsertModel` are preserved.

### `upsertProviderWithCredential(profile, input, options?) -> Promise<UpsertProviderWithCredentialResult>`

For authenticated providers, `input.auth.credential` accepts one of:

```ts
type CredentialInput =
  | { secret: string; storage?: "vault"; credentialId?: string; overwrite?: boolean }
  | { secret: string; storage: "plaintext" }
  | { storage: "env"; name: string };
```

Omitting `storage` writes the raw secret to the Vault under credential ID
`default` and puts only its `vault://` reference in the returned profile. The
binding is derived from the final provider configuration; callers cannot
supply a different origin. `{ storage: "plaintext" }` is the only way this API
writes a raw secret into the profile and returns a
`PLAINTEXT_SECRET_IN_USE` warning. `{ storage: "env" }` writes an `env://`
reference without reading the environment.

The function may write the Vault but never writes the profile to disk. The
return value is `{ profile, credentialRef?, warnings }`; persist `profile`
explicitly with `writeProfileAtomic()`.

### `planChanges(before, after) -> ChangePlan`

Returns a file-level `create`, `modify`, and `delete` preview.

### `writeProfileAtomic(profile, options?) -> Promise<void>`

Options are `{ path?, indent?, trailingNewline?, before? }`. Loaded and
SDK-created profiles retain their write location internally; `path` supplies it
for a manually constructed profile. The writer validates first, checks
path containment, and writes each changed JSON file through a same-directory
temporary file plus fsync and rename. `before` enables deletion of provider
files removed from the new profile.

## Direct-call client

### `createLappClient(options) -> LappClient`

```ts
const client = createLappClient({
  profile,
  provider: "openai",
  model: "gpt-4o-mini",
  vault,
  fetchImpl: customFetch,
  redactSuccessfulSecrets: true,
});
```

Use `provider` and `model` together, or `{ default: "chat" }`; omitting all
three also selects the `chat` default. The client supports the three core chat
protocols. The synchronous factory validates and selects the target without
resolving its credential. Every `chat`, `rawChat`, `stream`,
`executeWithTools`, and `testConnection` provider operation resolves the
credential again immediately before use, so a Vault rotation takes effect on
the next operation. Resolved plaintext is not cached by the client (a
plaintext secret explicitly present in the supplied profile remains in that
profile).

Set `redactSuccessfulSecrets: true` when successful provider content will be
written to a log or terminal. It scrubs the credential resolved for that
request from response objects and stream events. The CLI always enables this;
SDK callers may leave it disabled when exact upstream response preservation is
required.

Before auth is sent, the final request origin is checked again and redirects
are rejected.

| Method | Return |
|--------|--------|
| `chat(input)` | `Promise<LappResponse>` |
| `rawChat(input)` | `Promise<unknown>` |
| `stream(input)` | `AsyncIterable<LappStreamEventUnion>` |
| `executeWithTools(input, tools, handlers, options?)` | `Promise<ExecuteWithToolsResult>` |
| `testConnection()` | `Promise<TestConnectionResult>`; failures include a stable optional `code` when available. |

`ChatInput` contains `messages`, optional `temperature`, `maxTokens`, `extra`,
`stream`, `tools`, `toolChoice`, and `signal`. Reserved `extra` keys cannot
override the resolved target, conversation, streaming, tools, or auth.

## Public errors

| Error | Meaning |
|-------|---------|
| `ProfileValidationError` | The loaded or written profile is invalid. |
| `TargetResolutionError` | Provider/model/default/alias/enabled/protocol resolution failed. |
| `MissingEnvSecretError` | A selected `env://NAME` value is absent. |
| `CredentialError` | Credential reference, environment, Vault backend, record, binding, or update failed. Inspect its stable `code`, not its redacted message. |
| `ModelRefreshError` | Discovery configuration, HTTP, shape, or pagination failed. |
| `StreamingUnsupportedError` | The selected adapter cannot stream. |

## Public data types

The root exports the profile and runtime types used above, including
`AuthConfig`, `ProviderConfig`, `ModelsConfig`, `ModelEntry`, `GlobalConfig`,
`LappProfile`, `ModelDescriptor`, `ModelSelector`, `ResolvedConnection`,
`Diagnostic`, `ProfileInspection`, `ChangePlan`, chat/tool/stream types, and
their function option/result types.

`CredentialError.code` is one of:

```text
INVALID_SECRET_REFERENCE
UNSUPPORTED_SECRET_SCHEME
ENV_SECRET_MISSING
VAULT_BACKEND_UNAVAILABLE
VAULT_CREDENTIAL_NOT_FOUND
VAULT_CREDENTIAL_EXISTS
VAULT_RECORD_INVALID
VAULT_BINDING_MISMATCH
VAULT_ACCESS_DENIED
VAULT_OPERATION_FAILED
CREDENTIAL_UPDATE_PARTIAL_FAILURE
```

Native causes and credential values are deliberately omitted from public error
messages.

Parsing helpers, Schema test hooks, adapter internals, and discovery internals
are intentionally not package-root API.
