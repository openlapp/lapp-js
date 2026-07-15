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
- Run `lapp validate` after manual edits.
