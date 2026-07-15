# Protocols

LAPP protocol IDs tell an application which upstream API contract a connection
uses. LAPP discovers and resolves that connection; it does not translate one
protocol into another.

## Selection

A provider declares an ordered string list:

```json
{
  "protocols": ["openai-responses", "openai-chat-completions"]
}
```

A model may declare a non-empty subset:

```json
{
  "id": "gpt-4o-mini",
  "protocols": ["openai-responses"]
}
```

`resolveConnection()` uses the model list when present, otherwise the provider
list. It selects the first candidate contained in the caller's
`supportedProtocols`; without that option it selects the first candidate.
No intersection produces `TargetResolutionError` with code
`PROTOCOL_NOT_SUPPORTED`.

Protocol entries are strings. Endpoint, authentication, and static headers are
provider-level fields.

## Bundled direct-call protocols

`createLappClient()` implements three chat protocols:

| Protocol | Request endpoint | Chat | Stream | Tools |
|----------|------------------|------|--------|-------|
| `openai-chat-completions` | `{baseUrl}/chat/completions` | yes | yes | yes |
| `openai-responses` | `{baseUrl}/responses` | yes | yes | yes |
| `anthropic-messages` | `{baseUrl}/v1/messages` | yes | yes | yes |

`baseUrl` is used as configured; OpenAI-compatible adapters do not insert
`/v1`. Endpoint paths are appended through URL pathname handling, so configured
query parameters remain intact. The Anthropic request uses `max_tokens: 4096` when the caller omits a
value and includes `anthropic-version: 2023-06-01`.

Authentication comes entirely from the provider's strict `auth` object. It is
not implied by a protocol ID.

Applications may store and resolve other valid protocol IDs. Pass the protocols
your application implements through `resolveConnection(..., { supportedProtocols })`.
The bundled client supplies its own three-protocol set and reports a typed
target/protocol error when no declared protocol is usable; it never guesses an
adapter.

## Model-discovery protocols

Model discovery is configured independently from connection protocols:

```json
{
  "modelDiscovery": {
    "protocol": "openai-models",
    "url": "https://api.example.com/v1/models"
  }
}
```

- **`openai-models`** requires
  `{ "data": [{ "id": "...", "name"?: "..." }] }` and has no pagination.
- **`anthropic-models`** requires
  `{ "data": [{ "id": "...", "display_name"?: "..." }], "has_more"?: boolean, "last_id"?: string }`
  and continues with `after_id=<last_id>`.

The SDK validates every page strictly. Malformed JSON, malformed entries,
duplicate IDs, non-advancing cursors, and HTTP errors fail the refresh without
changing the profile.

Discovery URL and `baseUrl` must have the same origin. Remote discovery uses
HTTPS; loopback may use HTTP. Credential-bearing requests use
`redirect: "error"`.

## Refresh semantics

`refreshModels()` returns a new in-memory profile and never writes disk. It:

- preserves current model order and fields;
- fills a missing display name when the remote directory provides one;
- appends previously unknown IDs in sorted order;
- never removes existing IDs;
- treats a valid empty list as no change.

The CLI mirrors this behavior with `lapp models refresh`; applying requires both
`--apply` and `--yes`.
