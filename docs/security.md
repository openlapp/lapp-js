# Security

LAPP v1 assumes that applications running as the same OS user and deliberately
given access to the profile or shared Vault are trusted. `resolveConnection()`
returns usable credentials because the application communicates with the
upstream provider directly.

Do not expose a LAPP profile or resolved connection to untrusted code. A design
where applications cannot receive raw credentials requires a separate policy
service and is outside v1.

## Secret forms

Exactly three forms are valid:

| Form | Example | Guidance |
|------|---------|----------|
| Vault reference | `"vault://openai/default"` | Default for credentials created by the official SDK; protected by the current user's system credential store. |
| Environment reference | `"env://OPENAI_API_KEY"` | Supported; the key stays out of the profile. |
| Plaintext | `"sk-..."` | Accepted with a warning; the key remains on disk. |

Environment names must match `[A-Za-z_][A-Za-z0-9_]*`. Vault references contain
exactly a provider ID and credential ID, and the provider ID must match the
profile. `keychain://`, `file://`, malformed references, and unknown URI-like
forms are invalid rather than silently interpreted.

Vault is encrypted-at-rest storage, not an application sandbox. Any compatible
process running as the same OS user may retrieve the record and an authorized
application receives the plaintext while constructing a direct provider
request. LAPP v1 has no per-application ACL, gateway, non-exportability,
cross-device synchronization, password recovery, or authoritative audit log.

## Strict authentication

Use one explicit auth variant:

```json
{ "type": "none" }
{ "type": "bearer", "secret": "vault://openai/default" }
{ "type": "header", "name": "x-api-key", "secret": "env://ANTHROPIC_API_KEY" }
{ "type": "query", "name": "key", "secret": "env://PROVIDER_KEY" }
```

Unknown types and missing fields are errors. There is no implicit Bearer
behavior. `requestHeaders` cannot contain authentication, proxy-authentication,
cookie, or API-key headers. Names are unique case-insensitively and cannot
collide with the configured header-auth name.

## When secrets are resolved

- `loadProfile()` validates secret references but does not resolve them.
- `inspectProfile()` returns only redacted secret summaries.
- `listModels()` performs no secret resolution or I/O.
- asynchronous `resolveConnection()` and `refreshModels()` resolve only the
  selected provider's secret;
- a client created by `createLappClient()` resolves again immediately before
  each request, so Vault rotation is observed without recreating the client.

The default resolver reads `process.env` for environment references and opens
the current user's system credential store only for Vault references. Tests and
embedding applications may inject an environment map and `CredentialVault`.
Missing environment values, Vault records, native backends, invalid envelopes,
or binding mismatches fail before network I/O. There is no fallback to another
secret form.

## CLI display policy

`inspect`, `resolve`, `credential status`, diagnostics, and JSON output never
reveal a credential. The CLI intentionally provides no get or export command;
raw credentials are accepted only through a no-echo terminal prompt or stdin,
never as an argument value.

Provider error text is scrubbed for common credential shapes before reaching
CLI diagnostics. This is defense in depth, not a substitute for avoiding logs
that contain request headers or resolved connections.

Successful SDK response objects and stream events also redact the credential
resolved for that request by default. `redactSuccessfulSecrets: false` is an
explicit success-response opt-out only; errors and diagnostics remain redacted.

## Desktop manager

There is not yet a stable supported GUI release. The former React/Vue packages
remain removed. The Electron example is an unsupported Node-host integration
reference, while the current Tauri Manager Alpha implementation and its
trust-boundary contract live in
[`openlapp/lapp-manager`](https://github.com/openlapp/lapp-manager).

A renderer is never a trusted security boundary. The Manager keeps filesystem,
Vault, and network authority in its Rust backend and exposes only
narrow commands. It must not expose credential get, resolve, export, or rebind,
generic IPC, arbitrary filesystem access, or arbitrary network primitives.

## Endpoint binding

Vault envelopes are bound to the configured provider ID, normalized origin,
and authentication type/name. Header names are normalized to lowercase; query
parameter names remain case-sensitive. Compliant clients verify this binding
before returning the plaintext and verify the final request origin again before
injecting authentication. In addition:

- `modelDiscovery.url` must have the same origin as `baseUrl`;
- remote origins require HTTPS;
- loopback HTTP is allowed for local development;
- URLs cannot contain a username, password, or fragment;
- authenticated discovery requests do not follow redirects.

Review a profile before enabling it. A profile controls both the credential
reference and destination, so profiles copied from a repository or received
from another person are executable security configuration, not harmless data.
Binding prevents an edited profile from silently redirecting a Vault credential
through the official SDK; it does not stop a malicious same-user process from
reading the shared system credential record directly.

## Platform storage and recovery

The Windows implementation uses the current user's native Credential Manager.
macOS and Linux support is best-effort and depends on a working native credential
service. If the native module or service is unavailable, Vault operations fail
with a typed error. LAPP never creates a plaintext or encrypted-file fallback.

Vault records are not part of `LAPP_HOME` backups and are not synchronized by
LAPP. OS account, credential-store, or device resets may make a record
unavailable. Keep an independent recovery path with the upstream provider, such
as rotating or creating a replacement API key.

Every official high-level Profile + Vault mutation holds one current-user
global writer lock at `<LAPP_STATE_HOME>/locks/writer-v1.lock`. The lock is
shared across all `LAPP_HOME` roots because Vault records are also shared.
Normal writers wait up to 5000 ms and return `PROFILE_LOCKED`; they never steal
a lock based on age, owner PID, or heartbeat. Repair is a separate dangerous
operator action that must recheck the exact token returned by `lappx lock
inspect`. Missing or malformed owner records return `PROFILE_LOCK_INVALID` and
cannot be repaired through the token-checked protocol operation. Stable readers
accept a snapshot only when no writer intervenes and
both deterministic revisions match.

Every official Profile-only, Vault-only, or combined mutation requires an
expected revision. Low-level Profile transactions use the canonical Profile
revision and check it after lock acquisition and again immediately before the
first side effect. The Node manager host exposes a separate opaque revision
that also incorporates a manager-owned Vault generation under
`LAPP_STATE_HOME`; Vault-only mutations advance it while holding the global
writer lock, so stale manager snapshots cannot silently overwrite a newer
credential.

Deleting a provider removes only its profile configuration. It never deletes
the current-user Vault credential automatically because another LAPP root or
application may reference the same `vault://<providerId>/<credentialId>`.
Deleting shared credential storage is a separate, explicit `credential delete`
operation. If both should be removed, delete the credential before deleting
the provider configuration.

Changing a provider from a Vault reference to `env://` or plaintext likewise
changes only the profile reference and leaves the old shared Vault record
intact. Management clients should warn about the retained record. If it should be
removed, explicitly perform `credential delete` before changing the storage
mode.

## File safety

Provider IDs use a strict filename-safe grammar. The writer verifies every
resolved write and delete target remains under the selected profile root and
rejects colliding or invalid IDs instead of sanitizing them.

## Recommendations

- Keep the authoritative profile in a user-controlled `LAPP_HOME`, not an
  untrusted project checkout.
- Use the SDK's default Vault storage for newly entered keys, or `env://` for
  externally managed secrets; never commit plaintext credentials.
- Select plaintext storage only through an explicit, reviewed opt-in.
- Use `auth.type: "none"` only for services that truly require no credential.
- Keep `modelDiscovery` on the provider's origin.
- Run `lappx validate` after manual edits.
