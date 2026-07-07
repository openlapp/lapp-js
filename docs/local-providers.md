# Local providers

`lapp-js` works with any OpenAI-compatible local server. This guide covers Ollama, LM Studio, and vLLM.

## Why `allowUnauthenticated`?

Local servers usually do not require an API key. `allowUnauthenticated: true` tells the SDK to skip the auth header. The SDK still fails fast on other resolve errors.

In the CLI, use `--no-auth` when creating or adding a provider.

## Ollama

Initialize a profile pointing at Ollama's OpenAI-compatible endpoint:

```bash
lapp init ~/.lapp \
  --provider ollama \
  --protocol openai-chat-completions \
  --base-url http://localhost:11434/v1 \
  --no-auth \
  --model llama3 \
  --yes
```

Chat:

```bash
lapp chat "Hello, Ollama."
lapp chat ollama/llama3 "Hello, Ollama."
```

Sync the model list:

```bash
lapp models sync ~/.lapp --provider ollama --apply --yes
```

Ollama returns `name` in addition to `id`; both are accepted.

## LM Studio

LM Studio exposes an OpenAI-compatible server on a local port (often `1234`):

```bash
lapp provider add \
  --id lm-studio \
  --protocol openai-chat-completions \
  --base-url http://localhost:1234/v1 \
  --no-auth \
  --yes

lapp model add --provider lm-studio --id local-model --type chat --yes
lapp default set --provider lm-studio --model local-model --kind chat --yes
```

## vLLM

vLLM's OpenAI-compatible server typically runs on port `8000`:

```bash
lapp provider add \
  --id vllm \
  --protocol openai-chat-completions \
  --base-url http://localhost:8000/v1 \
  --no-auth \
  --yes

lapp models sync --provider vllm --apply --yes
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
- The CLI automatically passes `allowUnauthenticated: true` during `lapp models sync` so local providers work without extra flags.
- Capability inference for synced local models is best-effort. Edit `models.json` directly to add capabilities the provider does not advertise.

For protocol details, see [protocols.md](protocols.md). For security guidance, see [security.md](security.md).
