# SDK guide

`@openlapp/lapp` implements the LAPP v1 local registry for TypeScript. It can
load, validate, query, refresh, edit, and write profiles. Applications may use
the resolved connection with their own upstream library or use the bundled
direct-call client.

```bash
npm install @openlapp/lapp
```

Node.js 18.18 or newer is required.

## Load and inspect

```ts
import { inspectProfile, loadProfile } from "@openlapp/lapp";

const profile = loadProfile();
const other = loadProfile({ path: "/etc/lapp" });
const inspection = inspectProfile();
```

Resolution order is explicit `path`, `LAPP_HOME`, then `~/.lapp`.

`loadProfile()` returns only a validated, normalized `LappProfile`; invalid
input throws `ProfileValidationError`. It retains disabled entries and contains
no diagnostics or source-file metadata.

`inspectProfile({ path? })` is the recovery path for damaged profiles. It
returns partial provider information and redacted diagnostics without exposing
secret values.

Use `validateProfile(profile)` to validate an in-memory profile and
`resolveLappRoot(explicit?)` to resolve a root without loading it.

## List models

```ts
import { listModels } from "@openlapp/lapp";

const enabled = listModels(profile);
const openai = listModels(profile, { providerId: "openai" });
const all = listModels(profile, { includeDisabled: true });
```

`listModels()` is synchronous and pure: it performs no file/network I/O and
does not resolve credentials. Each `ModelDescriptor` contains provider/model
IDs, inherited or model-specific protocols, endpoint, enabled state, and local
descriptive metadata.

## Select and resolve a connection

Use the synchronous, pure selector when you need target metadata without
touching a credential:

```ts
import { resolveConnection, selectConnection } from "@openlapp/lapp";

const plan = selectConnection(
  profile,
  { providerId: "openai", model: "fast-chat" }, // ID or alias
  { supportedProtocols: ["openai-responses", "openai-chat-completions"] },
);

const selected = selectConnection(profile, { default: "chat" });
```

`selectConnection()` returns a `ConnectionPlan` with unresolved `auth` and its
credential binding. It performs no file, environment, Vault, or network I/O.

When a trusted caller needs usable auth, resolve asynchronously:

```ts
const explicit = await resolveConnection(
  profile,
  { providerId: "openai", model: "fast-chat" },
  {
    env: { OPENAI_API_KEY: process.env.OPENAI_API_KEY },
    vault: testVault,
  },
);

const resolvedDefault = await resolveConnection(profile, { default: "chat" });
```

The result contains:

```ts
{
  providerId: string;
  modelId: string;             // canonical ID
  protocol: string;
  baseUrl: string;
  requestHeaders: Record<string, string>;
  auth:
    | { type: "none" }
    | { type: "bearer"; secret: string }
    | { type: "header"; name: string; secret: string }
    | { type: "query"; name: string; secret: string };
}
```

Options are `{ supportedProtocols?, env?, vault?, resolver? }`. Pass `env` to
use an explicit source instead of `process.env`, `vault` to inject a
`CredentialVault`, or `resolver` to replace both. A custom resolver takes
precedence. The system Vault is opened lazily only for `vault://` references.

The credential is resolved in memory, and the returned connection must be
treated as sensitive. Disabled or ambiguous targets, missing defaults or
credentials, unavailable Vault backends, binding mismatches, and protocol
mismatches throw typed errors. Credential schemes never fall back to one
another.

## Use the credential Vault

```ts
import {
  createCredentialResolver,
  openSystemCredentialVault,
} from "@openlapp/lapp";

const vault = await openSystemCredentialVault();
const resolver = createCredentialResolver({ vault });
```

`openSystemCredentialVault()` opens an adapter for the current OS user's native
credential store. It does not create an encrypted file and never falls back to
an environment variable or plaintext. A missing native binary fails this call;
an unavailable credential service may fail the first operation. Both use
`CredentialError` code `VAULT_BACKEND_UNAVAILABLE`.

Vault references have the exact form
`vault://<providerId>/<credentialId>`. System records use service
`dev.lapp.vault.v1` and account `<providerId>/<credentialId>`.

`CredentialVault` exposes:

```ts
await vault.put(reference, secret, binding, { overwrite: false });
const secret = await vault.resolve(reference, binding);
const status = await vault.status(reference, binding);
const deleted = await vault.delete(reference);
```

The stored envelope is bound to the Provider ID, normalized exact origin (not
the base URL path), and authentication type/name. Header names are normalized
to lowercase; query parameter names remain case-sensitive. If any bound field
changes, resolution fails with `VAULT_BINDING_MISMATCH`; record the credential
again instead of silently rebinding it.

`createCredentialResolver({ env?, vault? })` handles plaintext,
`env://NAME`, and `vault://provider/credential`. Its `resolve(raw, binding)`
returns the usable secret, while `status(raw, binding)` reports scheme,
availability, and (for existing Vault records) binding state without revealing
the secret. It opens the system Vault lazily and does not cache plaintext.

Vault protects credentials at rest. It is not an application sandbox: a
compatible application running as the same OS user can receive the plaintext
secret after successful resolution.

## Refresh models

```ts
import { refreshModels, writeProfileAtomic } from "@openlapp/lapp";

const abortController = new AbortController();
const result = await refreshModels(profile, "openai", {
  env: { OPENAI_API_KEY: process.env.OPENAI_API_KEY },
  vault,
  signal: abortController.signal,
});

console.log(result.added, result.diagnostics);
await writeProfileAtomic(result.nextProfile, { before: profile });
```

`refreshModels()` contacts one provider's configured discovery URL and returns
`{ nextProfile, added, diagnostics }`. It never writes disk. The merge only
fills missing display names and appends unknown IDs in sorted order; it never
overwrites or removes existing models. Invalid HTTP/JSON/pagination throws
`ModelRefreshError` and leaves the input untouched.

Credential options are `{ env?, vault?, resolver? }`, with the same precedence
and no-fallback rules as `resolveConnection()`. Tests may inject
`options.fetch`. `options.signal` reaches every discovery request.
Credential-bearing requests reject redirects.

## Manage and write profiles

Management functions are immutable:

| Function | Purpose |
|----------|---------|
| `createProfile({ rootDir })` | Create an empty in-memory profile. |
| `upsertProvider(profile, input)` | Add or patch a provider; omitted fields are preserved. |
| `upsertProviderWithCredential(profile, input, options?)` | Add or patch a Provider and apply the SDK's credential-storage default. |
| `upsertModel(profile, input)` | Add or patch a model; omitted fields are preserved. |
| `removeProvider(profile, id)` | Remove an unreferenced provider. |
| `removeModel(profile, target)` | Remove an unreferenced model by ID or alias. |
| `setDefault(profile, task, target)` | Store a canonical task default. |

Use `planChanges(before, after)` for a file-level preview and
`writeProfileAtomic(after, { before })` to validate and persist standard JSON.
Writes reject path escape and invalid profiles. v1 assumes one writer.

For new raw credentials, use the asynchronous managed writer:

```ts
import { upsertProviderWithCredential } from "@openlapp/lapp";

const result = await upsertProviderWithCredential(profile, {
  id: "openai",
  baseUrl: "https://api.openai.com/v1",
  protocols: ["openai-responses"],
  auth: {
    type: "bearer",
    credential: { secret: userInput },
  },
  models: [],
}, { vault });

// Vault is updated, but disk is not.
await writeProfileAtomic(result.profile, { before: profile });
```

Omitting `credential.storage` selects Vault storage and credential ID
`default`. The SDK derives the binding from the final Provider configuration;
the caller cannot supply an origin. Set `{ storage: "env", name: "NAME" }` to
write an `env://NAME` reference without reading it. Set
`{ secret, storage: "plaintext" }` only as an explicit opt-in; the result then
contains a `PLAINTEXT_SECRET_IN_USE` warning.

`upsertProviderWithCredential()` returns
`{ profile, credentialRef?, warnings }` and never writes the Profile to disk.
The lower-level synchronous `upsertProvider()` remains available for callers
that already have an `AuthConfig`; it does not manage or resolve credentials.

## Direct-call client

```ts
import { createLappClient } from "@openlapp/lapp";

const client = createLappClient({
  profile,
  provider: "openai",
  model: "gpt-4o-mini",
  vault,
  // Enable when provider content is written to a terminal or log.
  redactSuccessfulSecrets: true,
});

const response = await client.chat({
  messages: [{ role: "user", content: "Hello" }],
  maxTokens: 200,
});
```

Supply `provider` and `model` together, or omit both and use `default` (`chat`
by default). The factory synchronously selects and validates the target, but it
does not resolve credentials. Every provider operation resolves the current
credential immediately before use; the client does not cache the resolved
plaintext. A Vault rotation therefore takes effect on the next operation.
Immediately before sending auth, the client verifies the final request origin
again and uses `redirect: "error"`.

The CLI always enables `redactSuccessfulSecrets` so a provider that echoes a
Vault credential cannot place it on stdout. SDK callers can enable the same
behavior; it is opt-in because it changes successful response content when the
content literally contains the credential.

Client methods:

| Method | Result |
|--------|--------|
| `chat(input)` | Normalized `LappResponse`. |
| `rawChat(input)` | Provider-native response. |
| `stream(input)` | Async `delta`, `tool-call`, `usage`, `finish`, and `error` events. |
| `executeWithTools(input, tools, handlers, options?)` | Complete tool-loop text, turn count, and transcript. |
| `testConnection()` | Small direct request result. |

`ChatInput.extra` may add provider-native fields, but cannot override target,
messages/input, stream, tools, or authentication fields. `AbortSignal` is
forwarded to the request. Tool arguments must parse as an object and satisfy
the tool JSON Schema before a handler executes.

## Errors

Public typed errors are `ProfileValidationError`, `TargetResolutionError`,
`CredentialError`, `MissingEnvSecretError`, `ModelRefreshError`, and
`StreamingUnsupportedError`. No protocol intersection uses
`TargetResolutionError.code === "PROTOCOL_NOT_SUPPORTED"`.

Use the stable `CredentialError.code` rather than matching its redacted
message:

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

Native causes and credential values are never exposed in these public errors.

For the complete export index, see the [API reference](../packages/lapp/docs/api.md).
