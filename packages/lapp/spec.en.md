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
- LAPP v1 files are standard UTF-8 JSON. JSONC and alternate extensions are not supported.
- `manifest.json` has no LAPP v1 semantics.

All three documents require `"schemaVersion": "1.0"`. Implementations must reject unsupported versions. Core objects reject unknown properties; implementation-specific data belongs under `extensions`.

The schemas in [`schema/`](./schema/) define the document shapes. The rules below add cross-file and security constraints that JSON Schema alone cannot express.

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
- `enabled` defaults to `true`.
- `baseUrl` is the upstream API base URL. OpenAI-compatible implementations must not guess or insert a version segment; protocol-defined endpoint paths still apply.
- `protocols` is a non-empty ordered list of protocol IDs.
- `requestHeaders` contains optional non-secret static HTTP headers.
- `modelDiscovery` enables explicit remote model refresh.
- `extensions` contains namespaced implementation-specific data.

### Protocol selection

Core chat protocol IDs are:

- `openai-chat-completions`
- `openai-responses`
- `anthropic-messages`

Other syntactically valid IDs may be stored. An implementation must return an unsupported-protocol error when it cannot execute one; it must not silently reinterpret it.

Protocol order is preference order. Given the protocols supported by an application, select the first model candidate present in that supported set. If the application supplies no supported set, select the first candidate. Model candidates come from `model.protocols` when present, otherwise from `provider.protocols`.

### URLs

`baseUrl` and `modelDiscovery.url` must be absolute URLs without credentials or fragments. Remote URLs must use HTTPS. HTTP is permitted only for loopback hosts (`localhost`, `127.0.0.0/8`, and `::1`).

When a protocol defines an endpoint below `baseUrl`, implementations must append it to the URL pathname, not to the serialized URL string, and preserve any configured query parameters.

When `modelDiscovery` is present, its URL must have the same origin as `baseUrl`. Authenticated requests must use `redirect: error` or equivalent; credentials must never follow a redirect.

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

`defaults` maps an operation name to a canonical provider and model ID. Operation names are lowercase identifiers such as `chat`, `embedding`, or `text-to-speech`.

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

## Validation and writes

Implementations must validate each file against its versioned schema before applying semantic rules. Every write and delete must resolve the target path and prove it remains inside the selected LAPP root. File updates should use a temporary file in the same directory followed by an atomic rename.

LAPP v1 assumes one writer at a time. It does not define locking, profile-wide transactions, merge behavior, or migration from earlier drafts. Vault writes are separate from profile-file writes; tools that combine them should restore the prior Vault value if the profile write fails and report an explicit partial-failure error if restoration also fails.
