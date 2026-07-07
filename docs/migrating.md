# Migrating

This document tracks behavioral changes and migration notes for `lapp-js` users.

## v1.0.0

`lapp-js` reached v1.0.0 with the following stable behaviors:

- The SDK supports `plaintext` and `env://` secrets; `keychain://` and `file://` are parsed but throw `UnsupportedSecretSchemeError` at runtime.
- The client supports three protocols: `openai-chat-completions`, `openai-responses`, and `anthropic-messages`.
- Profile writes are atomic per file, with no backup or rollback.
- Secrets are redacted by default; resolving them requires explicit opt-in.

## Legacy `protocol` field

Older profiles may use a single `protocol` string:

```json
{
  "protocol": "openai-chat-completions"
}
```

This still works, but new profiles should prefer `protocols: [...]`:

```json
{
  "protocols": [
    { "id": "openai-chat-completions" }
  ]
}
```

The SDK picks the first supported entry in preference order.

## `lapp model set` preserves aliases

In v1.0.0, `lapp model set` no longer wipes user-curated aliases when `--alias` is omitted. It overlays only the fields you supply. To replace aliases explicitly, pass `--alias`.

## `lapp models sync` supports unauthenticated providers

`lapp models sync` now automatically passes `allowUnauthenticated: true`, so it works with local providers such as Ollama without extra flags.

## Error redaction

`err.raw` on chat/sync errors is deep-scrubbed for common key shapes. Tooling that relied on echoed credentials in error bodies will need updating.

## Known limitations

- `keychain://` and `file://` secret schemes are parsed but not resolved (only `plaintext` and `env://`).
- Capability inference for synced models is a best-effort heuristic (prefix + token match); providers that don't expose capability metadata can be augmented by editing `models.json` directly.
- `err.raw` on chat errors is deep-scrubbed for common key shapes, but providers that embed credentials in non-string fields are not protected.

See [CHANGELOG.md](../CHANGELOG.md) for the full release history.
