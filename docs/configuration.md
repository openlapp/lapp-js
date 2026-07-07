# Configuration

A LAPP profile is a directory tree (conventionally named `.lapp` or `~/.lapp`) that describes providers, models, defaults, and metadata.

## Profile path resolution

The SDK and CLI resolve the profile root in this order:

1. Explicit path argument or `path` option.
2. `LAPP_HOME` environment variable.
3. `~/.lapp`.

You can also call `resolveLappRoot()` to get the resolved path without loading the profile.

## Anatomy of a `.lapp/` tree

```text
~/.lapp/
├── manifest.json
├── global.json
├── providers/
│   ├── openai/
│   │   ├── provider.json
│   │   └── models.json
│   └── anthropic/
│       ├── provider.json
│       └── models.json
```

### `manifest.json`

Schema version and profile metadata.

```json
{
  "schemaVersion": "1.0.0",
  "name": "My LAPP profile"
}
```

### `providers/<id>/provider.json`

Provider configuration.

```json
{
  "schemaVersion": "1.0.0",
  "id": "openai",
  "protocol": "openai-chat-completions",
  "baseUrl": "https://api.openai.com/v1",
  "auth": {
    "secret": "env://OPENAI_API_KEY"
  }
}
```

### `providers/<id>/models.json`

Per-provider model list.

```json
{
  "schemaVersion": "1.0.0",
  "models": [
    {
      "id": "gpt-4o",
      "aliases": ["gpt4o"],
      "type": "chat",
      "capabilities": ["text", "tools", "vision", "streaming"]
    }
  ]
}
```

### `global.json`

Global defaults per task kind.

```json
{
  "schemaVersion": "1.0.0",
  "defaultModel": {
    "providerId": "openai",
    "model": "gpt-4o"
  }
}
```

## Provider fields

### `protocol` vs `protocols`

`protocol` is the legacy single string. New profiles should prefer `protocols: [...]`, an ordered preference list. The SDK picks the first supported entry.

```json
{
  "id": "openai",
  "protocols": [
    {
      "id": "openai-responses",
      "baseUrl": "https://api.openai.com/v1",
      "requestHeaders": { "OpenAI-Beta": "responses=v1" }
    },
    {
      "id": "openai-chat-completions",
      "baseUrl": "https://api.openai.com/v1"
    }
  ]
}
```

When both are present, `protocols` takes precedence.

### `baseUrl`

- Do not end `baseUrl` with `/`; the SDK warns if you do.
- OpenAI-compatible adapters never auto-append `/v1`. Include it in `baseUrl` if your provider needs it.
- Anthropic's adapter dedups a trailing `/v1` only when it is the sole last segment.

### `auth`

- `bearer` (default) — sends `Authorization: Bearer <secret>`.
- `header` — sends the secret in a custom header name.
- `queryParam` — appends the secret to the query string (and strips header auth to avoid leaking it twice).
- `none` — no auth header; used with `allowUnauthenticated` for local providers.

```json
{
  "auth": {
    "type": "header",
    "header": "X-Api-Key",
    "secret": "env://API_KEY"
  }
}
```

### `requestHeaders`

User-supplied headers sent with every request. Auth-carrying keys (`authorization`, `x-api-key`) are stripped case-insensitively before the adapter adds its own, so a user-supplied `X-Api-Key` does not produce two distinct headers.

### `links.models`

Override the model-list URL for protocols that do not expose a public `/models` endpoint (for example, Anthropic).

```json
{
  "links": {
    "models": "https://api.anthropic.com/v1/models"
  }
}
```

## Model fields

| Field | Meaning |
|-------|---------|
| `id` | Model identifier. |
| `aliases` | Alternative names you can use in `createLappClient({ model: "alias" })`. |
| `type` | `chat`, `embedding`, `image`, `tts`, `video`. |
| `capabilities` | Array of capability strings such as `text`, `tools`, `vision`, `streaming`, `image-generation`. |
| `inputModalities` / `outputModalities` | Optional modality lists. |
| `contextWindow` / `maxOutputTokens` | Optional model limits. |
| `enabled` | `false` keeps the entry but skips it at runtime. |
| `source` | `provider` (from sync) or `manual` (user-added). |

## Global defaults

Five default slots map to CLI `--kind` values:

| CLI `--kind` | Global slot |
|--------------|-------------|
| `chat` | `defaultModel` |
| `embedding` | `defaultEmbeddingModel` |
| `image` | `defaultImageModel` |
| `tts` | `defaultTextToSpeechModel` |
| `video` | `defaultVideoModel` |

## Disabled entries

Providers or models with `enabled: false` are kept in the in-memory profile so writes can round-trip the on-disk file. They are skipped by:

- `createLappClient` target resolution
- `exportEnv`
- `listModels` (unless `includeDisabled` / `includeDisabledModels` is set)

## JSON and JSONC

- The SDK reads both `.json` and `.jsonc` files.
- New files are written as `.json`.
- Comments are not preserved in v1.

## Atomic writes

`writeProfileAtomic` follows this rule for every file it touches:

1. Build complete content in memory.
2. Validate before writing.
3. Write to a hidden temporary file in the same directory as the target file.
4. Close the temporary file.
5. Rename it over the target path.
6. On failure, remove only the temporary file.

This is a crash-safety guarantee, not a backup system. There are no backups, no rollback, and no temporary directory.

## Multi-protocol example

```json
{
  "schemaVersion": "1.0.0",
  "id": "openai",
  "protocols": [
    {
      "id": "openai-responses",
      "baseUrl": "https://api.openai.com/v1"
    },
    {
      "id": "openai-chat-completions",
      "baseUrl": "https://api.openai.com/v1"
    }
  ],
  "baseUrl": "https://api.openai.com/v1",
  "auth": {
    "secret": "env://OPENAI_API_KEY"
  }
}
```

The SDK will prefer `openai-responses` and fall back to `openai-chat-completions` if the first is not supported.
