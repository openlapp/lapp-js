# 协议

LAPP 协议 ID 告诉应用某个连接使用哪种上游 API 合同。LAPP 负责发现和解析连接，
不把一种协议转换为另一种。

## 选择规则

Provider 声明有序字符串列表：

```json
{
  "protocols": ["openai-responses", "openai-chat-completions"]
}
```

模型可以声明一个非空子集：

```json
{
  "id": "gpt-4o-mini",
  "protocols": ["openai-responses"]
}
```

`resolveConnection()` 优先使用模型列表，否则使用 Provider 列表。它选择第一个
包含在调用方 `supportedProtocols` 中的候选项；没有该选项时选择第一个候选项。
没有交集时抛出 code 为 `PROTOCOL_NOT_SUPPORTED` 的
`TargetResolutionError`。

协议项只是字符串。地址、认证和静态请求头都是 Provider 级字段。

## 内置直连协议

`createLappClient()` 实现三种聊天协议：

| 协议 | 请求地址 | 聊天 | 流式 | 工具 |
|------|----------|------|------|------|
| `openai-chat-completions` | `{baseUrl}/chat/completions` | 是 | 是 | 是 |
| `openai-responses` | `{baseUrl}/responses` | 是 | 是 | 是 |
| `anthropic-messages` | `{baseUrl}/v1/messages` | 是 | 是 | 是 |

`baseUrl` 按配置使用；OpenAI-compatible adapter 不会自动插入 `/v1`。Endpoint
通过 URL pathname 追加，因此配置中的 query 参数会保留。调用者未提供
值时，Anthropic 请求使用 `max_tokens: 4096`，并包含
`anthropic-version: 2023-06-01`。

认证完全来自 Provider 的严格 `auth` 对象，不由协议 ID 隐式决定。

应用可以保存和解析其他合法协议 ID。将应用实现的协议通过
`resolveConnection(..., { supportedProtocols })` 传入。内置客户端会传入自己的三协议
集合；没有可用交集时返回类型化的目标/协议错误，不会猜测 adapter。

## 模型发现协议

模型发现独立于连接协议配置：

```json
{
  "modelDiscovery": {
    "protocol": "openai-models",
    "url": "https://api.example.com/v1/models"
  }
}
```

- **`openai-models`** 要求响应
  `{ "data": [{ "id": "...", "name"?: "..." }] }`，不分页。
- **`anthropic-models`** 要求响应
  `{ "data": [{ "id": "...", "display_name"?: "..." }], "has_more"?: boolean, "last_id"?: string }`，
  并使用 `after_id=<last_id>` 继续分页。

SDK 会严格验证每一页。非法 JSON、非法条目、重复 ID、不前进的 cursor 和 HTTP
错误都会让刷新失败，Profile 保持不变。

发现 URL 必须与 `baseUrl` 同源。远端发现使用 HTTPS，loopback 可以使用 HTTP。
携带凭据的请求使用 `redirect: "error"`。

## 刷新语义

`refreshModels()` 返回新的内存 Profile，绝不自行写盘。它会：

- 保留现有模型顺序和字段；
- 在远端目录提供名称时补充当前缺失的显示名称；
- 按 ID 排序追加之前未知的模型；
- 永不删除已有 ID；
- 将合法空列表视为无变化。

CLI 的 `lapp models refresh` 采用相同行为；只有同时使用 `--apply` 和 `--yes`
才会写盘。
