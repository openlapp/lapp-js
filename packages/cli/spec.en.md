# LAPP v1 Specification

LAPP (Local AI Provider Profiles) is a local provider registry for AI applications. It lets an application discover configured models, resolve the selected model to an upstream URL and credential, and then communicate with that upstream directly.

LAPP is a file convention. It does not define a daemon, gateway, proxy, routing service, billing system, or remote control plane. Applications may read the files themselves or use an SDK or CLI that implements this specification.

## Root and files

The default root is `~/.lapp`. An application may support `LAPP_HOME`; when set, it is the complete root path and takes precedence over the default.

```text
~/.lapp/
├── providers/
│   └── <providerId>/
│       ├── provider.json
│       └── models.json
└── global.json
```

- `providers/` contains one directory per provider.
- Every provider directory contains both `provider.json` and `models.json`.
- `global.json` is optional.
- LAPP v1 files are I-JSON encoded as UTF-8. JSONC and alternate extensions are not supported.
- `manifest.json` has no LAPP v1 semantics.

All three documents require `"schemaVersion": "1.0"`. Implementations must reject unsupported versions. Core objects reject unknown properties; implementation-specific data belongs under `extensions`.

Every object member name must be unique after JSON escape processing. Strings
must contain only Unicode scalar values. Numbers must be finite IEEE 754
binary64 values, and every integer must be in the inclusive interoperable range
`-9007199254740991` through `9007199254740991`. These rules apply recursively,
including data under `extensions`. A parser that silently keeps one duplicate
member or rounds an unsafe integer is not conforming.

The schemas in [`schema/`](https://github.com/openlapp/lapp/tree/main/schema/) define the document shapes. The rules below add cross-file and security constraints that JSON Schema alone cannot express.

## Current-user state

`LAPP_HOME` selects profile data. `LAPP_STATE_HOME` selects current-user
coordination state and is intentionally independent of the selected profile.
When `LAPP_STATE_HOME` is set, it is the complete state path. Otherwise the
default is:

- Windows: `%LOCALAPPDATA%\OpenLAPP`;
- macOS: `~/Library/Application Support/OpenLAPP`;
- Linux: `$XDG_STATE_HOME/openlapp`, or `~/.local/state/openlapp` when
  `XDG_STATE_HOME` is unset.

Implementations must not derive this path from `LAPP_HOME`, the working
directory, or a repository checkout. State directories should be restricted to
the current OS user. The one normative writer lock is
`<LAPP_STATE_HOME>/locks/writer-v1.lock`; its owner record is `owner.json`.

## Identifiers

A provider ID must match:

```text
^[a-z0-9][a-z0-9._-]{0,63}$
```

It must not be a Windows reserved device name (`CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`, or `LPT1`–`LPT9`, case-insensitive), including a reserved basename followed by an extension, and must not end with a dot. The provider directory name must exactly equal `provider.id`. Implementations must reject invalid IDs; they must not sanitize IDs into filesystem names.

A model ID is the exact string sent upstream. It may contain `/`, but must not be empty, whitespace-only, or contain control characters. Within one provider, every model ID and alias shares one namespace and must be unique.

## provider.json

```json
{
  "schemaVersion": "1.0",
  "id": "deepseek",
  "name": "DeepSeek",
  "enabled": true,
  "baseUrl": "https://api.deepseek.com",
  "protocols": ["openai-chat-completions"],
  "auth": {
    "type": "bearer",
    "secret": "vault://deepseek/default"
  },
  "modelDiscovery": {
    "protocol": "openai-models",
    "url": "https://api.deepseek.com/models"
  }
}
```

Fields:

- `schemaVersion`, `id`, `baseUrl`, `protocols`, and `auth` are required.
- `name` is an optional display name.
- `providerType` is optional opaque provider-family metadata. When present, it
  matches `^[a-z0-9][a-z0-9._-]{0,63}$`. The vocabulary is open: this
  specification reserves no provider names, assigns no adapter behavior, and
  implementations must not infer the value from `id`, `baseUrl`, or model IDs.
  LAPP 1.0 execution and protocol selection MUST NOT consult or use
  `providerType`.
- `enabled` defaults to `true`.
- `baseUrl` is the upstream API base URL. OpenAI-compatible implementations must not guess or insert a version segment; protocol-defined endpoint paths still apply.
- `protocols` is a non-empty ordered list of protocol IDs.
- `requestHeaders` contains optional non-secret static HTTP headers.
- `modelDiscovery` enables explicit remote model refresh.
- `extensions` contains namespaced implementation-specific data.

### Protocol selection

Core upstream protocol IDs are:

- `openai-chat-completions`
- `openai-responses`
- `anthropic-messages`
- `openai-images`
- `openai-audio-speech`

Canonical request and response mappings for these IDs are fixed by the
[`sdk-v1`](https://github.com/openlapp/lapp/tree/main/tools/validator/fixtures/conformance/sdk-v1/) conformance fixtures.
The three conversational fixtures additionally fix SSE and tool-call mappings.

Other syntactically valid IDs may be stored. An implementation must return an unsupported-protocol error when it cannot execute one; it must not silently reinterpret it.

Protocol order is preference order. Given the protocols supported by an application, select the first model candidate present in that supported set. If the application supplies no supported set, select the first candidate. Model candidates come from `model.protocols` when present, otherwise from `provider.protocols`.

#### `openai-images`

This protocol maps the `image-generation` operation to a JSON `POST` at
`images/generations` below `baseUrl`. The selected model is always sent as
`model`; the typed input `prompt`, `count`, `size`, and `outputFormat` map to
`prompt`, `n`, `size`, and `output_format`. The typed `size` is an object with
integer `width` and `height`; the wire `size` is the string
`<width>x<height>`. Omitted optional input fields are not synthesized.

A response `data` entry containing `b64_json` becomes an inline `image`
artifact. Its media type is derived from the returned `output_format`, or the
requested output format when the response omits it. A `url` entry becomes a URL
artifact and must not be fetched implicitly while normalizing the response.
Image edits, variations, partial-image events, and streaming are outside this
v1 protocol ID.

#### `openai-audio-speech`

This protocol maps the `text-to-speech` operation to a JSON `POST` at
`audio/speech` below `baseUrl`. The selected model is always sent as `model`;
typed input `text`, `voice`, `outputFormat`, and `speed` map to `input`, `voice`,
`response_format`, and `speed`. Omitted optional input fields are not
synthesized.

The successful response body is audio bytes and becomes one inline `audio`
artifact. Its media type comes from the valid response `Content-Type`, falling
back to the requested output format's registered media type. SSE speech events are
outside this v1 protocol ID; an implementation may consume the ordinary audio
body incrementally but normalization still produces the same final artifact.

### URLs

`baseUrl` and `modelDiscovery.url` must be absolute HTTP(S) URLs without
credentials or fragments. Remote URLs must use HTTPS. HTTP is permitted only
for loopback hosts (`localhost`, `127.0.0.0/8`, and `::1`).

For every origin comparison and Vault binding, implementations must use the
standard serialized URL origin: lower-case scheme, URL-standard/IDNA ASCII host
serialization, bracketed IPv6 when applicable, no default port (`80` for HTTP,
`443` for HTTPS), and an explicit non-default port. Path, query, and fragment
are not part of an origin. For example, `https://EXAMPLE.com:443/v1?x=1` has
origin `https://example.com`. Opaque or `null` origins are invalid. Two URLs are
same-origin only when these serialized origin strings are byte-for-byte equal.

When a protocol defines an endpoint below `baseUrl`, implementations must append it to the URL pathname, not to the serialized URL string, and preserve any configured query parameters.

When `modelDiscovery` is present, its URL must have the same canonical origin
as `baseUrl`. Authenticated requests must use `redirect: error` or equivalent;
credentials must never follow a redirect. A path or query difference does not
change the origin, but implementations must still request the configured URL
exactly.

### Authentication

`auth` is exactly one of:

```json
{ "type": "none" }
{ "type": "bearer", "secret": "vault://deepseek/default" }
{ "type": "header", "name": "X-Custom-Key", "secret": "env://API_KEY" }
{ "type": "query", "name": "api_key", "secret": "explicit-plaintext-secret" }
```

No auth type has an implicit fallback. A bearer secret becomes `Authorization: Bearer <value>`; header and query auth use the configured `name` without adding a prefix.

LAPP v1 supports exactly three secret forms:

- `env://NAME`, where `NAME` is a valid environment-variable name;
- `vault://<providerId>/<credentialId>`, where both IDs match `^[a-z0-9][a-z0-9._-]{0,63}$`, neither uses a Windows reserved device basename or ends with a dot, and the provider segment exactly equals `provider.id`;
- a non-empty plaintext string.

The `env://` and `vault://` forms are exact: percent encoding, extra path segments, query strings, fragments, user information, and ports are not allowed in a Vault reference. A malformed `env:` or `vault:` value is invalid rather than plaintext. Other URI schemes, including `file://` and `keychain://`, are invalid in v1. Validators should warn about plaintext because it is easier to leak. New credential-creation tools should default raw secrets to `vault://`; writing plaintext must require an explicit choice. Secret values must never be written to diagnostics, model data, or logs.

### Device Vault

A Vault reference names a credential record protected by the current operating-system user account. It is independent of the selected LAPP root and is therefore shared by compatible LAPP applications running as that user. The fixed storage mapping is:

```text
service = dev.lapp.vault.v1
account = <providerId>/<credentialId>
value   = VaultEnvelopeV1 JSON
```

The stored JSON envelope is:

```json
{
  "version": 1,
  "providerId": "deepseek",
  "credentialId": "default",
  "origin": "https://api.deepseek.com",
  "auth": { "type": "bearer" },
  "secret": "..."
}
```

The envelope must contain exactly the fields shown. `version` is the integer `1`; both IDs follow the reference grammar; and `secret` is a non-empty string without CR or LF. `origin` is the standard serialized origin of `baseUrl`; URL paths are intentionally not part of the binding. The auth binding is exactly `{ "type": "bearer" }`, `{ "type": "header", "name": "<lowercase-name>" }`, or `{ "type": "query", "name": "<exact-name>" }`. Header names are bound case-insensitively by lowercasing them; query parameter names remain case-sensitive.

Before returning a Vault secret, an implementation must validate the envelope version and identity and require an exact match for provider ID, credential ID, origin, and auth binding. A mismatch must fail and must not automatically rebind the record. An unavailable backend, a missing record, or an invalid record is a runtime credential error, not a profile-schema error. Implementations must never silently fall back to plaintext, an environment variable, a file, or another credential.

Device Vault protects credentials at rest; it is not a non-exportable credential boundary. An application allowed to resolve the record receives the usable secret. LAPP v1 does not define per-application access control, a daemon, cross-device synchronization, a master password, automatic migration, or backup. Removing a profile or application must not implicitly delete a shared Vault record.

HTTP header names must be valid HTTP tokens and values must not contain CR or LF. `requestHeaders` must not contain credentials, including `Authorization`, proxy authorization, cookies, or API-key headers. Authentication belongs only in `auth`.
`requestHeaders` names must be unique case-insensitively and must not duplicate the configured header-auth name.

### Model discovery

`modelDiscovery.protocol` is either `openai-models` or `anthropic-models`. Its URL is explicit; implementations must not guess or append a models path.

Remote refresh is an explicit operation. It must:

1. resolve this provider's auth and, for Vault references, verify the stored binding;
2. request the configured same-origin URL without following redirects;
3. reject non-2xx, malformed, or incomplete responses;
4. normalize returned model IDs and optional display names;
5. return a proposed next profile without writing files automatically.

A valid empty response makes no changes. Refresh appends previously unknown model IDs, sorted by ID, after existing entries. It may fill a missing local display name, but must not overwrite any existing local field and must never remove a local model.

## models.json

```json
{
  "schemaVersion": "1.0",
  "models": [
    {
      "id": "deepseek-v4-flash",
      "name": "DeepSeek V4 Flash",
      "aliases": ["ds-v4-flash"],
      "protocols": ["openai-chat-completions"],
      "type": "chat",
      "inputModalities": ["text"],
      "outputModalities": ["text"],
      "capabilities": ["chat", "stream", "tool-call"],
      "contextWindow": 1000000,
      "maxOutputTokens": 384000,
      "enabled": true
    }
  ]
}
```

Only `id` is required on a model. `enabled` defaults to `true`. `name`, `aliases`, `type`, modalities, capabilities, positive token limits, and `extensions` are descriptive local data.

The following values are well-known interoperability vocabulary, not closed
enums:

- operations: `chat`, `embedding`, `image-generation`, `video-generation`,
  `text-to-speech`, and `music-generation`;
- input/output modalities: `text`, `image`, `audio`, and `video`;
- capabilities: the operation names above plus `stream`, `tool-call`, and
  `reasoning`.

Unknown non-blank values remain valid and must be preserved. Music and songs
use the `audio` output modality and the `music-generation` capability;
text-to-speech uses the same output modality and the `text-to-speech`
capability. `type` remains opaque descriptive metadata and is not a routing
key.

When `protocols` is present, it must be a non-empty subset of the provider's protocols. When absent, the model inherits the provider's ordered protocols.

`models.json` is the local authoritative catalog. Remote provider results are discovery input, not a second source of truth. Applications must not infer capabilities from a model name.

## global.json

```json
{
  "schemaVersion": "1.0",
  "defaults": {
    "chat": {
      "providerId": "deepseek",
      "modelId": "deepseek-v4-flash"
    }
  }
}
```

`defaults` maps an operation name to a canonical provider and model ID.
Operation names are lowercase identifiers; the well-known names are listed in
the `models.json` section above. Other syntactically valid operation names
remain allowed.

A default must reference an existing enabled provider and enabled model by canonical ID. Aliases must not be stored in `global.json`. A missing `global.json` is valid.

## Connection resolution

Given either `{ providerId, model }` or a default operation name, an implementation must:

1. resolve the default, if requested;
2. require an existing enabled provider;
3. resolve `model` against the provider's model IDs and aliases, rejecting ambiguity;
4. require an enabled model and normalize aliases to its canonical ID;
5. select a protocol using the ordered intersection rule above;
6. validate the URL and static headers;
7. resolve the configured secret, enforce any Vault binding, and construct exactly one auth mechanism;
8. return the canonical provider ID, model ID, protocol, base URL, headers, and in-memory auth value.

Reading the model list must not resolve secrets or access the network. Only connection resolution and explicit refresh need credentials.

## Validation and diagnostics

Implementations must enforce I-JSON, validate each file against its versioned
schema, and only then apply semantic rules. Unknown, malformed, or unsupported
v1 data must be rejected; LAPP 1.0 has no compatibility or migration layer for
earlier drafts. An existing managed document path that is not a regular file,
including a symbolic link or directory, is rejected with `NON_REGULAR_FILE`.

A conformance diagnostic is identified only by `(level, code, location)`:

- `level` is `ERROR` or `WARN`;
- `code` is a stable upper-case ASCII identifier with underscores;
- `location` is a POSIX path relative to the selected LAPP root, optionally
  followed by `#` and an RFC 6901 JSON Pointer.

Locations must not be absolute, start with `./`, or contain backslashes. A
file-wide diagnostic uses only the path. A member diagnostic uses the exact
decoded member path, escaping `~` as `~0` and `/` as `~1`; for example,
`providers/deepseek/provider.json#/auth/secret`. Human-readable messages may be
localized, and diagnostic order may vary. Neither message text nor order is
part of conformance. Secret values, Vault envelopes, and unsanitized native
errors must never appear in any diagnostic field.

## Profile revision

The profile revision is an opaque compare-and-swap value computed from exact
managed bytes and relevant file states. Its text form is `sha256:` followed by
64 lower-case hexadecimal digits. Callers must compare it only for equality.

The SHA-256 input begins with the ASCII domain bytes
`lapp-profile-revision-v1` followed by one NUL byte. It then contains a
four-byte unsigned big-endian record count and the records described below.

The record set always contains `global.json` and `providers`. When `providers`
is a directory, it also contains one structural record for every direct child
directory. For each such provider directory, it additionally contains
`providers/<name>/provider.json` and `providers/<name>/models.json`. No deeper
entry, temporary sibling, lock, Vault record, mode, timestamp, inode, or other
OS metadata is included.

Records are sorted by bytewise lexicographic comparison of their POSIX relative
paths encoded as UTF-8. Each record is framed as:

```text
u32be(path byte length) || path UTF-8 || state
```

`state` is one byte: `00` for missing, `01` for a regular file, `02` for a
directory, and `03` for any other object, including a symbolic link. A regular
file record then appends `u64be(content byte length) || exact content bytes`.
This framing distinguishes missing, empty, directory, and non-file states
without parsing or normalizing JSON. The reference vectors are in
[`tools/validator/fixtures/conformance/revision-v1.json`](https://github.com/openlapp/lapp/blob/main/tools/validator/fixtures/conformance/revision-v1.json).

Every direct provider directory name must be representable as well-formed UTF-8
containing only Unicode scalar values before framing. An unrepresentable raw
POSIX filename fails revision computation with `PROFILE_PATH_INVALID`; it must
not be decoded with replacement characters. Writers must never create such a
name. Valid LAPP provider IDs are ASCII and therefore always satisfy this rule.

## Stable reads

A reader that returns a complete profile or snapshot must perform a stable
read, whether or not the caller intends to mutate it. By default it makes at
most three complete attempts. Each attempt must:

1. verify that `writer-v1.lock` does not exist;
2. compute `revisionBefore`;
3. read, I-JSON check, Schema validate, and semantically validate the complete
   profile without resolving credentials or accessing the network;
4. compute `revisionAfter`;
5. verify again that `writer-v1.lock` does not exist; and
6. accept the snapshot only when both revisions are exactly equal.

A stable invalid profile returns its canonical validation diagnostics. An
attempt that observes a lock or unequal revisions is discarded in full. If no
attempt succeeds, the operation fails with `PROFILE_READ_UNSTABLE`; it must not
return a mixed snapshot. Implementations may use a lower caller-supplied attempt
limit but must not silently use an unbounded loop.

## Current-user writer coordination

Every conforming writer, including a Vault-only credential mutation, must hold
the one current-user global lock at
`<LAPP_STATE_HOME>/locks/writer-v1.lock`. This intentionally serializes writes
across different `LAPP_HOME` roots because Device Vault records are shared by
the current OS user.

Acquisition is the atomic creation of the `writer-v1.lock` directory without
replacement. After successful creation, the owner exclusively creates
`owner.json` as I-JSON containing exactly:

```json
{
  "version": 1,
  "token": "123e4567-e89b-12d3-a456-426614174000",
  "pid": 1234,
  "createdAt": "2026-07-17T09:30:00Z"
}
```

`token` is a canonical lower-case hyphenated UUID string, `pid` is an integer
from `0` through `9007199254740991`, and `createdAt` uses the Schema's canonical
RFC 3339 UTC subset ending in `Z`, with seconds from `00` through `59`. Its date
and time must also be a real Gregorian calendar value; matching the lexical
pattern alone is insufficient. The record has no heartbeat or expiry field. The versioned schema is
[`schema/writer-lock.schema.json`](https://github.com/openlapp/lapp/blob/main/schema/writer-lock.schema.json).
The creator must flush the owner record before entering the mutation critical
section. If exclusive owner creation or that flush fails, only that creator may
attempt ownership-safe cleanup of the directory it just created; a cleanup
failure leaves the lock for explicit recovery and fails acquisition.

If the directory already exists, the default acquisition wait is bounded to
5000 milliseconds. Exhaustion fails with `PROFILE_LOCKED`. A writer must never
infer abandonment from `createdAt`, process identity, PID liveness, file age,
or any heartbeat, and must never steal or replace the lock during a normal
operation.

Before release, the owner must re-read and validate `owner.json` and require an
exact token match. It must then atomically rename the lock directory to an
owner-specific sibling before deleting that renamed directory, so it cannot
delete a newly acquired lock. A mismatch, malformed record, unexpected
filesystem object, or ownership-safe release failure is `PROFILE_LOCK_INVALID`
and must leave the observed lock in place.

Lock repair is a separate explicit user-authorized operation. It must first
display or return the observed owner record, receive the exact observed token
as confirmation, re-read and compare that token, and atomically rename the lock
directory to a repair-specific sibling before deleting it. A changed token
aborts repair. Missing or malformed owner records cannot satisfy token compare:
a conforming repair operation must return `PROFILE_LOCK_INVALID` and leave the
lock in place. Tokenless manual filesystem recovery, if an operator chooses it
after independently proving no writer is active, is explicitly outside the
LAPP protocol. Repair is never called automatically and must not use age, PID,
or heartbeat heuristics.

## Compare-and-swap writes and rollback

Every writer mutation, including Vault-only credential set or delete, must
include the `expectedRevision` obtained from a stable profile read. A writer
must:

1. acquire the current-user global lock;
2. while holding it, obtain a coherent current profile with the same
   maximum-three-attempt revision bracketing (the lock-absence checks are
   omitted because this writer owns the lock);
3. compare that revision with `expectedRevision` before any Vault access, file
   creation, deletion, or mutation;
4. fail with `PROFILE_CONFLICT` and perform no mutation when they differ;
5. apply one semantic operation in memory and validate the complete proposed
   profile;
6. immediately before the first side effect, recompute the revision and again
   require it to equal `expectedRevision`, detecting a non-conforming manual
   edit as another `PROFILE_CONFLICT`; and
7. commit only the exact files changed by that proposal.

Every write and delete must resolve the target and prove it remains inside the
selected LAPP root. Symlinks and other non-regular managed-file targets must be
rejected. A changed file is written to a restrictive temporary sibling, flushed,
and atomically renamed; the containing directory is flushed where the platform
supports it. Unchanged files must not be rewritten. Multiple changed profile
paths are committed in the same UTF-8 bytewise order used by the revision.
Required provider directories are created in that order before their files.
A provider directory is removed only after both managed files are removed and
only if it is empty; a writer must never recursively delete unknown content.
Before the first side effect, removing a provider must fail the entire commit
without mutation if its directory contains any entry other than the two
managed regular files. The writer must check emptiness again immediately before
removing the directory; a newly non-empty directory is a profile-step failure
that triggers rollback, never a successful commit with orphaned content.
Directory actions participate in the same reverse actual-action rollback.

Before the first side effect, the writer must preserve the exact prior state of
every affected profile path and Vault record, including presence versus
absence. If any profile step fails, it restores changed profile paths in
reverse commit order. It must attempt every required rollback step even when an
earlier rollback step fails.

For an operation combining a Vault mutation with profile changes, the complete
proposal is validated first, the prior Vault value is preserved, the Vault
mutation is applied, and only then are profile files committed. If the profile
commit fails, profile rollback runs first and Vault rollback then restores the
exact prior record or absence. If all rollback succeeds, return the original
redacted write failure. For a profile-only transaction, incomplete profile
rollback is `PROFILE_UPDATE_PARTIAL_FAILURE`. For any transaction that mutated
Vault, any incomplete profile rollback or Vault restoration uses the
higher-priority top-level code `CREDENTIAL_UPDATE_PARTIAL_FAILURE`; structured
redacted details may also record that profile restoration was incomplete. Thus,
if both restoration classes fail, `CREDENTIAL_UPDATE_PARTIAL_FAILURE`
deterministically wins. Partial-failure diagnostics must not expose either the
old or new secret. The global lock is retained through rollback and
ownership-safe release.

A dry run performs stable read, semantic mutation, and proposal validation only.
It must not acquire a mutation lock, resolve or inspect a Vault record, write a
temporary file, or alter profile state.
