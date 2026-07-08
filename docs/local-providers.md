# Local providers

`lapp-js` works with any OpenAI-compatible local server. This guide covers Ollama, LM Studio, and vLLM.

## Why `allowUnauthenticated`?

Local servers usually do not require an API key. `allowUnauthenticated: true` tells the SDK to skip the auth header. The SDK still fails fast on other resolve errors.

In the CLI, use `--no-auth` when creating or adding a provider.

## Ollama

Add a provider pointing at Ollama's OpenAI-compatible endpoint (the `ollama` preset fills in the protocol and base URL; `--no-auth` is implied):

```bash
lapp provider add --id ollama --yes
```

Or fully explicit:

```bash
lapp provider add --id ollama \
  --protocol openai-chat-completions \
  --base-url http://localhost:11434/v1 \
  --no-auth --yes
```

Pull the model list and set the first chat model as the default in one go:

```bash
lapp models sync --provider ollama --apply --set-default --yes
```

Chat (no-auth providers are auto-allowed by `lapp chat` / `lapp ping`):

```bash
lapp chat "Hello, Ollama."
lapp chat ollama/llama3 "Hello, Ollama."
```

Ollama returns `name` in addition to `id`; both are accepted.

## LM Studio

LM Studio exposes an OpenAI-compatible server on a local port (often `1234`). Use the `lm-studio` preset:

```bash
lapp provider add --id lm-studio --yes
lapp models sync --provider lm-studio --apply --set-default --yes
```

Or fully explicit (with a known model id):

```bash
lapp provider add \
  --id lm-studio \
  --protocol openai-chat-completions \
  --base-url http://localhost:1234/v1 \
  --no-auth --model local-model --yes
```

## vLLM

vLLM's OpenAI-compatible server typically runs on port `8000`. Use the `vllm` preset:

```bash
lapp provider add --id vllm --yes
lapp models sync --provider vllm --apply --set-default --yes
```

## SDK example

```ts
import { loadProfile, createLappClient } from "@openlapp/lapp";

const profile = loadProfile();
const client = createLappClient({
  profile,
  provider: "ollama",
  model: "llama3",
  allowUnauthenticated: true,
});

const resp = await client.chat({
  messages: [{ role: "user", content: "Hello!" }],
});
console.log(resp.text);
```

## Caveats

- The SDK still fails fast on other resolve errors even with `allowUnauthenticated`.
- `lapp chat` and `lapp ping` auto-allow-unauthenticated for providers with `auth.type: "none"` / no secret, so the local flow works without extra flags.
- The CLI automatically passes `allowUnauthenticated: true` during `lapp models sync` so local providers work without extra flags.
- Capability inference for synced local models is best-effort. Edit `models.json` directly to add capabilities the provider does not advertise.

For protocol details, see [protocols.md](protocols.md). For security guidance, see [security.md](security.md).
