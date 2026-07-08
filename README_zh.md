# lapp-js

LAPP（Local AI Provider Profiles，本地 AI 提供者配置）的 TypeScript SDK 与 CLI：用一份本地配置描述你的 AI 提供者，然后从终端或 TypeScript 直接调用。**v1.0.0**

> **语言：** [English](README.md) | [中文](README_zh.md)

`lapp-js` 是**客户端，不是网关**——没有持久化服务器、不为其他应用代理流量、也不计费。你的进程直接和提供者通信。

```text
.lapp 配置  →  @openlapp/lapp SDK  →  协议适配器  →  提供者 API
```

| 包 | 是什么 |
|----|--------|
| [`@openlapp/cli`](docs/zh/cli.md) | `lapp` 命令——在终端里配置和聊天。 |
| [`@openlapp/lapp`](docs/zh/sdk.md) | SDK——在 TypeScript 中读取、编写和使用配置。 |

## 安装

```bash
npm install -g @openlapp/cli     # CLI
npm install @openlapp/lapp       # SDK（在项目里）
```

需要 Node 18.18 或更高版本。

## 30 秒上手

**配置是一次性的,聊天是每天的。** 你先写一份小配置,告诉 lapp 你的提供者在哪里、用哪个模型;之后聊天就是一行命令。对知名提供者,预设会自动补上协议、地址和建议密钥。

```bash
# 1) 一次性配置——预设做重活(预设列表见 `lapp presets`)
lapp provider add --id openai --model gpt-4o --yes

# 2) 聊天——一行,使用刚才设置的默认模型
lapp chat "用五个字打个招呼。"

# 3) 临时换模型——内联……
lapp chat openai/gpt-4o-mini "快速问个问题。"

# ……或用参数
lapp chat "再问一个" --provider openai --model gpt-4o-mini

# 4) 流式输出
lapp chat "数到十" --stream
```

> **你的提供者没有预设?** 显式传协议和地址即可:
> `lapp provider add --id my-proxy --protocol openai-chat-completions --base-url https://my-proxy/v1 --secret env://MY_PROXY_KEY --yes`。所有写入命令都会先显示变更计划,加 `--yes` 才会应用(用 `--dry-run` 只预览)。

### 复制即用的配方

选你的提供者,复制对应代码块,设好环境变量,开聊。

**OpenAI**

```bash
export OPENAI_API_KEY=sk-...
lapp provider add --id openai --model gpt-4o --yes
lapp chat "你好。"
```

**Anthropic**

```bash
export ANTHROPIC_API_KEY=sk-ant-...
lapp provider add --id anthropic --model claude-sonnet-4 --yes
lapp chat "你好。"
```

**DeepSeek**(OpenAI 兼容)

```bash
export DEEPSEEK_API_KEY=sk-...
lapp provider add --id deepseek --model deepseek-chat --yes
lapp chat "你好。"
```

**Ollama**(本地,免认证)

```bash
lapp provider add --id ollama --yes
lapp models sync --provider ollama --apply --set-default --yes   # 拉取模型列表
lapp chat "你好,Ollama。"
```

## 在 TypeScript 里用

```bash
npm install @openlapp/lapp
```

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
```

## 支持的协议

| 协议 | 聊天 | 流式 | 工具调用 | 模型列表同步 |
| --- | --- | --- | --- | --- |
| `openai-chat-completions` | 是 | 是 | 是 | 是（`GET /models`） |
| `openai-responses` | 是 | 是 | 是 | 是（`GET /models`） |
| `anthropic-messages` | 是 | 是 | 是 | 没有公开 API；可设置 `provider.links.models` 覆盖 |

## 文档

- **[入门指南](docs/zh/getting-started.md)**——安装、第一个提供者、第一次聊天（从这里开始）
- **[CLI 参考](docs/zh/cli.md)**——`lapp` 的每个命令、参数和退出码
- **[SDK 指南](docs/zh/sdk.md)**——在 TypeScript 中使用 `@openlapp/lapp`
- [配置文件](docs/zh/configuration.md)——配置结构、路径解析、多协议提供者
- [安全说明](docs/zh/security.md)——密钥方案、脱敏策略、显式 opt-in 解析
- [协议说明](docs/zh/protocols.md)——各协议行为与能力推断
- [本地提供者](docs/zh/local-providers.md)——Ollama、LM Studio、vLLM
- [故障排除](docs/zh/troubleshooting.md)——类型化错误、常见警告、FAQ
- [迁移说明](docs/zh/migrating.md)——v1.0.0 以来的变更与已知限制
- [API 参考](packages/lapp/docs/api.md) · [CHANGELOG](CHANGELOG.md) · [English](README.md)

## v1 已知限制

- `keychain://` 和 `file://` 密钥方案会被解析但不会解析出值（v1 仅支持 `plaintext` 和 `env://`）。
- 同步模型时的能力推断是尽力而为的启发式规则（前缀 + 关键词匹配）；不暴露能力元数据的提供者可以通过直接编辑 `models.json` 补充。
- 聊天错误的 `err.raw` 会对常见密钥形态进行深度脱敏，但如果提供者把凭据嵌入非字符串字段则无法保护。

## 许可证

MIT
