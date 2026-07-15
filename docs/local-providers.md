# Local providers

LAPP works with local servers that implement one of the declared connection
protocols. The bundled presets cover Ollama, LM Studio, and vLLM through their
OpenAI-compatible endpoints.

Loopback HTTP is allowed. Use `{ "type": "none" }` authentication only when the
local server genuinely requires no credential.

## Ollama

Start Ollama, then register and refresh it:

```bash
lapp provider add --id ollama --yes
lapp models refresh --provider ollama
lapp models refresh --provider ollama --apply --yes
lapp models list --provider ollama
```

Choose a returned model explicitly:

```bash
lapp default set --task chat --provider ollama --model <returned-id> --yes
lapp chat "Hello, Ollama" --default chat
```

The equivalent explicit provider command is:

```bash
lapp provider add \
  --id ollama \
  --protocol openai-chat-completions \
  --base-url http://localhost:11434/v1 \
  --no-auth \
  --models-protocol openai-models \
  --models-url http://localhost:11434/v1/models \
  --yes
```

## LM Studio

Enable its local API server, then run:

```bash
lapp provider add --id lm-studio --yes
lapp models refresh --provider lm-studio --apply --yes
lapp models list --provider lm-studio
lapp default set --task chat --provider lm-studio --model <returned-id> --yes
```

The preset uses `http://localhost:1234/v1`.

## vLLM

With vLLM listening on its usual port:

```bash
lapp provider add --id vllm --yes
lapp models refresh --provider vllm --apply --yes
lapp models list --provider vllm
lapp default set --task chat --provider vllm --model <returned-id> --yes
```

The preset uses `http://localhost:8000/v1`.

## SDK use

No special unauthenticated switch is needed. `auth.type: "none"` is the entire
policy:

```ts
import { createLappClient, loadProfile } from "@openlapp/lapp";

const profile = loadProfile();
const client = createLappClient({
  profile,
  provider: "ollama",
  model: "<returned-id>",
});

const response = await client.chat({
  messages: [{ role: "user", content: "Hello" }],
});
```

## Troubleshooting

- Refresh requires `modelDiscovery` in `provider.json`; presets configure it.
- The discovery URL and `baseUrl` must use the same origin.
- A valid empty remote list changes nothing.
- Existing local models and metadata are never removed or overwritten.
- If a server advertises incomplete capabilities, edit the authoritative
  `models.json` entry yourself.
