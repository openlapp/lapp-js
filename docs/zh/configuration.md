# 配置文件

LAPP 配置是一个目录树（通常命名为 `.lapp` 或 `~/.lapp`），用来描述提供者、模型、默认设置和元数据。

## 配置路径解析

SDK 和 CLI 按以下顺序解析配置根目录：

1. 显式传入的路径参数或 `path` 选项。
2. `LAPP_HOME` 环境变量。
3. `~/.lapp`。

你也可以调用 `resolveLappRoot()` 在不加载配置的情况下获取解析后的路径。

## `.lapp/` 目录结构

```text
~/.lapp/
├── manifest.json
├── global.json
├── providers/
│   ├── openai/
│   │   ├── provider.json
│   │   └── models.json
│   └── anthropic/
│       ├── provider.json
│       └── models.json
```

### `manifest.json`

配置版本和元数据。

```json
{
  "schemaVersion": "1.0.0",
  "name": "我的 LAPP 配置"
}
```

### `providers/<id>/provider.json`

提供者配置。

```json
{
  "schemaVersion": "1.0.0",
  "id": "openai",
  "protocol": "openai-chat-completions",
  "baseUrl": "https://api.openai.com/v1",
  "auth": {
    "secret": "env://OPENAI_API_KEY"
  }
}
```

### `providers/<id>/models.json`

每个提供者的模型列表。

```json
{
  "schemaVersion": "1.0.0",
  "models": [
    {
      "id": "gpt-4o",
      "aliases": ["gpt4o"],
      "type": "chat",
      "capabilities": ["text", "tools", "vision", "streaming"]
    }
  ]
}
```

### `global.json`

按任务类型的全局默认设置。

```json
{
  "schemaVersion": "1.0.0",
  "defaultModel": {
    "providerId": "openai",
    "model": "gpt-4o"
  }
}
```

## 提供者字段

### `protocol` 与 `protocols`

`protocol` 是旧版的单个协议字符串。新配置应优先使用 `protocols: [...]`，它是一个按偏好排序的列表，SDK 会选择第一个支持的条目。

```json
{
  "id": "openai",
  "protocols": [
    {
      "id": "openai-responses",
      "baseUrl": "https://api.openai.com/v1",
      "requestHeaders": { "OpenAI-Beta": "responses=v1" }
    },
    {
      "id": "openai-chat-completions",
      "baseUrl": "https://api.openai.com/v1"
    }
  ]
}
```

两者同时存在时，`protocols` 优先。

### `baseUrl`

- `baseUrl` 不应以 `/` 结尾，SDK 会发出警告。
- OpenAI 兼容适配器不会自动追加 `/v1`，需要时请直接写在 `baseUrl` 里。
- Anthropic 适配器仅当 `/v1` 是最后一个独立段时才会去重。

### `auth`

- `bearer`（默认）— 发送 `Authorization: Bearer <secret>`。
- `header` — 在自定义头中发送密钥。
- `queryParam` — 把密钥附加到查询字符串（并移除头认证，避免在 URL 和头中同时泄露）。
- `none` — 不发送认证头；与 `allowUnauthenticated` 配合用于本地提供者。

```json
{
  "auth": {
    "type": "header",
    "header": "X-Api-Key",
    "secret": "env://API_KEY"
  }
}
```

### `requestHeaders`

用户自定义的每个请求都会带上的头。认证相关头（`authorization`、`x-api-key`）会在适配器添加自己的认证前被大小写不敏感地移除，避免用户定义的 `X-Api-Key` 与适配器认证头冲突。

### `links.models`

为没有公开 `/models` 端点的协议覆盖模型列表 URL（例如 Anthropic）。

```json
{
  "links": {
    "models": "https://api.anthropic.com/v1/models"
  }
}
```

## 模型字段

| 字段 | 含义 |
|------|------|
| `id` | 模型标识符。 |
| `aliases` | 别名，可用于 `createLappClient({ model: "alias" })`。 |
| `type` | `chat`、`embedding`、`image`、`tts`、`video`。 |
| `capabilities` | 能力字符串数组，例如 `text`、`tools`、`vision`、`streaming`、`image-generation`。 |
| `inputModalities` / `outputModalities` | 可选的模态列表。 |
| `contextWindow` / `maxOutputTokens` | 可选的模型限制。 |
| `enabled` | `false` 会保留条目但跳过运行时选择。 |
| `source` | `provider`（来自同步）或 `manual`（用户添加）。 |

## 全局默认

五个默认槽位对应 CLI 的 `--kind`：

| CLI `--kind` | 全局槽位 |
|--------------|----------|
| `chat` | `defaultModel` |
| `embedding` | `defaultEmbeddingModel` |
| `image` | `defaultImageModel` |
| `tts` | `defaultTextToSpeechModel` |
| `video` | `defaultVideoModel` |

## 禁用条目

`enabled: false` 的提供者或模型会保留在内存配置中，以便写回时还原磁盘文件。它们会被以下功能跳过：

- `createLappClient` 目标解析
- `exportEnv`
- `listModels`（除非设置 `includeDisabled` / `includeDisabledModels`）

## JSON 与 JSONC

- SDK 读取 `.json` 和 `.jsonc` 文件。
- 新文件以 `.json` 写入。
- v1 不保留注释。

## 原子写入

`writeProfileAtomic` 对每个文件遵循以下规则：

1. 在内存中构建完整内容。
2. 写入前验证。
3. 写到目标文件同目录的隐藏临时文件。
4. 关闭临时文件。
5. 通过重命名覆盖目标文件。
6. 失败时仅删除临时文件。

这是崩溃安全保证，不是备份系统。没有备份、没有回滚、没有临时目录。

## 多协议示例

```json
{
  "schemaVersion": "1.0.0",
  "id": "openai",
  "protocols": [
    {
      "id": "openai-responses",
      "baseUrl": "https://api.openai.com/v1"
    },
    {
      "id": "openai-chat-completions",
      "baseUrl": "https://api.openai.com/v1"
    }
  ],
  "baseUrl": "https://api.openai.com/v1",
  "auth": {
    "secret": "env://OPENAI_API_KEY"
  }
}
```

SDK 会优先尝试 `openai-responses`，不支持时再回退到 `openai-chat-completions`。
