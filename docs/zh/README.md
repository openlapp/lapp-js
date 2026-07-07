# lapp-js

LAPP（Local AI Provider Profiles，本地 AI 提供者配置）的 TypeScript SDK 与 CLI 工作区 **v1.0.0**。

> **语言：** [English](https://github.com/openlapp/lapp-js/blob/main/README.md) | [中文](getting-started.md)

- `@openlapp/lapp`：用于读取、编写、验证和使用 LAPP 配置的核心 SDK。
- `@openlapp/cli`：SDK 的轻量级 CLI 包装（安装后提供 `lapp` 命令）。

`lapp-js` 是客户端，不是网关：没有持久化服务器、不为其他应用代理流量、也不计费。

```text
.lapp 配置
  -> @openlapp/lapp SDK
  -> 协议适配器
  -> 提供者 API
```

## 快速开始

### CLI

```bash
npm install -g @openlapp/cli

lapp init ~/.lapp \
  --provider openai \
  --protocol openai-chat-completions \
  --base-url https://api.openai.com/v1 \
  --secret env://OPENAI_API_KEY \
  --model gpt-4o \
  --yes

lapp chat "用五个字打个招呼。"
```

### SDK

```bash
npm install @openlapp/lapp
```

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

本地 OpenAI 兼容服务器通常不需要认证。使用 `--no-auth` 跳过认证头：

```bash
lapp init ~/.lapp \
  --provider ollama \
  --protocol openai-chat-completions \
  --base-url http://localhost:11434/v1 \
  --no-auth \
  --model llama3 \
  --yes
```

完整说明见 [local-providers.md](local-providers.md)。

## 支持的协议

| 协议 | 聊天 | 流式 | 工具调用 | 模型列表同步 |
| --- | --- | --- | --- | --- |
| `openai-chat-completions` | 是 | 是 | 是 | 是（`GET /models`） |
| `openai-responses` | 是 | 是 | 是 | 是（`GET /models`） |
| `anthropic-messages` | 是 | 是 | 是 | 没有公开 API；可设置 `provider.links.models` 覆盖 |

## v1 已知限制

- `keychain://` 和 `file://` 密钥方案会被解析但不会解析出值（v1 仅支持 `plaintext` 和 `env://`）。
- 同步模型时的能力推断是尽力而为的启发式规则（前缀 + 关键词匹配）；不暴露能力元数据的提供者可以通过直接编辑 `models.json` 补充。
- 聊天错误的 `err.raw` 会对常见密钥形态进行深度脱敏，但如果提供者把凭据嵌入非字符串字段则无法保护。

## 文档

- [入门指南](getting-started.md)
- [CLI 参考](cli.md)
- [SDK 指南](sdk.md)
- [配置文件](configuration.md)
- [安全说明](security.md)
- [协议说明](protocols.md)
- [本地提供者](local-providers.md)
- [故障排除](troubleshooting.md)
- [迁移说明](migrating.md)
- [API 参考](../packages/lapp/docs/api.md)
- [CHANGELOG](../CHANGELOG.md)

## 许可证

MIT
