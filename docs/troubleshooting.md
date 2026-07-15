# Troubleshooting

Start with validation and redacted inspection:

```bash
lapp validate
lapp inspect
```

Use `--json` when another program needs to consume the result.

## Typed errors

| Error | Meaning | Fix |
|-------|---------|-----|
| `ProfileValidationError` | The JSON tree failed structural or semantic validation. | Run `lapp inspect`, then fix each ERROR diagnostic. |
| `TargetResolutionError` | A provider, model, alias, default, enabled state, or protocol intersection could not be resolved. | Inspect the error `code`; verify canonical IDs, enabled flags, defaults, and supported protocols. |
| `MissingEnvSecretError` / `ENV_SECRET_MISSING` | An `env://NAME` value is absent. | Export it or pass an explicit SDK environment map. |
| `CredentialError` | A secret reference, Vault backend, record, permission, or binding failed. | Inspect its stable `code`; use `credential status`, then restore or explicitly replace the credential. |
| `ModelRefreshError` | Discovery is not configured or returned an HTTP, shape, or pagination error. | Check `modelDiscovery`, endpoint origin, credentials, and the remote response. |
| `StreamingUnsupportedError` | The selected direct-call adapter cannot stream. | Use `chat()` or select a streaming-capable protocol. |

`TargetResolutionError.code` is one of `PROVIDER_NOT_FOUND`,
`PROVIDER_DISABLED`, `MODEL_NOT_FOUND`, `MODEL_DISABLED`, `MODEL_AMBIGUOUS`,
`DEFAULT_NOT_FOUND`, or `PROTOCOL_NOT_SUPPORTED`.

`ModelRefreshError.code` is one of `DISCOVERY_NOT_CONFIGURED`,
`INVALID_RESPONSE`, `HTTP_ERROR`, or `PAGINATION_ERROR`.

## Schema snapshot errors

If the SDK reports that a LAPP Schema is missing or not registered, check that
the versioned snapshot is present in `packages/lapp/schema/`; restore it from
version control if it was removed. `pnpm verify:spec` checks that snapshot
against the pinned canonical spec commit.

## Profile will not load

- Files must be standard JSON named `provider.json`, `models.json`, and
  `global.json`.
- Every present file must use `"schemaVersion": "1.0"`.
- The provider directory name must equal its provider ID.
- Core objects reject unknown fields; move implementation data to `extensions`.
- Run `lapp inspect --json` to see partial, redacted diagnostics even when
  `loadProfile()` cannot return a valid profile.

## Model refresh fails

Check all of the following:

1. `provider.json` contains `modelDiscovery.protocol` and an absolute URL.
2. The discovery URL and `baseUrl` have the same origin.
3. Remote URLs use HTTPS, or the endpoint is loopback HTTP.
4. The selected environment or Vault credential is available and still matches
   the provider ID, origin, and authentication shape.
5. The response matches the configured discovery protocol.

A malformed HTTP 200 response is an error, not an empty model directory. A
valid empty list leaves the profile unchanged.

## A remote model did not disappear locally

This is intentional. `models.json` is authoritative, and refresh never removes
local entries. Remove the model explicitly after confirming it is no longer
needed.

## Existing model metadata did not update

Refresh preserves local fields. It only appends unknown IDs and may fill a
currently missing display name. Edit `models.json` or use `lapp model set` for
deliberate local changes.

## A model alias resolves unexpectedly

IDs and aliases must be unique within a provider. Validation rejects ambiguity.
Defaults always store canonical model IDs, so inspect `global.json` when a
default points somewhere unexpected.

## Authentication problems

- Use exactly one valid `auth` variant: `none`, `bearer`, `header`, or `query`.
- Custom header/query auth uses `name`, not another field spelling.
- Only plaintext, `env://NAME`, and `vault://provider/credential` secrets are
  accepted. `keychain://`, `file://`, and unknown schemes are invalid.
- Static `requestHeaders` cannot carry authentication or cookies.
- `lapp resolve --default chat --json` shows scheme and credential status but
  never the secret. The CLI has no reveal or export command.
- `VAULT_BINDING_MISMATCH` means the provider ID, normalized origin, auth type,
  or auth name changed. Re-enter the credential with `credential set
  --overwrite`; LAPP never rebinds it automatically.
- `VAULT_BACKEND_UNAVAILABLE` means the native module or OS credential service
  is unavailable. There is no plaintext or file fallback.

## Reporting a bug

Open an issue in the [lapp-js repository](https://github.com/openlapp/lapp-js)
with the command, exit code, redacted `lapp inspect --json` output, and a minimal
profile that contains no plaintext credential.

## See also

- [Configuration](configuration.md)
- [Security](security.md)
- [Protocols](protocols.md)
- [Local providers](local-providers.md)
