# 入门指南

`lapp-js` 是 LAPP（Local AI Provider Profiles，本地 AI 提供者配置）的 TypeScript 实现。它提供了客户端 SDK（`@openlapp/lapp`）和轻量级 CLI（`lapp`），用于读取、验证、编写和使用 `.lapp` 配置文件，然后直接向配置的提供者发送请求。

```text
.lapp 配置
  -> @openlapp/lapp SDK
  -> 协议适配器
  -> 提供者 API
```

`lapp-js` 是一个客户端，不是网关：没有持久化服务器、不为其他应用代理流量、也不计费。

## 安装

安装 CLI：

```bash
npm install -g @openlapp/cli
```

在项目中安装 SDK：

```bash
npm install @openlapp/lapp
```

需要 Node 18.18 或更高版本。

## CLI 快速开始

在 `~/.lapp` 创建配置文件，并用默认模型聊天：

```bash
lapp init ~/.lapp \
  --provider openai \
  --protocol openai-chat-completions \
  --base-url https://api.openai.com/v1 \
  --secret env://OPENAI_API_KEY \
  --model gpt-4o \
  --yes

lapp validate
lapp chat "用五个字打个招呼。"
lapp doctor
```

写入类命令默认会先显示变更计划，需要 `--yes` 才会真正应用（也可以用 `--dry-run` 只预览）。

## SDK 快速开始

```ts
import { loadProfile, createLappClient, listModels } from "@openlapp/lapp";

const profile = loadProfile();

// 列出所有提供者的全部可用模型
const models = listModels(profile);
// [{ providerId, modelId, protocol, baseUrl, type, capabilities, ... }, ...]

// 使用全局默认模型聊天
const client = createLappClient({ profile, resolveSecrets: true });
const resp = await client.chat({
  messages: [{ role: "user", content: "你好！" }],
});
console.log(resp.text);

// 流式输出
for await (const ev of client.stream({ messages: [{ role: "user", content: "你好！" }] })) {
  if (ev.kind === "delta") process.stdout.write(ev.text);
}
```

## 本地服务器（Ollama、LM Studio、vLLM）

本地 OpenAI 兼容服务器通常不需要认证。初始化时使用 `--no-auth` 跳过认证头：

```bash
lapp init ~/.lapp \
  --provider ollama \
  --protocol openai-chat-completions \
  --base-url http://localhost:11434/v1 \
  --no-auth \
  --model llama3 \
  --yes
```

详细说明见 [local-providers.md](local-providers.md)。

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
