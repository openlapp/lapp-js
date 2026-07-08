# 入门指南

`lapp-js` 让你用一份本地配置描述你的 AI 提供者，然后从终端（`@openlapp/cli`）或 TypeScript（`@openlapp/lapp`）直接调用。

```text
.lapp 配置  →  @openlapp/lapp SDK  →  协议适配器  →  提供者 API
```

它是**客户端，不是网关**：没有服务器、不代理、不计费——你的进程直接和提供者通信。

## 安装

```bash
npm install -g @openlapp/cli     # CLI
npm install @openlapp/lapp       # SDK（在项目里）
```

需要 Node 18.18 或更高版本。

## 1 · 配置一个提供者（一次）

配置就是一个小目录（默认 `~/.lapp`），里面几个 JSON 文件。最快的建法是 `lapp provider add`——它注册一个提供者，并（带 `--model` 时）一步设好默认模型。对知名提供者，**预设**会自动补上协议、地址和建议密钥。

**OpenAI**——设好密钥，然后添加：

```bash
export OPENAI_API_KEY=sk-...
lapp provider add --id openai --model gpt-4o --yes
```

`lapp provider add` 的参数：
- `--id <id|preset>`——你**自己起**的名字（之后用它指代该提供者），或一个已知预设 id（如 `openai`/`anthropic`/`ollama`，`lapp presets` 列出全部）。
- `--protocol` / `--base-url`——怎么和它通信。自定义提供者必填；**用预设时可省略**。
- `--secret env://NAME`——从环境变量读密钥（推荐）。用预设时若省略，自动填约定的 `env://<PROVIDER>_API_KEY`。明文也可以，但会留在磁盘上。
- `--model`——一步完成：注册一个模型**并**设为默认。
- `--yes`——应用变更（写入命令会先显示计划；用 `--dry-run` 只预览）。

## 2 · 聊天（每天）

```bash
lapp chat "用五个字打个招呼。"       # 用默认模型
lapp chat --stream "数到十"          # 流式输出
```

临时换目标——把 `provider/model` 作为第一个词：

```bash
lapp chat openai/gpt-4o-mini "快速问个问题。"   # 内联目标
```

……或用参数（消息本身含 `/` 时更稳妥）：

```bash
lapp chat "比较 A/B 测试" --provider openai --model gpt-4o-mini
```

也可以**改默认**，然后继续用一行命令：

```bash
lapp default set --provider openai --model gpt-4o-mini --kind chat --yes
lapp chat "现在走 gpt-4o-mini 了。"
```

## 3 · 再加一个提供者

`lapp provider add` 往已有配置里追加。若想重置为仅含本提供者，用 `--force`。

```bash
export ANTHROPIC_API_KEY=sk-ant-...
lapp provider add --id anthropic --model claude-sonnet-4 --yes
```

现在 `lapp chat "你好"` 走最近的默认，`lapp chat openai/gpt-4o "你好"` 走 OpenAI。

## 4 · 看一看

```bash
lapp inspect              # 人类可读摘要（密钥已脱敏）
lapp validate             # 结构 + 语义校验
lapp doctor               # 校验 + 每个启用的提供者能否建成客户端？
lapp ping openai/gpt-4o   # 1 token 测试请求
lapp presets              # 列出内置提供者预设
```

## 提供者配方

添加提供者有两种方式——预设（一行）或完全显式：

```bash
# 预设
lapp provider add --id openai --model gpt-4o --yes

# 完全显式（自建/自定义）
lapp provider add --id my-proxy --protocol openai-chat-completions \
  --base-url https://my-proxy.example.com/v1 --secret env://MY_PROXY_KEY --yes
```

常见提供者的 `--protocol` 和 `--base-url`（用于显式形式）：

| 提供者 | `--protocol` | `--base-url` | 认证 |
|--------|--------------|--------------|------|
| OpenAI | `openai-chat-completions` | `https://api.openai.com/v1` | `env://OPENAI_API_KEY` |
| OpenAI Responses | `openai-responses` | `https://api.openai.com/v1` | `env://OPENAI_API_KEY` |
| Anthropic | `anthropic-messages` | `https://api.anthropic.com` | `env://ANTHROPIC_API_KEY` |
| DeepSeek | `openai-chat-completions` | `https://api.deepseek.com/v1` | `env://DEEPSEEK_API_KEY` |
| OpenRouter | `openai-chat-completions` | `https://openrouter.ai/api/v1` | `env://OPENROUTER_API_KEY` |
| Ollama（本地） | `openai-chat-completions` | `http://localhost:11434/v1` | `--no-auth` |
| LM Studio（本地） | `openai-chat-completions` | `http://localhost:1234/v1` | `--no-auth` |
| vLLM（本地） | `openai-chat-completions` | `http://localhost:8000/v1` | `--no-auth` |

注意：
- `lapp-js` 对 OpenAI 兼容提供者**不会**自动补 `/v1`——如果提供者需要，请写进 `--base-url`。`--base-url` 不要以 `/` 结尾。
- Anthropic 的适配器只在 `/v1` 是最后一个路径段时才去重。
- 本地服务器用 `--no-auth` 跳过认证头。完整说明见 [local-providers.md](local-providers.md)。

### 从提供者拉取模型列表

OpenAI 兼容提供者可以从 `/models` 端点同步模型列表：

```bash
lapp models sync --provider ollama                 # 预览
lapp models sync --provider ollama --apply --yes   # 写入
lapp models sync --provider ollama --apply --set-default --yes   # 写入 + 把首个 chat 模型设为默认
```

Anthropic 没有公开的模型列表端点；可设置 `provider.links.models` 指向一个（见 [protocols.md](protocols.md)）。

## 在 TypeScript 里用

```ts
import { loadProfile, createLappClient, listModels } from "@openlapp/lapp";

const profile = loadProfile();

// 列出所有提供者的全部可用模型
const models = listModels(profile);

// 使用全局默认模型聊天
const client = createLappClient({ profile, resolveSecrets: true });
const resp = await client.chat({ messages: [{ role: "user", content: "你好！" }] });
console.log(resp.text);

// 流式输出
for await (const ev of client.stream({ messages: [{ role: "user", content: "你好！" }] })) {
  if (ev.kind === "delta") process.stdout.write(ev.text);
}

// 指定提供者/模型
const cc = createLappClient({ profile, provider: "anthropic", model: "claude-sonnet-4", resolveSecrets: true });
```

`resolveSecrets: true` 是真正调用提供者的必要条件——SDK 除非你显式 opt-in，否则绝不读 `process.env`。完整 API 见 [sdk.md](sdk.md)。

## 支持的协议

| 协议 | 聊天 | 流式 | 工具调用 | 模型列表同步 |
| --- | --- | --- | --- | --- |
| `openai-chat-completions` | 是 | 是 | 是 | 是（`GET /models`） |
| `openai-responses` | 是 | 是 | 是 | 是（`GET /models`） |
| `anthropic-messages` | 是 | 是 | 是 | 没有公开 API；可设置 `provider.links.models` 覆盖 |

## 接下来阅读

- [CLI 参考](cli.md) — `lapp` 的每个命令、参数和退出码
- [SDK 指南](sdk.md) — 如何在 TypeScript 中使用 `@openlapp/lapp`
- [配置文件](configuration.md) — 配置结构、路径解析、多协议提供者
- [安全说明](security.md) — 密钥方案、脱敏策略、显式 opt-in 解析
- [协议说明](protocols.md) — 各协议行为与能力推断
- [本地提供者](local-providers.md) — Ollama、LM Studio、vLLM
- [故障排除](troubleshooting.md) — 类型化错误、常见警告、FAQ
- [迁移说明](migrating.md) — v1.0.0 以来的变更与已知限制

## v1 已知限制

- `keychain://` 和 `file://` 密钥方案会被解析但不会解析出值（v1 仅支持 `plaintext` 和 `env://`）。
- 同步模型时的能力推断是尽力而为的启发式规则（前缀 + 关键词匹配）；不暴露能力元数据的提供者可以通过直接编辑 `models.json` 补充。
- 聊天错误的 `err.raw` 会对常见密钥形态进行深度脱敏，但如果提供者把凭据嵌入非字符串字段则无法保护。
