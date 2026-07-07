# CLI 参考

`lapp` 是 LAPP 的命令行接口。它是 `@openlapp/lapp` 的轻量级包装：所有配置逻辑都在 SDK 中，CLI 只负责解析参数、调用 SDK、打印结果并对密钥脱敏。

## 命令概要

```text
lapp validate [path]
lapp inspect [path] [--reveal-secrets]
lapp init [path] --provider <id> --protocol <p> --base-url <url> [--secret <ref>] [--model <id>]
lapp provider add|set [path] --id <id> --protocol <p> --base-url <url> [--secret <ref>]
lapp provider remove [path] --id <id>
lapp model add|set [path] --provider <id> --id <id> [--alias <a>...] [--type <t>]
lapp model remove [path] --provider <id> --id <id>
lapp models sync [path] --provider <id> [--apply] [--remove-stale]
lapp default set [path] --provider <id> --model <id> [--kind chat|embedding|image|tts|video]
lapp env [path] --format bash|zsh|fish|powershell|cmd [--resolve] [--allow-plaintext]
lapp ping [provider[/model]] [path]
lapp chat [provider[/model]] <message> [path] [--provider <id> --model <id>] [--stream] [--tool <name:description:schema>]
lapp doctor [path]
```

## 全局参数

| 参数 | 含义 |
|------|------|
| `--dry-run` | 显示变更计划但不写入磁盘。 |
| `--yes` | 在显示计划后立即应用变更。 |
| `--reveal-secrets` | 显示密钥真实值而非脱敏占位符。仅在可信环境中使用。 |
| `--help`, `-h` | 显示用法。 |
| `--version`, `-v` | 显示版本。 |

## 路径参数

大多数命令都接受可选的 `[path]`。如果省略，CLI 按以下顺序解析配置根目录：

1. 给定的路径参数。
2. `LAPP_HOME` 环境变量。
3. `~/.lapp`。

详情见 [configuration.md](configuration.md#配置路径解析)。

## 命令详解

### `lapp validate [path]`

加载并验证配置。打印诊断信息，如果有错误则退出码非零。

```bash
lapp validate
lapp validate /etc/lapp
```

### `lapp inspect [path]`

以人类可读的方式打印配置摘要。默认对密钥脱敏。

```bash
lapp inspect
lapp inspect --reveal-secrets
```

### `lapp init [path]`

创建新的 `.lapp` 配置。该命令从空配置开始；如果目标路径已存在配置，需要加 `--force` 才会覆盖。

```bash
lapp init ~/.lapp \
  --provider openai \
  --protocol openai-chat-completions \
  --base-url https://api.openai.com/v1 \
  --secret env://OPENAI_API_KEY \
  --model gpt-4o \
  --yes
```

参数：

- `--provider <id>` — 提供者 ID（必填）
- `--protocol <p>` — 协议 ID（必填）
- `--base-url <url>` — 提供者基础 URL（必填）
- `--secret <ref>` — 密钥引用，例如 `env://NAME` 或明文
- `--model <id>` — 同时添加该模型并设为默认
- `--no-auth` — 设置认证类型为 `none`，用于本地/自托管提供者
- `--yes` — 立即写入配置

### `lapp provider add|set [path]`

添加新提供者或更新已有提供者。`set` 只覆盖你显式提供的字段，不会清空其他字段。

```bash
lapp provider add --id deepseek --protocol openai-chat-completions --base-url https://api.deepseek.com/v1 --secret env://DEEPSEEK_API_KEY --yes
lapp provider set --id deepseek --base-url https://api.deepseek.com/beta --yes
```

参数：

- `--id <id>` — 提供者 ID（必填）
- `--protocol <p>` — 协议 ID（`add` 必填）
- `--base-url <url>` — 提供者基础 URL（`add` 必填）
- `--secret <ref>` — 密钥引用
- `--no-auth` — 设置认证类型为 `none`
- `--enabled`、`--disabled` — 切换提供者启用状态

### `lapp provider remove [path]`

移除提供者，并清除指向它的所有默认引用。

```bash
lapp provider remove --id deepseek --yes
```

### `lapp model add|set [path]`

在提供者下添加或更新模型。

```bash
lapp model add --provider openai --id gpt-4o --type chat --alias gpt4o --yes
lapp model set --provider openai --id gpt-4o --type chat --yes
```

`add` 时如果省略 `--alias`，默认使用模型 id 作为别名。`set` 时如果省略 `--alias`，则保留已有别名。

参数：

- `--provider <id>` — 提供者 ID（必填）
- `--id <id>` — 模型 ID（必填）
- `--type <t>` — 模型类型：`chat`、`embedding`、`image`、`tts`、`video`
- `--alias <a>` — 可重复；模型的别名

### `lapp model remove [path]`

移除模型，并清除指向它的默认设置。

```bash
lapp model remove --provider openai --id gpt-4o --yes
```

### `lapp models sync [path]`

从提供者获取模型列表并显示变更。

```bash
lapp models sync --provider openai
lapp models sync --provider openai --apply --yes
lapp models sync --provider openai --apply --remove-stale --yes
```

参数：

- `--provider <id>` — 要同步的提供者（必填）
- `--apply` — 将合并后的模型列表写回磁盘
- `--remove-stale` — 删除提供者不再报告的 provider 来源条目（手动添加的条目会保留）

同步命令会自动传入 `allowUnauthenticated: true`，因此无需额外参数即可用于 Ollama 等本地提供者。

### `lapp default set [path]`

为指定种类设置全局默认模型。

```bash
lapp default set --provider openai --model gpt-4o --kind chat --yes
lapp default set --provider openai --model text-embedding-3-small --kind embedding --yes
```

`--kind` 对应全局默认槽位：

| `--kind` | 全局槽位 |
|----------|----------|
| `chat` | `defaultModel` |
| `embedding` | `defaultEmbeddingModel` |
| `image` | `defaultImageModel` |
| `tts` | `defaultTextToSpeechModel` |
| `video` | `defaultVideoModel` |

### `lapp env [path]`

为配置中的密钥生成 shell 语句，方便导入到从环境变量读取密钥的工具中。

```bash
lapp env --format bash
lapp env --format fish --resolve --allow-plaintext
```

参数：

- `--format` — `bash`、`zsh`、`fish`、`powershell` 或 `cmd`
- `--resolve` — 从当前环境读取 `env://` 值
- `--allow-plaintext` — 包含明文密钥

安全策略见 [security.md](security.md)。

### `lapp ping [provider[/model]] [path]`

发送一个 1 token 的测试请求。

```bash
lapp ping
lapp ping openai/gpt-4o
lapp ping ollama/llama3
```

### `lapp chat [provider[/model]] <message> [path]`

发送聊天消息。

```bash
lapp chat "什么是 LAPP？"
lapp chat openai/gpt-4o "什么是 LAPP？"
lapp chat "比较 A/B 测试" --provider openai --model gpt-4o
lapp chat "数到十" --stream
lapp chat "使用天气工具" --tool weather:'获取天气':'{"type":"object","properties":{"city":{"type":"string"}}}'
```

参数：

- `--provider <id>` 和 `--model <id>` — 显式指定目标；使用时必须同时提供
- `--stream` — 流式输出响应
- `--tool <spec>` — 注册一个 stub 工具用于测试工具调用（格式 `name[:description[:schema-json]]`）

### `lapp doctor [path]`

验证配置并检查每个启用的提供者是否能成功创建客户端。会报告不支持的协议、缺失模型等配置问题。

```bash
lapp doctor
```

## 退出码

| 退出码 | 含义 |
|--------|------|
| `0` | 成功，或仅含警告的验证通过。 |
| `1` | 命令失败（验证错误、配置问题、未应用写入）。 |
| `2` | CLI 用法错误（缺少必填参数、未知子命令）。 |

## 示例手册

### 使用环境变量密钥的 OpenAI

```bash
lapp init ~/.lapp \
  --provider openai \
  --protocol openai-chat-completions \
  --base-url https://api.openai.com/v1 \
  --secret env://OPENAI_API_KEY \
  --model gpt-4o \
  --yes
```

### Anthropic（带 `links.models` 覆盖）

```bash
lapp provider add \
  --id anthropic \
  --protocol anthropic-messages \
  --base-url https://api.anthropic.com \
  --secret env://ANTHROPIC_API_KEY \
  --yes

lapp model add --provider anthropic --id claude-sonnet-4 --type chat --yes
lapp default set --provider anthropic --model claude-sonnet-4 --kind chat --yes
```

### 本地 Ollama

```bash
lapp init ~/.lapp \
  --provider ollama \
  --protocol openai-chat-completions \
  --base-url http://localhost:11434/v1 \
  --no-auth \
  --model llama3 \
  --yes

lapp models sync --provider ollama --apply --yes
```

### 为 Aider 导出密钥

```bash
lapp env --format bash --resolve >> ~/.bashrc
```

完整安全说明见 [security.md](security.md)。
