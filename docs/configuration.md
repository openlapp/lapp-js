# Configuration

A LAPP profile is a standard-JSON directory tree describing upstream
providers, a local authoritative model directory, and optional task defaults.

## Profile location

The SDK and CLI resolve the root in this order:

1. Explicit path argument or `{ path }` option.
2. `LAPP_HOME`.
3. `~/.lapp`.

Only `.json` files are accepted. Every file uses `"schemaVersion": "1.0"`.

## Directory layout

```text
~/.lapp/
├── global.json
└── providers/
    ├── openai/
    │   ├── provider.json
    │   └── models.json
    └── local/
        ├── provider.json
        └── models.json
```

`global.json` is optional until a default is configured. Every provider must
have a `models.json`; an empty authoritative catalogue uses
`{"schemaVersion":"1.0","models":[]}`.

The provider directory name must exactly equal `provider.json#id`. Provider IDs
match `^[a-z0-9][a-z0-9._-]{0,63}$` and cannot be Windows reserved names.

## `provider.json`

```json
{
  "schemaVersion": "1.0",
  "id": "openai",
  "name": "OpenAI",
  "enabled": true,
  "baseUrl": "https://api.openai.com/v1",
  "protocols": ["openai-responses", "openai-chat-completions"],
  "auth": {
    "type": "bearer",
    "secret": "vault://openai/default"
  },
  "requestHeaders": {
    "OpenAI-Organization": "org-example"
  },
  "modelDiscovery": {
    "protocol": "openai-models",
    "url": "https://api.openai.com/v1/models"
  }
}
```

Required fields are `schemaVersion`, `id`, `baseUrl`, `protocols`, and `auth`.
Optional fields are `name`, `enabled`, `requestHeaders`, `modelDiscovery`, and
`extensions`.

`protocols` is an ordered, non-empty list of protocol IDs. A model may narrow
that list. During resolution, the SDK selects the first candidate supported by
the calling application; it never performs protocol conversion.

### Authentication

Authentication is a strict tagged union:

```json
{ "type": "none" }
{ "type": "bearer", "secret": "vault://openai/default" }
{ "type": "header", "name": "x-api-key", "secret": "env://ANTHROPIC_API_KEY" }
{ "type": "query", "name": "key", "secret": "provider-key-in-plaintext" }
```

Secrets are exactly one of plaintext, `env://NAME`, or
`vault://<providerId>/<credentialId>`. A Vault reference has exactly two
portable-ID segments; its provider segment must equal this provider's `id`.
Percent encoding, query strings, fragments, extra path segments, `keychain://`,
`file://`, and unknown schemes are invalid. Plaintext is accepted with a
warning because it remains in `provider.json`.

The official SDK stores new raw credentials in the current user's system
credential store by default and writes only a Vault reference to the profile.
Vault credentials are shared by every compatible application running as that
OS user. The protected record binds the credential to the provider ID,
normalized origin, and authentication type/name; changing one of those fields
requires explicitly storing the credential again.

`requestHeaders` is for non-secret static headers. Header names must be valid
HTTP tokens, values cannot contain CR/LF, and authentication/cookie headers are
rejected. Names must be unique case-insensitively and cannot duplicate a
configured header-auth name.

### Model discovery

`modelDiscovery` is optional and supports two response contracts:

- `openai-models`
- `anthropic-models`

Its URL must have the same origin as `baseUrl`. Remote endpoints require HTTPS;
HTTP is allowed only for loopback hosts. Authenticated discovery requests do not
follow redirects.

## `models.json`

```json
{
  "schemaVersion": "1.0",
  "models": [
    {
      "id": "gpt-4o-mini",
      "name": "GPT-4o mini",
      "aliases": ["fast-chat"],
      "protocols": ["openai-responses", "openai-chat-completions"],
      "type": "chat",
      "inputModalities": ["text", "image"],
      "outputModalities": ["text"],
      "capabilities": ["streaming", "tools"],
      "contextWindow": 128000,
      "maxOutputTokens": 16384
    }
  ]
}
```

`models.json` is local authoritative data, not generated cache state. Model IDs
may contain `/`, but cannot be blank or contain control characters. Within a
provider, every model ID and alias shares one unique namespace.

`model.protocols` is optional. When absent, it inherits provider protocols;
when present, it must be a non-empty subset. All other descriptive fields are
optional. Use `extensions` for namespaced implementation-specific data.

`models refresh` only appends new remote IDs in sorted order and may fill a
missing display name. It preserves existing order and fields, and never removes
models that disappear upstream.

## `global.json`

```json
{
  "schemaVersion": "1.0",
  "defaults": {
    "chat": {
      "providerId": "openai",
      "modelId": "gpt-4o-mini"
    }
  }
}
```

Default keys are task names. Values always use canonical model IDs, not aliases,
and must reference enabled providers and models. Removing a referenced provider
or model is rejected until its default is changed.

## Disabled entries and extensions

Disabled providers and models remain in memory for round-tripping. They are
excluded from `listModels()` by default and rejected by `resolveConnection()`.

Core objects reject unknown properties. Put implementation-specific fields in
an `extensions` object instead.

## Writes

Low-level SDK management functions are immutable and do not touch disk.
`upsertProviderWithCredential()` is the asynchronous high-level helper: raw
secrets default to Vault storage, while plaintext requires an explicit storage
choice and produces a warning. It returns an updated in-memory profile; call
`writeProfileAtomic()` explicitly after reviewing `planChanges()`. Each changed
file is validated, written to a same-directory temporary file, fsynced, and
renamed. v1 assumes one writer at a time and does not provide profile-wide
transactions or backups.
