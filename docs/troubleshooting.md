# Troubleshooting

Start with `lapp doctor`. It validates the profile and checks that every enabled provider can be turned into a client.

```bash
lapp doctor
```

## Typed errors

| Error | Meaning | Fix |
|-------|---------|-----|
| `TargetResolutionError` | The requested provider/model was not found, all providers are disabled, or the matched provider has no enabled models. | Check provider/model ids, ensure the target is enabled, or set a global default. |
| `UnsupportedProtocolError` | The provider's protocol is not one of the three v1 core protocols. | Use `openai-chat-completions`, `openai-responses`, or `anthropic-messages`. |
| `MissingEnvSecretError` | An `env://NAME` secret was used but `process.env[NAME]` is unset. | Export the variable or pass it via `createLappClient({ env: { ... } })`. |
| `UnsupportedSecretSchemeError` | `keychain://` or `file://` was used. These schemes are parsed but not resolved in v1. | Switch to `env://` or `plaintext`. |
| `ModelSyncUnsupportedError` | Model sync was attempted for a protocol without a public model list. | For Anthropic, set `provider.links.models`. |
| `StreamingUnsupportedError` | The protocol adapter has no streaming parser. | Use the non-streaming `chat()` path, or check that the protocol supports streaming. |

## Common warnings

### "No JSON schemas could be loaded"

The SDK could not find the LAPP JSON Schemas. Structural validation did not run. Check that `packages/lapp/schema/` contains the schema files (they are copied at build time).

### `baseUrl` ends with `/`

The SDK warns when a provider `baseUrl` ends with `/`. Remove the trailing slash.

### `keychain://` or `file://` secret scheme

These schemes are parsed but throw at runtime. Use `env://` for production keys.

## FAQ

### Why does my `X-Api-Key` request header disappear?

Auth-carrying headers (`authorization`, `x-api-key`) are stripped case-insensitively from user `requestHeaders` before the adapter adds its own. Use `requestHeaders` only for non-auth headers; configure auth through `auth`.

### Why does `lapp chat` print a different model id than my config?

You may be using a model alias. Aliases resolve to the real model id at runtime.

### Why does `models.json` keep changing after I edit it?

`applySyncedModels` marks synced entries with an internal source marker. The writer re-stamps `updatedAt` only when that marker is present. Manual edits through `upsertModel`/`removeModel` clear the marker.

### Can I use `lapp-js` as a proxy or gateway?

No. `lapp-js` is a client library and CLI. It sends requests directly from your process to the provider. It does not run a persistent server or proxy traffic for other apps.

### Where do I report bugs?

Open an issue in the [lapp-js repository](https://github.com/openlapp/lapp-js) with the output of `lapp doctor`.

## See also

- [Security](security.md)
- [Configuration](configuration.md)
- [Protocols](protocols.md)
- [Local providers](local-providers.md)
