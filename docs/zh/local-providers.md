# 本地提供者

`lapp-js` 支持任何 OpenAI 兼容的本地服务器。本指南覆盖 Ollama、LM Studio 和 vLLM。

## 为什么需要 `allowUnauthenticated`？

本地服务器通常不需要 API key。`allowUnauthenticated: true` 告诉 SDK 跳过认证头。其他解析错误仍会快速失败。

CLI 中使用 `--no-auth` 创建或添加提供者。

## Ollama

添加指向 Ollama 的 OpenAI 兼容端点的提供者（`ollama` 预设补好协议和地址，`--no-auth` 隐含）：

```bash
lapp provider add --id ollama --yes
```

或完全显式：

```bash
lapp provider add --id ollama \
  --protocol openai-chat-completions \
  --base-url http://localhost:11434/v1 \
  --no-auth --yes
```

一步拉取模型列表并把首个 chat 模型设为默认：

```bash
lapp models sync --provider ollama --apply --set-default --yes
```

聊天（`lapp chat`/`lapp ping` 对免认证提供者自动放行）：

```bash
lapp chat "你好，Ollama。"
lapp chat ollama/llama3 "你好，Ollama。"
```

Ollama 返回 `name` 字段，除 `id` 外 `name` 也被接受。

## LM Studio

LM Studio 的 OpenAI 兼容服务器通常运行在 `1234` 端口。用 `lm-studio` 预设：

```bash
lapp provider add --id lm-studio --yes
lapp models sync --provider lm-studio --apply --set-default --yes
```

或完全显式（已知模型 id 时）：

```bash
lapp provider add \
  --id lm-studio \
  --protocol openai-chat-completions \
  --base-url http://localhost:1234/v1 \
  --no-auth --model local-model --yes
```

## vLLM

vLLM 的 OpenAI 兼容服务器通常运行在 `8000` 端口。用 `vllm` 预设：

```bash
lapp provider add --id vllm --yes
lapp models sync --provider vllm --apply --set-default --yes
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
- `lapp chat` 和 `lapp ping` 对 `auth.type: "none"` / 无密钥的提供者自动放行，本地流程无需额外参数。
- CLI 的 `lapp models sync` 会自动传入 `allowUnauthenticated: true`，本地提供者无需额外参数。
- 本地模型同步时的能力推断是尽力而为的。如果提供者未 advertise 能力，可手动编辑 `models.json` 补充。

协议详情见 [protocols.md](protocols.md)，安全建议见 [security.md](security.md)。
