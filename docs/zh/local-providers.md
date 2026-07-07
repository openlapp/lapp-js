# 本地提供者

`lapp-js` 支持任何 OpenAI 兼容的本地服务器。本指南覆盖 Ollama、LM Studio 和 vLLM。

## 为什么需要 `allowUnauthenticated`？

本地服务器通常不需要 API key。`allowUnauthenticated: true` 告诉 SDK 跳过认证头。其他解析错误仍会快速失败。

CLI 中使用 `--no-auth` 创建或添加提供者。

## Ollama

指向 Ollama 的 OpenAI 兼容端点初始化配置：

```bash
lapp init ~/.lapp \
  --provider ollama \
  --protocol openai-chat-completions \
  --base-url http://localhost:11434/v1 \
  --no-auth \
  --model llama3 \
  --yes
```

聊天：

```bash
lapp chat "你好，Ollama。"
lapp chat ollama/llama3 "你好，Ollama。"
```

同步模型列表：

```bash
lapp models sync ~/.lapp --provider ollama --apply --yes
```

Ollama 返回 `name` 字段，除 `id` 外 `name` 也被接受。

## LM Studio

LM Studio 的 OpenAI 兼容服务器通常运行在 `1234` 端口：

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

vLLM 的 OpenAI 兼容服务器通常运行在 `8000` 端口：

```bash
lapp provider add \
  --id vllm \
  --protocol openai-chat-completions \
  --base-url http://localhost:8000/v1 \
  --no-auth \
  --yes

lapp models sync --provider vllm --apply --yes
```

## SDK 示例

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
  messages: [{ role: "user", content: "你好！" }],
});
console.log(resp.text);
```

## 注意事项

- 即使启用 `allowUnauthenticated`，其他解析错误仍会快速失败。
- 本地提供者不需要认证，因此 `lapp init` 和 `lapp provider add` 时必须使用 `--no-auth`；CLI 的 `lapp models sync` 会自动传入 `allowUnauthenticated: true`。
- 本地模型同步时的能力推断是尽力而为的。如果提供者未 advertise 能力，可手动编辑 `models.json` 补充。

协议详情见 [protocols.md](protocols.md)，安全建议见 [security.md](security.md)。
