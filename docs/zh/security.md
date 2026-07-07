# 安全说明

`lapp-js` 围绕一个简单原则设计：除非你明确要求，否则密钥不会离开磁盘。

## 支持的密钥方案

v1 支持两种运行时解析方案：

| 方案 | 示例 | 是否推荐 |
|------|------|----------|
| `plaintext` | `"sk-..."` | 否 — 会把密钥留在磁盘上。 |
| `env://` | `"env://OPENAI_API_KEY"` | 是 — 密钥不进入配置文件。 |

以下两种方案会被解析，但运行时会抛出 `UnsupportedSecretSchemeError`：

- `keychain://`
- `file://`

## 显示策略

SDK 和 CLI 中所有会打印配置内容的路径默认都会对密钥脱敏：

- `lapp inspect`
- `validateProfile` 诊断信息
- `inspectProfile` 摘要
- CLI 错误输出（防御性正则脱敏）

需要显式传入 `revealSecrets: true`（SDK）或 `--reveal-secrets`（CLI）才会显示真实值。仅在可信环境中使用。

`lapp chat` 中模型的回复会原样打印。对回复内容再跑一遍脱敏会误伤正常的密钥形状内容（例如模型在解释 API key 格式），因此故意不做处理。

## 解析策略

SDK **不会**读取 `process.env`，除非你显式 opt-in：

```ts
const client = createLappClient({ profile, resolveSecrets: true });
```

```bash
lapp env --format bash --resolve
```

客户端在密钥未解析时会快速失败，不会用占位符或空字符串替代。

## 环境导出策略

`exportEnv`（以及 `lapp env`）需要两个独立的 opt-in 才会输出明文或解析后的值：

- `resolve: true` — 从 `process.env` 读取 `env://` 值。
- `allowPlaintext: true` — 在输出中包含明文密钥。

没有 `allowPlaintext` 时明文条目会被省略；没有 `resolve` 时 `env://` 条目会作为字面引用输出。

```ts
const out = exportEnv(profile, {
  format: "bash",
  resolve: true,
  allowPlaintext: false,
});
```

## 错误脱敏

聊天或同步请求抛出错误时，`err.raw` 会对字符串叶子节点进行深度脱敏，使用一组共享的密钥正则（OpenAI/Anthropic 风格 key、OpenRouter、GitHub token、xAI、Google、通用 `Bearer ...` 等）。

注意：如果提供者把凭据嵌入非字符串字段，则无法保护。这是 v1 的已知限制。

## 认证头去重

适配器会在添加自己的认证头之前，大小写不敏感地从用户 `requestHeaders` 中移除 `authorization`、`x-api-key` 等认证相关头。这样用户自定义的 `X-Api-Key` 就不会和适配器认证头冲突。

当设置 `auth.queryParam` 时，客户端会完全移除头认证，避免密钥在 URL 和头中同时泄露。

## 无认证提供者

本地/自托管提供者（如 Ollama、LM Studio、vLLM）通常不需要认证。在 SDK 中使用 `allowUnauthenticated: true`，在 CLI 中使用 `--no-auth`：

```ts
const client = createLappClient({
  profile,
  provider: "ollama",
  model: "llama3",
  allowUnauthenticated: true,
});
```

```bash
lapp init ~/.lapp \
  --provider ollama \
  --protocol openai-chat-completions \
  --base-url http://localhost:11434/v1 \
  --no-auth \
  --model llama3 \
  --yes
```

`allowUnauthenticated` 会跳过认证头，但其他解析错误仍会快速失败。

## 实用建议

- 所有真实密钥都使用 `env://`。
- 不要提交包含 `plaintext` 密钥的 `.lapp` 配置。
- 任何认证相关改动后运行 `lapp doctor`。
- 将 `--reveal-secrets` 和 `--allow-plaintext` 视为特权操作。
- 保持 `baseUrl` 稳定；轮换密钥通常只需要改环境变量。
