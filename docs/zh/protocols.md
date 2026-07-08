# 协议说明

`lapp-js` v1 支持三种提供者协议。每种协议对应一个适配器，负责构建提供者原生请求并将响应归一化。

## 支持的协议

| 协议 | 聊天 | 流式 | 工具调用 | 模型列表同步 |
| --- | --- | --- | --- | --- |
| `openai-chat-completions` | 是 | 是 | 是 | 是（`GET /models`） |
| `openai-responses` | 是 | 是 | 是 | 是（`GET /models`） |
| `anthropic-messages` | 是 | 是 | 是 | 没有公开 API；可设置 `provider.links.models` 覆盖 |

## `openai-chat-completions`

向 `{baseUrl}/chat/completions` 发送 POST 请求，并在 `Authorization` 头中携带 bearer token。

- SDK 不会自动追加 `/v1`。如果需要，请直接写在 `baseUrl` 中。
- 模型同步使用 `GET {baseUrl}/models`。
- 兼容任何 OpenAI 兼容服务器，包括 Ollama、LM Studio、vLLM 等。

## `openai-responses`

将简单聊天输入映射到 OpenAI Responses API。

- 向 `{baseUrl}/responses` 发送 POST 请求。
- v1.0.0 保留 `assistant` 历史消息为 `assistant`（不会重映射为 `developer`）。
- 模型同步使用 `GET {baseUrl}/models`。

## `anthropic-messages`

将聊天消息映射到 Anthropic Messages API。

- 向 `{baseUrl}/v1/messages` 发送 POST 请求，并携带 `x-api-key` 和 `anthropic-version` 头。
- 适配器仅当 `/v1` 是最后一个独立段时才会对 `baseUrl` 末尾的 `/v1` 去重。
- 没有公开的模型列表端点；设置 `provider.links.models` 后可启用同步。

## 能力推断

从提供者同步模型时，能力基于模型 id 前缀和关键词进行尽力而为的启发式推断。例如，id 中包含 `vision` 的模型可能会被赋予 `vision` 能力。

不暴露能力元数据的提供者可以在同步后直接编辑 `models.json` 来补充能力。

## 多协议提供者

一个提供者可以按偏好顺序声明多个协议：

```json
{
  "id": "openai",
  "protocols": [
    { "id": "openai-responses", "baseUrl": "https://api.openai.com/v1" },
    { "id": "openai-chat-completions", "baseUrl": "https://api.openai.com/v1" }
  ]
}
```

SDK 选择第一个支持的条目。每个协议级别的 `baseUrl` 和 `requestHeaders` 会合并到提供者级别值之上。

## 本地 / 自托管提供者

任何使用 OpenAI 兼容端点的协议都可以用于本地服务器。典型配置：

```json
{
  "id": "ollama",
  "protocol": "openai-chat-completions",
  "baseUrl": "http://localhost:11434/v1",
  "auth": { "type": "none" }
}
```

CLI 中使用 `lapp provider add` 时加 `--no-auth`（或用 `ollama`/`lm-studio`/`vllm` 预设,它们自动设好）。分步示例见 [local-providers.md](local-providers.md)。

## 不支持的协议

如果提供者的协议不受支持，SDK 会抛出 `UnsupportedProtocolError`。运行时可用 `isSupportedProtocol(protocol)` 检查。
