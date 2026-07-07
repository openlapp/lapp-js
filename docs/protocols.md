# Protocols

`lapp-js` supports three provider protocols in v1. Each maps to a protocol adapter that builds provider-native requests and normalizes responses.

## Supported protocols

| Protocol | Chat | Stream | Tool calls | Model-list sync |
| --- | --- | --- | --- | --- |
| `openai-chat-completions` | yes | yes | yes | yes (`GET /models`) |
| `openai-responses` | yes | yes | yes | yes (`GET /models`) |
| `anthropic-messages` | yes | yes | yes | no public API; set `provider.links.models` to override |

## `openai-chat-completions`

Posts to `{baseUrl}/chat/completions` with a bearer token in the `Authorization` header.

- The SDK never auto-appends `/v1`. Include it in `baseUrl` if your provider needs it.
- Model sync uses `GET {baseUrl}/models`.
- Works with any OpenAI-compatible server, including Ollama, LM Studio, and vLLM.

## `openai-responses`

Maps simple chat input to the OpenAI Responses API.

- Posts to `{baseUrl}/responses`.
- v1.0.0 preserves `assistant` history as `assistant` (not remapped to `developer`).
- Model sync uses `GET {baseUrl}/models`.

## `anthropic-messages`

Maps chat messages to the Anthropic Messages API.

- Posts to `{baseUrl}/v1/messages` with `x-api-key` and `anthropic-version` headers.
- The adapter dedups a trailing `/v1` from `baseUrl` only when it is the sole last segment.
- There is no public model-list endpoint; set `provider.links.models` to enable sync.

## Capability inference

When syncing models from a provider, capabilities are inferred with a best-effort heuristic based on model id prefixes and token matches. For example, a model whose id contains `vision` may receive the `vision` capability.

Providers that do not expose capability metadata can be augmented by editing `models.json` directly after syncing.

## Multi-protocol providers

A provider can declare multiple protocols in preference order:

```json
{
  "id": "openai",
  "protocols": [
    { "id": "openai-responses", "baseUrl": "https://api.openai.com/v1" },
    { "id": "openai-chat-completions", "baseUrl": "https://api.openai.com/v1" }
  ]
}
```

The SDK picks the first supported entry. Per-protocol `baseUrl` and `requestHeaders` are merged over provider-level values.

## Local / self-hosted providers

Any protocol that posts to an OpenAI-compatible endpoint works against local servers. The typical setup is:

```json
{
  "id": "ollama",
  "protocol": "openai-chat-completions",
  "baseUrl": "http://localhost:11434/v1",
  "auth": { "type": "none" }
}
```

In the CLI, use `--no-auth` with `lapp init` or `lapp provider add`. See [local-providers.md](local-providers.md) for step-by-step examples.

## Unsupported protocols

If a provider's protocol is not supported, the SDK throws `UnsupportedProtocolError`. Use `isSupportedProtocol(protocol)` to check at runtime.
