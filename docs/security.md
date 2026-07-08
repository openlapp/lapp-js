# Security

`lapp-js` is designed around a simple principle: secrets should only move when you explicitly ask them to.

## Supported secret schemes

v1 supports two schemes for runtime resolution:

| Scheme | Example | Recommended? |
|--------|---------|--------------|
| `plaintext` | `"sk-..."` | No — leaves the key on disk. |
| `env://` | `"env://OPENAI_API_KEY"` | Yes — keeps the key out of the profile. |

Two additional schemes are parsed but throw `UnsupportedSecretSchemeError` at runtime:

- `keychain://`
- `file://`

## Display policy

Secrets are redacted by default in every SDK and CLI path that prints profile contents:

- `lapp inspect`
- `validateProfile` diagnostics
- `inspectProfile` summaries
- CLI error output (defense-in-depth regex scrubbing)

To reveal secrets, pass `revealSecrets: true` to `inspectProfile` or `--reveal-secrets` to the CLI. Do this only in trusted environments.

The model's reply in `lapp chat` is printed verbatim. Re-running redaction over provider text would mangle legitimate key-shaped content (for example, the model explaining what an API key looks like), so it is deliberately not applied there.

## Resolution policy

The SDK **never** reads `process.env` unless you explicitly opt in.

```ts
const client = createLappClient({ profile, resolveSecrets: true });
```

```bash
lapp env --format bash --resolve
```

The client fails fast on unresolved secrets. It never substitutes a placeholder or empty string.

## Env-export policy

`exportEnv` (and `lapp env`) requires two separate opt-ins to emit plaintext or resolved values:

- `resolve: true` — read `env://` values from `process.env`.
- `allowPlaintext: true` — include plaintext secrets in the output.

Without `allowPlaintext`, plaintext entries are omitted. Without `resolve`, `env://` entries are emitted as literal references.

```ts
const out = exportEnv(profile, {
  format: "bash",
  resolve: true,
  allowPlaintext: false,
});
```

## Error redaction

When a chat or sync request throws, `err.raw` is deep-scrubbed on string leaves using a shared set of secret patterns (OpenAI/Anthropic-style keys, OpenRouter, GitHub tokens, xAI, Google, and generic `Bearer ...` strings).

Caveat: providers that embed credentials in non-string fields are not protected. This is a v1 known limitation.

## Auth-header deduplication

Adapters strip auth-carrying keys (`authorization`, `x-api-key`) from user-supplied `requestHeaders` case-insensitively before adding their own. This prevents a user-supplied `X-Api-Key` header from colliding with the adapter's auth header.

When `auth.queryParam` is set, the client strips header auth entirely so the secret does not leak in both the URL and headers.

## Unauthenticated providers

Local/self-hosted providers such as Ollama, LM Studio, and vLLM usually do not require auth. Use `allowUnauthenticated: true` in the SDK or `--no-auth` in the CLI:

```ts
const client = createLappClient({
  profile,
  provider: "ollama",
  model: "llama3",
  allowUnauthenticated: true,
});
```

```bash
lapp provider add --id ollama --yes
```

`allowUnauthenticated` skips the auth header but still fails fast on other resolve errors. The CLI auto-allow-unauthenticated for `lapp chat` / `lapp ping` against such providers.

## Practical recommendations

- Use `env://` for every real key.
- Do not commit `.lapp` profiles that contain `plaintext` secrets.
- Run `lapp doctor` after any auth-related change.
- Treat `--reveal-secrets` and `--allow-plaintext` as privileged operations.
- Keep provider `baseUrl` values stable; rotating secrets should only require changing the environment variable.
