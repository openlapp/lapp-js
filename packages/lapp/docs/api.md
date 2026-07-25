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

### `readProfileStable(options?) -> { value, revision }`

Performs the same validated maximum-three-attempt stable read while returning
the exact revision from that accepted snapshot. Use this when a later mutation
must send `expectedRevision`; it avoids nesting a second stable-read bracket.

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
| `prepareProviderUpdate(profile, input)` | Purely prepare a provider plus an optional pending Vault write using the SDK's credential policy. |
| `upsertModel(profile, input)` | Add or patch a model under an existing provider. |
| `removeProvider(profile, id)` | Remove a provider unless a default references it. |
| `removeModel(profile, target)` | Remove by canonical ID or unique alias unless a default references it. |
| `setDefault(profile, task, target)` | Resolve the target and store its canonical IDs. |

Omitted fields in `upsertProvider` and `upsertModel` are preserved.

### `prepareProviderUpdate(profile, input) -> PrepareProviderUpdateResult`

For authenticated providers, `input.auth.credential` accepts one of:

```ts
type CredentialInput =
  | { secret: string; storage?: "vault"; credentialId?: string; overwrite?: boolean }
  | { secret: string; storage: "plaintext" }
  | { storage: "env"; name: string };
```

Omitting `storage` prepares a Vault write under credential ID `default` and
puts only its `vault://` reference in the returned profile. The
binding is derived from the final provider configuration; callers cannot
supply a different origin. `{ storage: "plaintext" }` is the only way this API
writes a raw secret into the profile and returns a
`PLAINTEXT_SECRET_IN_USE` warning. `{ storage: "env" }` writes an `env://`
reference without reading the environment.

The function has no side effects. It returns
`{ profile, credentialRef?, vaultWrite?, warnings }`. Pass `profile` and
`vaultWrite` to `commitProfileTransaction()` with the stable-read revision so
the global lock, CAS check, and rollback cover both stores.

### `planChanges(before, after) -> ChangePlan`

Returns a file-level `create`, `modify`, and `delete` preview.

### `writeProfileAtomic(profile, options?) -> Promise<void>`

Options are `{ path?, indent?, trailingNewline?, before? }`. Loaded and
SDK-created profiles retain their write location internally; `path` supplies it
for a manually constructed profile. The writer validates first, checks
path containment, and writes each changed JSON file through a same-directory
temporary file plus fsync and rename. `before` enables deletion of provider
files removed from the new profile. Even a zero-provider profile creates its
required `providers/` directory. Provider removal is rejected before mutation
if the provider directory contains unmanaged entries; a concurrent non-empty
directory causes rollback instead of leaving an orphaned provider directory.
This is a low-level persistence primitive: it does not acquire the current-user
global lock and does not perform CAS. Official writers use
`commitProfileTransaction()`; specialized direct-protocol integrations must
provide the lock and revision check themselves.

## Desktop manager contract and Node host

The manager API is split into two explicit package subpaths:

```ts
import type { LappManagerBridgeV1 } from "@openlapp/lapp/manager-contract";
import { createNodeLappManagerHost } from "@openlapp/lapp/manager-host";
```

`manager-contract` is structured-clone-safe and has no Node or native runtime
imports. `manager-host` is the Node embedding surface that owns profile, Vault,
lock, and explicit provider-test/model-refresh authority. There is not yet a
stable supported GUI release; the standalone Manager repository contains the
current Tauri Alpha implementation.

### `createNodeLappManagerHost(options?) -> LappManagerBridgeV1`

Options are `{ path?, vault?, env?, fetchImpl?, lock? }`. The profile root is
fixed when the host is created and cannot be replaced by a renderer request.
`vault`, `env`, `fetchImpl`, and lock timing are injection points for embedding
and tests; the system Vault and global fetch are used when omitted.

The bridge exposes:

| Method | Result |
|--------|--------|
| `handshake()` | Protocol version and `write-profile`, `vault`, `test-connection`, `refresh-models`, and `events` features. |
| `getSnapshot()` | `ManagerSnapshot` containing an opaque revision, sanitized profile view, and diagnostics. |
| `transact(request)` | Apply one semantic operation using `request.expectedRevision` as compare-and-swap state. |
| `testConnection(request)` | Perform a small direct request for a model selector and return a sanitized result. |
| `subscribe(listener)` | Optional invalidation subscription; returns an unsubscribe function. |

All request methods return `ManagerResult<T>`. Runtime-invalid IPC payloads,
profile conflicts, credential failures, and host failures are represented by a
serializable `ManagerErrorView`; native causes and credentials are not returned.

`ManagerOperation` covers `provider.set`, `provider.delete`, `model.set`,
`model.delete`, `default.set`, `default.delete`, `credential.set`,
`credential.delete`, and `models.refresh`. The host serializes transactions,
coordinates official writers using the current-user global cross-process lock,
and commits profile files atomically. The bridge revision is an opaque hash of
the canonical Profile revision and a manager-owned Vault generation stored
under `LAPP_STATE_HOME`; the host rechecks both inside the lock. Vault-only
mutations advance that generation before their side effect, so an older
snapshot cannot overwrite a newer credential. When a transaction writes the
Vault before changing the Profile, a Profile failure restores the previous
Vault record or removes the newly created one.

Snapshots expose a credential's scheme, reference, availability, and binding
state, not its secret. The bridge deliberately has no credential get, resolve,
export, or rebind method.

### Low-level official-writer helpers

The root package exports these writer primitives:

| Export | Purpose |
|--------|---------|
| `computeProfileRevision(rootDir)` | Hash exact managed paths and bytes with the language-neutral LAPP v1 framing. |
| `readStable(rootDir, read, options?)` | Accept a multi-file read only when no writer intervenes and before/after revisions match; accepts 1–3 attempts and defaults to 3. |
| `withWriterLock(work, options?)` | Run work under the current-user global lock; defaults to a 5000 ms wait and never steals by age, PID, or heartbeat. |
| `inspectWriterLock(options?)` | Read the global lock and its validated owner record without modifying it. |
| `validateWriterLockOwner(bytes)` | Validate raw owner bytes and return the exact canonical I-JSON/schema/timestamp identity. |
| `repairWriterLock(observedToken, options?)` | Recheck the exact token, atomically rename to a repair-specific sibling, then safely delete only that verified lock. |
| `commitProfileTransaction(options)` | Commit a validated `before`/`next` profile plus an optional pending Vault write or delete. |

`commitProfileTransaction` options include `rootDir`, `before`, `next`, required
`expectedRevision`, and optional `vault`, `vaultWrite`, `vaultDeleteRef`, and
lock timing. Every Profile-only and Vault-only mutation requires the revision.
The SDK checks it after lock acquisition and again immediately before the first
side effect. A mismatch throws
`ProfileRevisionConflictError` with code `PROFILE_CONFLICT` and
`currentRevision`. Bounded lock acquisition throws `ProfileLockedError` with
code `PROFILE_LOCKED`; stable-read exhaustion throws
`ProfileReadUnstableError` with code `PROFILE_READ_UNSTABLE`.

This low-level helper's `expectedRevision` is the canonical Profile revision; it
does not make an external credential store independently revisioned. A
long-lived host that accepts stale client snapshots must add a Vault-side CAS
generation. `createNodeLappManagerHost()` supplies that coordination for the
official manager bridge.

These helpers support official writers such as the CLI. They must not be
bridged into an untrusted renderer. The current standalone Manager Alpha and
its trust-boundary contracts live in
[`openlapp/lapp-manager`](https://github.com/openlapp/lapp-manager); the
Electron example is an unsupported Node-host integration reference.

## Direct-call client

### `createLappClient(options) -> LappClient`

```ts
const client = createLappClient({
  profile,
  provider: "openai",
  model: "gpt-4o-mini",
  vault,
  fetchImpl: customFetch,
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

`redactSuccessfulSecrets` defaults to `true` and scrubs the credential resolved
for that request from successful response objects and stream events. Set it
explicitly to `false` only when exact upstream response preservation is
required. Errors and diagnostics are always redacted.

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

## Media generation clients

| Factory | Default operation | Bundled LAPP 1.0 wire |
|---------|-------------------|------------------------|
| `createImageGenerationClient(options)` | `image-generation` | `openai-images` |
| `createVideoGenerationClient(options)` | `video-generation` | none |
| `createSpeechSynthesisClient(options)` | `text-to-speech` | `openai-audio-speech` |
| `createMusicGenerationClient(options)` | `music-generation` | none |

All accept `profile` plus either a named `default` or an explicit
`provider`/`model` pair. Image and video expose `generate`, `poll`, and `wait`;
speech exposes `synthesize`, `poll`, `wait`, and async-iterable `stream`;
music exposes `generate`, `poll`, `wait`, and `stream`. Video and music have no
built-in wire adapter, so their factories return `PROTOCOL_NOT_SUPPORTED`
before resolving a credential or issuing a request.

The shared result is `GenerationState` (`queued`, `running`, `succeeded`, or
`failed`) with an ordered `GenerationOutput.parts` array of `TextPart` and
`ArtifactPart`. Inline artifacts contain `Uint8Array`; URL artifacts remain
lazy. `downloadArtifact` requires a positive `maxBytes`, sends provider auth
only to the provider origin, and rejects authenticated redirects. `wait`
defaults to 2 seconds / 30 minutes and clamps polling hints to 0.5–30 seconds.

`providerType` is not part of adapter selection. Selection uses only the
resolved operation and declared protocol order. An explicitly declared
`capabilities` array that omits the operation yields
`OPERATION_NOT_SUPPORTED`; no supported protocol yields
`PROTOCOL_NOT_SUPPORTED`. Adapter-specific `extra` keys are allowlisted and
cannot replace model, input, voice, stream, endpoint, auth, or job fields.

## Public errors

| Error | Meaning |
|-------|---------|
| `ProfileValidationError` | The loaded or written profile is invalid. |
| `ProfileLockedError` | The current-user global writer lock could not be acquired (`PROFILE_LOCKED`). |
| `ProfileReadUnstableError` | A stable multi-file snapshot could not be obtained (`PROFILE_READ_UNSTABLE`). |
| `ProfileRevisionConflictError` | Compare-and-swap revision mismatch (`PROFILE_CONFLICT`). |
| `ProfileLockInvalidError` | Lock ownership, release, or explicit token-checked repair was unsafe (`PROFILE_LOCK_INVALID`). |
| `ProfilePathInvalidError` | A canonical Provider directory name cannot be represented as valid UTF-8 (`PROFILE_PATH_INVALID`). |
| `ProfileUpdatePartialFailureError` | A failed Profile write could not restore every previous file (`PROFILE_UPDATE_PARTIAL_FAILURE`). |
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
messages. Once a combined transaction has mutated Vault, incomplete Profile
rollback or Vault restoration uses the top-level
`CREDENTIAL_UPDATE_PARTIAL_FAILURE` code. Its stable `causes` includes
`PROFILE_UPDATE_PARTIAL_FAILURE` whenever Profile rollback was incomplete;
that credential code also deterministically wins if both restoration classes
fail.

Parsing helpers, Schema test hooks, adapter internals, and discovery internals
are intentionally not package-root API.
