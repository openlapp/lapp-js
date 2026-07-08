# CLI 参考

`lapp` 是 LAPP 的命令行接口——`@openlapp/lapp` 的轻量级包装。所有配置逻辑都在 SDK 中,CLI 只负责解析参数、调用 SDK、打印结果,并默认对密钥脱敏。

## 最常用的操作

你做得最多的两件事:

```bash
lapp chat "用五个字打个招呼。"             # 用默认模型聊天
lapp chat openai/gpt-4o-mini "快速问一个。"  # ……或指定提供者/模型
lapp chat "数到十" --stream                # 流式输出
```

**添加一个提供者。** 两种方式——一行预设或完全显式命令:

```bash
# 1) 预设——自动补 protocol、baseUrl 和建议的 env 密钥
lapp provider add --id openai --model gpt-4o --yes

# 2) 完全显式(自建/自定义提供者)
lapp provider add --id my-proxy \
  --protocol openai-chat-completions --base-url https://my-proxy.example.com/v1 \
  --secret env://MY_PROXY_KEY --yes
```

用 `lapp presets` 查看内置预设列表(openai、anthropic、deepseek、openrouter、ollama、lm-studio、vllm、kimi、minimax、siliconflow)。

**健康检查。**

```bash
lapp doctor              # 校验 + 每个启用的提供者能否建成客户端?
lapp ping openai/gpt-4o  # 1 token 测试请求
lapp inspect             # 人类可读摘要(密钥已脱敏)
```

## 命令概要

```text
lapp validate [path]
lapp inspect [path] [--reveal-secrets]
lapp provider add|set [path] --id <id|preset> [--protocol <p>...] [--protocol-base-url <url>] [--protocol-header 'k: v']... [--base-url <url>] [--secret <ref>] [--auth-type bearer|header|query|none] [--auth-header <name>] [--auth-query-param <name>] [--no-auth] [--model <id>] [--name <s>] [--header 'k: v']... [--link k=v]... [--enabled|--disabled] [--force]
lapp provider remove [path] --id <id>
lapp model add|set [path] --provider <id> --id <id> [--alias <a>...] [--type <t>] [--capability <c>...] [--input-modality <m>...] [--output-modality <m>...] [--context-window <n>] [--max-output-tokens <n>] [--model-protocol <p>] [--link k=v]... [--metadata k=v]... [--metadata-json '{...}'] [--enabled|--disabled]
lapp model remove [path] --provider <id> --id <id>
lapp models list [path]
lapp models sync [path] --provider <id> [--apply] [--remove-stale] [--set-default] [--kind chat|embedding|image|tts|video]
lapp default set [path] --provider <id> --model <id> [--kind chat|embedding|image|tts|video]
lapp env [path] --format bash|zsh|fish|powershell|cmd [--resolve] [--allow-plaintext]
lapp presets
lapp ping [provider[/model]] [path]
lapp chat [provider[/model]] <message> [path] [--provider <id> --model <id>] [--stream] [--tool <name:description:schema>]
lapp doctor [path]
```

## 全局参数

| 参数 | 含义 |
|------|------|
| `--dry-run` | 显示变更计划但不写入磁盘。 |
| `--yes` | 在显示计划后立即应用变更。若有真实变更却漏了 `--yes`,退出码非零,以免 CI 把跳过的写入误判为成功。 |
| `--reveal-secrets` | 显示密钥真实值而非脱敏占位符。仅在可信环境中使用。 |
| `--help`, `-h` | 显示用法。 |
| `--version`, `-v` | 显示版本。 |

所有写入命令都会先显示变更计划,加 `--yes` 才会应用(用 `--dry-run` 只预览)。

## 路径参数

大多数命令都接受可选的 `[path]`。如果省略,CLI 按以下顺序解析配置根目录:

1. 给定的路径参数。
2. `LAPP_HOME` 环境变量。
3. `~/.lapp`。

详情见 [configuration.md](configuration.md#配置路径解析)。

## 日常命令

### `lapp chat [provider[/model]] <message> [path]`

发送聊天消息。

```bash
lapp chat "什么是 LAPP?"
lapp chat openai/gpt-4o "什么是 LAPP?"
lapp chat "比较 A/B 测试" --provider openai --model gpt-4o
lapp chat "数到十" --stream
lapp chat "使用天气工具" --tool weather:'获取天气':'{"type":"object","properties":{"city":{"type":"string"}}}'
```

目标解析顺序:

1. `--provider` / `--model` 参数(显式;必须同时提供,避免把模型发给错误的提供者)。
2. 第一个位置参数**仅当**它匹配 `provider/model`(单 `/`、无空格、无多余斜杠)**且** provider 段在已加载 profile 中存在时才作为目标——这样 `2/3`、`say/hi` 这类消息被当文本,不会被误路由。
3. 否则所有位置参数都是消息,使用全局默认模型。

参数:

- `--provider <id>` 和 `--model <id>` — 显式指定目标;使用时必须同时提供。
- `--stream` — 流式输出响应。
- `--tool <spec>` — 注册一个 stub 工具用于测试工具调用。格式 `name[:description[:schema-json]]`。工具结果为字符串 `(stub)`;适合验证提供者是否遵守 `tool_choice=auto`。

模型回复原样打印——不对它做脱敏(否则会破坏合法的、长得像密钥的内容)。

`lapp chat` 对免认证提供者(`--no-auth` / `auth.type: "none"` / 无密钥)自动放行,Ollama 流程无需额外参数。

### `lapp default set [path]`

为某个种类设置全局默认模型。这就是改裸 `lapp chat` 走哪个模型的方式。

```bash
lapp default set --provider openai --model gpt-4o --kind chat --yes
lapp default set --provider openai --model text-embedding-3-small --kind embedding --yes
```

| `--kind` | 全局槽位 |
|----------|----------|
| `chat` | `defaultModel` |
| `embedding` | `defaultEmbeddingModel` |
| `image` | `defaultImageModel` |
| `tts` | `defaultTextToSpeechModel` |
| `video` | `defaultVideoModel` |

### `lapp ping [provider[/model]] [path]`

发送一个 1 token 的测试请求。

```bash
lapp ping
lapp ping openai/gpt-4o
lapp ping ollama/llama3
```

### `lapp doctor [path]`

验证配置并检查每个启用的提供者是否能成功创建客户端。会报告不支持的协议、缺失模型等配置问题。有真实问题时退出码非零。

```bash
lapp doctor
```

## 提供者命令

### `lapp provider add|set [path]`

添加新提供者,或更新已有提供者。`set` 只覆盖你显式提供的字段,不会清空其他字段。`add` 在空根目录时自动建 `manifest.json`;`add --force` 把已有配置重置为仅含本提供者(吸收了旧 `lapp init` 的清空重建职责)。

**预设(一行):**

```bash
lapp provider add --id openai --model gpt-4o --yes
lapp provider add --id ollama --yes                 # 本地,免认证
```

**完全显式:**

```bash
lapp provider add --id deepseek \
  --protocol openai-chat-completions --base-url https://api.deepseek.com/v1 \
  --secret env://DEEPSEEK_API_KEY --yes
lapp provider set --id deepseek --base-url https://api.deepseek.com/beta --yes
```

**多协议(偏好顺序,per-protocol baseUrl/headers):**

```bash
lapp provider add --id openai \
  --protocol openai-responses --protocol-header 'OpenAI-Beta: responses=v1' \
  --protocol openai-chat-completions \
  --model gpt-4o --yes
```

每个 `--protocol` 开始一个 `protocols[]` 条目;`--protocol-base-url` 和 `--protocol-header` 作用于最近一个 `--protocol`。

参数:

- `--id <id|preset>` — 提供者 ID 或已知预设 id(必填)。
- `--protocol <p>` — 可重复;每个对应一个 `protocols[]` 槽。用预设时省略。
- `--protocol-base-url <url>` — per-protocol base URL(作用于最近 `--protocol`)。不得以 `/` 结尾。
- `--protocol-header 'k: v'` — 可重复;per-protocol 请求头(作用于最近 `--protocol`)。
- `--base-url <url>` — 提供者 base URL(预设提供时可不填)。不得以 `/` 结尾。
- `--secret <ref>` — 密钥引用,例如 `env://NAME` 或明文。用预设时若省略,自动填约定的 `env://<PROVIDER>_API_KEY`。
- `--auth-type bearer|header|query|none` — 认证类型。`--no-auth` 等同 `--auth-type none`。
- `--auth-header <name>`、`--auth-query-param <name>` — 自定义认证头/查询参数名(非 bearer 方案)。
- `--no-auth` — 设置认证类型为 `none`(本地/自托管提供者)。
- `--model <id>` — 一步完成:添加该模型(若不存在)并设为 chat 默认(`add` 与 `set` 都设默认)。
- `--name <s>` — 显示名。
- `--header 'k: v'` — 可重复;提供者级静态请求头(非密钥)。
- `--link k=v` — 可重复;提供者 `links` 映射(如 `--link docs=https://...`)。
- `--enabled`、`--disabled` — 切换提供者启用状态。
- `--force` — (仅 `add`)把已有配置重置为仅含本提供者。

### `lapp provider remove [path]`

移除提供者,并清除指向它的所有默认引用。

```bash
lapp provider remove --id deepseek --yes
```

### `lapp presets`

列出内置提供者预设(id、协议、认证形态、baseUrl)。用预设 id 配 `lapp provider add --id <preset>`。

```bash
lapp presets
```

## 模型命令

### `lapp model add|set [path]`

在提供者下添加或更新模型。

```bash
lapp model add --provider openai --id gpt-4o --type chat --alias gpt4o --yes
lapp model set --provider openai --id gpt-4o --type chat --yes
lapp model add --provider openai --id text-embedding-3-small --type embedding \
  --input-modality text --output-modality embedding --context-window 8191 --yes
```

`add` 时如果省略 `--alias`,默认使用模型 id 作为别名。`set` 时如果省略 `--alias`,则保留已有别名(overlay 不变量)。

参数:

- `--provider <id>` — 提供者 ID(必填)。
- `--id <id>` — 模型 ID(必填)。
- `--alias <a>` — 可重复;模型的别名。
- `--type <t>` — 模型类型:`chat`、`embedding`、`image`、`tts`、`video`、`rerank`……(开放字符串)。
- `--capability <c>` — 可重复;能力标签(`tools`、`vision`、`streaming`……)。
- `--input-modality <m>` / `--output-modality <m>` — 可重复;模态列表(`text`、`image`、`audio`……)。
- `--context-window <n>` / `--max-output-tokens <n>` — 整数上限。
- `--model-protocol <p>` — per-model 协议覆盖(让单个模型走不同适配器)。
- `--link k=v` — 可重复;模型 `links` 映射。
- `--metadata k=v` — 可重复;模型 `metadata`(字符串值)。
- `--metadata-json '{...}'` — 完整 metadata 对象(JSON)。
- `--enabled`、`--disabled` — per-model 启用开关。

### `lapp model remove [path]`

移除模型,并清除指向它的默认设置。

```bash
lapp model remove --provider openai --id gpt-4o --yes
```

### `lapp models list [path]`

打印每个提供者及其模型 id。

```bash
lapp models list
```

### `lapp models sync [path]`

从提供者获取模型列表并显示变更。

```bash
lapp models sync --provider openai
lapp models sync --provider openai --apply --yes
lapp models sync --provider ollama --apply --set-default --yes
```

参数:

- `--provider <id>` — 要同步的提供者(必填)。
- `--apply` — 将合并后的模型列表写回磁盘。
- `--remove-stale` — 删除提供者不再报告的 provider 来源条目(手动添加的条目会保留)。
- `--set-default` — 应用后,把首个 `--kind`(默认 `chat`)类型的同步模型设为该种类的全局默认。需配合 `--apply`。

同步命令会自动传入 `allowUnauthenticated: true`,因此无需额外参数即可用于 Ollama 等本地提供者。

## 检查与导出

### `lapp validate [path]`

加载并验证配置。打印诊断信息,有错误则退出码非零。

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

### `lapp env [path]`

为配置中的密钥生成 shell 语句,方便导入到从环境变量读取密钥的工具中。

```bash
lapp env --format bash
lapp env --format fish --resolve --allow-plaintext
```

参数:

- `--format` — `bash`、`zsh`、`fish`、`powershell` 或 `cmd`。
- `--resolve` — 从当前环境读取 `env://` 值。
- `--allow-plaintext` — 包含明文密钥(不加此项则省略)。

安全策略见 [security.md](security.md)。

## 提供者预设

| 预设 | 协议 | baseUrl | 认证 |
|------|------|---------|------|
| `openai` | `openai-responses`、`openai-chat-completions` | `https://api.openai.com/v1` | `env://OPENAI_API_KEY` |
| `anthropic` | `anthropic-messages` | `https://api.anthropic.com` | `env://ANTHROPIC_API_KEY` |
| `deepseek` | `openai-chat-completions` | `https://api.deepseek.com/v1` | `env://DEEPSEEK_API_KEY` |
| `openrouter` | `openai-chat-completions` | `https://openrouter.ai/api/v1` | `env://OPENROUTER_API_KEY` |
| `ollama` | `openai-chat-completions` | `http://localhost:11434/v1` | `--no-auth` |
| `lm-studio` | `openai-chat-completions` | `http://localhost:1234/v1` | `--no-auth` |
| `vllm` | `openai-chat-completions` | `http://localhost:8000/v1` | `--no-auth` |
| `kimi` / `moonshot` | `openai-chat-completions` | `https://api.moonshot.cn/v1` | `env://MOONSHOT_API_KEY` |
| `minimax` | `openai-chat-completions` | `https://api.minimaxi.com/v1` | `env://MINIMAX_API_KEY` |
| `siliconflow` | `openai-chat-completions` | `https://api.siliconflow.cn/v1` | `env://SILICONFLOW_API_KEY` |

- `lapp-js` 对 OpenAI 兼容提供者**不会**自动补 `/v1`——预设里按需已含。
- `--base-url` 不要以 `/` 结尾。
- Anthropic 的适配器只在 `/v1` 是最后一个路径段时才去重。
- 本地服务器的预设设了 `--no-auth`。完整说明见 [local-providers.md](local-providers.md)。
- 扩展协议(如 `gemini-generate-content`)不是预设;需手编 `provider.json`。

## 退出码

| 退出码 | 含义 |
|--------|------|
| `0` | 成功,或仅含警告的验证通过,或写入命令无变更。 |
| `1` | 命令失败(验证错误、配置问题、漏了 `--yes` 但有真实变更导致未写入)。 |
| `2` | CLI 用法错误(缺少必填参数、未知子命令)。 |

## 从 `lapp init` 迁移

`lapp init` 已移除。改用 `lapp provider add`:

```bash
# 之前
lapp init ~/.lapp --provider openai --protocol openai-chat-completions \
  --base-url https://api.openai.com/v1 --secret env://OPENAI_API_KEY --model gpt-4o --yes
# 之后(预设)
lapp provider add --id openai --model gpt-4o --yes
# 之后(显式,不用预设)
lapp provider add --id openai --protocol openai-chat-completions \
  --base-url https://api.openai.com/v1 --secret env://OPENAI_API_KEY --model gpt-4o --yes
```

`--force`(重置已有配置)现在是 `lapp provider add --force`。
