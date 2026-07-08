# 迁移说明

本文档记录 `lapp-js` 用户的行为变更和迁移注意事项。

## `lapp init` 已移除——改用 `lapp provider add`

`lapp init` 命令已移除。`lapp provider add` 吸收了它的能力:在空根目录自动建 `manifest.json`、接受 `--model` 一步加模型并设 chat 默认、新增 `--force` 把已有配置重置为仅含本提供者。

```bash
# 之前
lapp init ~/.lapp --provider openai --protocol openai-chat-completions \
  --base-url https://api.openai.com/v1 --secret env://OPENAI_API_KEY --model gpt-4o --yes
# 之后(预设——协议/地址/密钥自动补)
lapp provider add --id openai --model gpt-4o --yes
# 之后(显式)
lapp provider add --id openai --protocol openai-chat-completions \
  --base-url https://api.openai.com/v1 --secret env://OPENAI_API_KEY --model gpt-4o --yes
```

本次发布的其他变更:

- **提供者预设**:`lapp provider add --id <预设>`(openai、anthropic、deepseek、openrouter、ollama、lm-studio、vllm、kimi、minimax、siliconflow)自动补 protocol/baseUrl/auth。`lapp presets` 列出全部。预设只在 CLI;SDK 保持 preset-agnostic。
- **多协议 CLI**:可重复的 `--protocol`、`--protocol-base-url`、`--protocol-header`(docker `--build-arg` 风格)现在能从 CLI 表达完整 `protocols[]`。
- **更多 SDK 字段可设**:provider `--name`/`--header`/`--link`/`--auth-type`/`--auth-header`/`--auth-query-param`;model `--capability`/`--input-modality`/`--output-modality`/`--context-window`/`--max-output-tokens`/`--model-protocol`/`--link`/`--metadata`/`--metadata-json`/`--enabled`/`--disabled`。
- **`lapp models list`** 现已入档(原本已实现但缺在 `--help`)。
- **`lapp models sync --set-default`** 应用后把某 kind 的首个同步模型设为全局默认。
- **bug 修复**:`lapp chat`/`ping` 对 `--no-auth` 提供者不再抛错(自动 `allowUnauthenticated`);`lapp chat` 不再把 `2/3` 这类单词斜杠消息误路由成目标;`maybeWrite` 在漏 `--yes` 但有变更时退出码非零(原为 0)。
- **`provider add` 在空根目录自动建 `manifest.json`**(原仅 `init` 会建)。

## v1.0.0

`lapp-js` v1.0.0 的稳定行为包括:

- SDK 支持 `plaintext` 和 `env://` 密钥;`keychain://` 和 `file://` 会被解析但运行时会抛出 `UnsupportedSecretSchemeError`。
- 客户端支持三种协议:`openai-chat-completions`、`openai-responses`、`anthropic-messages`。
- 配置文件按文件级别原子写入,无备份和回滚。
- 密钥默认脱敏;解析需要显式 opt-in。

## 旧版 `protocol` 字段

旧配置可能使用单个 `protocol` 字符串：

```json
{
  "protocol": "openai-chat-completions"
}
```

这仍然有效，但新配置应优先使用 `protocols: [...]`：

```json
{
  "protocols": [
    { "id": "openai-chat-completions" }
  ]
}
```

SDK 会按偏好顺序选择第一个支持的条目。

## `lapp model set` 保留别名

v1.0.0 起，`lapp model set` 在省略 `--alias` 时不再清空用户设置的别名，只会覆盖你显式提供的字段。如需替换别名，请显式传入 `--alias`。

## `lapp models sync` 支持无认证提供者

`lapp models sync` 现在会自动传入 `allowUnauthenticated: true`，因此无需额外参数即可用于 Ollama 等本地提供者。

## 错误脱敏

聊天/同步错误的 `err.raw` 现在会对常见密钥形态进行深度脱敏。依赖错误体中回显凭据的工具需要更新。

## 已知限制

- `keychain://` 和 `file://` 密钥方案会被解析但不会解析出值（v1 仅支持 `plaintext` 和 `env://`）。
- 同步模型时的能力推断是尽力而为的启发式规则（前缀 + 关键词匹配）；不暴露能力元数据的提供者可以通过直接编辑 `models.json` 补充。
- 聊天错误的 `err.raw` 会对常见密钥形态进行深度脱敏，但如果提供者把凭据嵌入非字符串字段则无法保护。

完整发布历史见 [CHANGELOG.md](../../CHANGELOG.md)。
