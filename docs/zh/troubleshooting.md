# 故障排除

首先从 `lapp doctor` 开始。它会验证配置并检查每个启用的提供者是否能成功创建客户端。

```bash
lapp doctor
```

## 类型化错误

| 错误 | 含义 | 解决方法 |
|------|------|----------|
| `TargetResolutionError` | 找不到请求的提供者/模型、所有提供者被禁用、或匹配提供者没有启用模型。 | 检查提供者/模型 id，确保目标已启用，或设置全局默认。 |
| `UnsupportedProtocolError` | 提供者的协议不是三个 v1 核心协议之一。 | 使用 `openai-chat-completions`、`openai-responses` 或 `anthropic-messages`。 |
| `MissingEnvSecretError` | 使用了 `env://NAME` 但 `process.env[NAME]` 未设置。 | 导出该变量，或通过 `createLappClient({ env: { ... } })` 传入。 |
| `UnsupportedSecretSchemeError` | 使用了 `keychain://` 或 `file://`。v1 会解析但不会解析出值。 | 改用 `env://` 或 `plaintext`。 |
| `ModelSyncUnsupportedError` | 对没有公开模型列表的协议执行同步。 | Anthropic 需设置 `provider.links.models`。 |
| `StreamingUnsupportedError` | 协议适配器没有流式解析器。 | 使用非流式 `chat()`，或确认该协议支持流式。 |

## 常见警告

### “No JSON schemas could be loaded”（无法加载 JSON Schema）

SDK 找不到 LAPP JSON Schema，结构验证未执行。请检查 `packages/lapp/schema/` 是否包含 schema 文件（它们在构建时复制）。

### `baseUrl` 以 `/` 结尾

SDK 会警告 `baseUrl` 末尾的 `/`。请移除末尾斜杠。

### `keychain://` 或 `file://` 密钥方案

这些方案会被解析但运行时会抛出错误。生产环境请使用 `env://`。

## 常见问题

### 为什么我设置的 `X-Api-Key` 请求头消失了？

认证相关头（`authorization`、`x-api-key`）会在适配器添加自己的认证前被大小写不敏感地移除。`requestHeaders` 只应包含非认证头；认证请通过 `auth` 配置。

### 为什么 `lapp chat` 输出的模型 id 和配置里不一样？

你可能使用了模型别名。别名在运行时会解析为真实模型 id。

### 为什么我手动编辑后 `models.json` 的 `updatedAt` 总在变？

`applySyncedModels` 会用内部来源标记同步条目。写入器仅在该标记存在时才会重新生成 `updatedAt`。通过 `upsertModel`/`removeModel` 进行的手动编辑会清除该标记。

### 我能把 `lapp-js` 当作代理或网关使用吗？

不能。`lapp-js` 是客户端库和 CLI。它从你的进程直接向提供者发送请求，不运行持久化服务器，也不为其他应用代理流量。

### 在哪里报告问题？

在 [lapp-js 仓库](https://github.com/openlapp/lapp-js) 提交 issue，并附上 `lapp doctor` 的输出。

## 另见

- [安全说明](security.md)
- [配置文件](configuration.md)
- [协议说明](protocols.md)
- [本地提供者](local-providers.md)
