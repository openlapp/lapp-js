# Migrating

This document tracks behavioral changes and migration notes for `lapp-js` users.

## `lapp init` removed — use `lapp provider add`

The `lapp init` command was removed. `lapp provider add` now absorbs its capabilities: it auto-creates `manifest.json` on a fresh root, accepts `--model` to add a model and set the chat default in one command, and gains `--force` to reset an existing populated profile to just the new provider.

```bash
# before
lapp init ~/.lapp --provider openai --protocol openai-chat-completions \
  --base-url https://api.openai.com/v1 --secret env://OPENAI_API_KEY --model gpt-4o --yes
# after (preset — protocol/base-url/secret filled automatically)
lapp provider add --id openai --model gpt-4o --yes
# after (explicit)
lapp provider add --id openai --protocol openai-chat-completions \
  --base-url https://api.openai.com/v1 --secret env://OPENAI_API_KEY --model gpt-4o --yes
```

Other changes in this release:

- **Provider presets**: `lapp provider add --id <preset>` (openai, anthropic, deepseek, openrouter, ollama, lm-studio, vllm, kimi, minimax, siliconflow) fills protocol/baseUrl/auth. `lapp presets` lists them. Presets are CLI-only; the SDK stays preset-agnostic.
- **Multi-protocol CLI**: repeatable `--protocol`, `--protocol-base-url`, `--protocol-header` (docker-`--build-arg` style) now express the full `protocols[]` shape from the CLI.
- **More SDK fields reachable**: provider `--name`/`--header`/`--link`/`--auth-type`/`--auth-header`/`--auth-query-param`; model `--capability`/`--input-modality`/`--output-modality`/`--context-window`/`--max-output-tokens`/`--model-protocol`/`--link`/`--metadata`/`--metadata-json`/`--enabled`/`--disabled`.
- **`lapp models list`** is now documented (it existed but was missing from `--help`).
- **`lapp models sync --set-default`** sets the first synced model of a kind as the global default after applying.
- **Bug fixes**: `lapp chat`/`ping` no longer throw on `--no-auth` providers (auto `allowUnauthenticated`); `lapp chat` no longer misroutes one-word slash messages like `2/3` as targets; `maybeWrite` now exits non-zero when `--yes` is omitted but there are changes (was exit 0).
- **`provider add` auto-creates `manifest.json`** on a fresh root (previously only `init` did).

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
