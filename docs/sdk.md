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
import { refreshModels } from "@openlapp/lapp";

const abortController = new AbortController();
const result = await refreshModels(profile, "openai", {
  env: { OPENAI_API_KEY: process.env.OPENAI_API_KEY },
  vault,
  signal: abortController.signal,
});

console.log(result.added, result.diagnostics);
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
Commit `result.nextProfile` with the stable-read revision through
`commitProfileTransaction()` as shown below.

## Manage and write profiles

Management functions are immutable:

| Function | Purpose |
|----------|---------|
| `createProfile({ rootDir })` | Create an empty in-memory profile. |
| `upsertProvider(profile, input)` | Add or patch a provider; omitted fields are preserved. |
| `prepareProviderUpdate(profile, input)` | Purely prepare a Provider and optional pending Vault write using the SDK's credential-storage default. |
| `upsertModel(profile, input)` | Add or patch a model; omitted fields are preserved. |
| `removeProvider(profile, id)` | Remove an unreferenced provider. |
| `removeModel(profile, target)` | Remove an unreferenced model by ID or alias. |
| `setDefault(profile, task, target)` | Store a canonical task default. |

Use `planChanges(before, after)` for a file-level preview. The exported
`writeProfileAtomic(after, { before })` primitive validates and persists
standard JSON, but does not acquire the global lock or perform CAS by itself;
specialized integrations must provide both. Official Profile-only, Vault-only,
and combined mutations use
`commitProfileTransaction()`, which holds the current-user global writer lock,
requires an expected revision, rechecks it before the first side effect, and
coordinates rollback. A zero-provider write still creates the required
`providers/` directory. Removing a provider is rejected before mutation if its
directory contains unmanaged entries; content introduced during the commit
causes rollback rather than a successful partial removal.

For new raw credentials, prepare and commit one locked transaction:

```ts
import {
  commitProfileTransaction,
  loadProfile,
  prepareProviderUpdate,
  readStable,
  resolveLappRoot,
} from "@openlapp/lapp";

const root = resolveLappRoot();
const current = readStable(root, () => loadProfile({ path: root }));
const prepared = prepareProviderUpdate(current.value, {
  id: "openai",
  baseUrl: "https://api.openai.com/v1",
  protocols: ["openai-responses"],
  auth: {
    type: "bearer",
    credential: { secret: userInput },
  },
  models: [],
});

await commitProfileTransaction({
  rootDir: root,
  before: current.value,
  next: prepared.profile,
  expectedRevision: current.revision,
  ...(prepared.vaultWrite ? { vaultWrite: prepared.vaultWrite } : {}),
});
```

Omitting `credential.storage` selects Vault storage and credential ID
`default`. The SDK derives the binding from the final Provider configuration;
the caller cannot supply an origin. Set `{ storage: "env", name: "NAME" }` to
write an `env://NAME` reference without reading it. Set
`{ secret, storage: "plaintext" }` only as an explicit opt-in; the result then
contains a `PLAINTEXT_SECRET_IN_USE` warning.

`prepareProviderUpdate()` returns
`{ profile, credentialRef?, vaultWrite?, warnings }` and has no side effects.
`commitProfileTransaction()` applies the optional Vault write and Profile under
one global lock with CAS and rollback.
The lower-level synchronous `upsertProvider()` remains available for callers
that already have an `AuthConfig`; it does not manage or resolve credentials.

## Desktop manager host

Node embedding applications may keep profile, Vault, and provider-test
authority in a trusted process. Import the historical host bridge from its
explicit Node-only subpath:

```ts
import { createNodeLappManagerHost } from "@openlapp/lapp/manager-host";

const host = createNodeLappManagerHost({
  path: process.env.LAPP_HOME,
});
```

Renderer and preload code should import only types and the protocol version
from the browser-safe contract subpath:

```ts
import type { LappManagerBridgeV1 } from "@openlapp/lapp/manager-contract";
```

`LappManagerBridgeV1` exposes five narrow capabilities: `handshake()`,
`getSnapshot()`, `transact()`, `testConnection()`, and optional `subscribe()`.
Snapshots contain an opaque revision and sanitized profile/credential status;
they never contain plaintext credentials. Mutations are semantic
`ManagerOperation` values sent with the expected revision. The Node host
serializes transactions, coordinates official writers with the current-user
global cross-process lock, and rechecks revision before mutation. Its opaque
revision combines the canonical Profile revision with a manager-owned Vault
generation, so a Vault-only rotation invalidates older snapshots even when no
Profile bytes change. The host restores a Vault record when a later Profile
commit fails.

The bridge has no credential get, resolve, export, or rebind operation. Binding
mismatches require saving the intended provider configuration and entering the
credential again. Do not expose the lower-level `CredentialVault`, filesystem,
network, transaction-helper, or generic IPC APIs to a renderer.

`commitProfileTransaction()`, `computeProfileRevision()`, `readProfileStable()`, `readStable()`,
`withWriterLock()`, `inspectWriterLock()`, and `repairWriterLock()` are public
SDK primitives for official writer integrations such as the CLI. The lock is
shared by every `LAPP_HOME` of the current OS user through `LAPP_STATE_HOME`;
normal writers never steal it based on age, PID, or heartbeat. Repair is an
explicit operator action using the exact observed owner token. See the
[API reference](../packages/lapp/docs/api.md).

There is not yet a stable supported GUI release. The standalone
[`openlapp/lapp-manager`](https://github.com/openlapp/lapp-manager) repository
contains the current Tauri/Vue/Naive UI Alpha implementation and its contracts.
The Electron example is an unsupported Node-host integration reference, not a
complete GUI or the basis of the standalone Manager.

## Direct-call client

```ts
import { createLappClient } from "@openlapp/lapp";

const client = createLappClient({
  profile,
  provider: "openai",
  model: "gpt-4o-mini",
  vault,
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

`redactSuccessfulSecrets` defaults to `true`, so a provider that echoes a
resolved credential cannot place it in successful response objects or stream
events. Set it explicitly to `false` only when exact upstream response
preservation is required. Errors, logs, and diagnostics are always redacted.

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

## Media generation clients

The root package also exports four separate factories:
`createImageGenerationClient`, `createVideoGenerationClient`,
`createSpeechSynthesisClient`, and `createMusicGenerationClient`. Image and
speech use the generic `openai-images` and `openai-audio-speech` wires. Video
and music expose the stable input, job, wait, stream, output-part, and error
types, but LAPP 1.0 bundles no wire adapter for them; construction therefore
fails with `PROTOCOL_NOT_SUPPORTED` before credentials or network access.

```ts
const image = createImageGenerationClient({ profile });
const result = await image.generate({
  prompt: "A small red circle",
  count: 1,
  size: { width: 1024, height: 1024 },
  outputFormat: "png",
});

const speech = createSpeechSynthesisClient({ profile });
for await (const event of speech.stream({ text: "Hello", voice: "alloy" })) {
  if (event.kind === "audio") consume(event.bytes);
}
```

Each factory selects the first supported protocol in the declared model or
provider order. It never reads `providerType`, guesses a provider from IDs or
URLs, probes the server, or silently changes wire protocols. `extra` is
adapter-allowlisted and cannot replace reserved fields. URL artifacts are not
downloaded automatically; call `downloadArtifact(artifact, { maxBytes })`.
Provider auth is attached only to same-origin artifact URLs, with redirects
rejected. `wait()` defaults to a 2-second interval and a 30-minute deadline;
local timeout or abort does not claim remote cancellation.

## Errors

Public typed errors also include `ProfileLockedError`,
`ProfileLockInvalidError`, `ProfileReadUnstableError`,
`ProfileRevisionConflictError`, `ProfilePathInvalidError`, and
`ProfileUpdatePartialFailureError`, alongside `ProfileValidationError`,
`TargetResolutionError`, `CredentialError`, `MissingEnvSecretError`,
`ModelRefreshError`, and `StreamingUnsupportedError`. No protocol intersection uses
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
After a combined transaction has mutated Vault, any incomplete Profile
rollback or Vault restoration uses the top-level credential code. When Profile
rollback is incomplete, stable `causes` also contains
`PROFILE_UPDATE_PARTIAL_FAILURE`; if both restoration classes fail, the
credential code still deterministically wins.

For the complete export index, see the [API reference](../packages/lapp/docs/api.md).
