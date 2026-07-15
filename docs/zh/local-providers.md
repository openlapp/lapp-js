# 本地 Provider

LAPP 可以连接实现已声明协议的本地服务。内置预设通过 OpenAI-compatible 地址支持
Ollama、LM Studio 和 vLLM。

Loopback 地址允许使用 HTTP。只有本地服务确实不需要凭据时，才使用
`{ "type": "none" }` 认证。

## Ollama

启动 Ollama，然后注册并刷新模型：

```bash
lapp provider add --id ollama --yes
lapp models refresh --provider ollama
lapp models refresh --provider ollama --apply --yes
lapp models list --provider ollama
```

显式选择返回的模型：

```bash
lapp default set --task chat --provider ollama --model <返回的-id> --yes
lapp chat "你好，Ollama" --default chat
```

等价的完整 Provider 命令为：

```bash
lapp provider add \
  --id ollama \
  --protocol openai-chat-completions \
  --base-url http://localhost:11434/v1 \
  --no-auth \
  --models-protocol openai-models \
  --models-url http://localhost:11434/v1/models \
  --yes
```

## LM Studio

启用本地 API 服务后运行：

```bash
lapp provider add --id lm-studio --yes
lapp models refresh --provider lm-studio --apply --yes
lapp models list --provider lm-studio
lapp default set --task chat --provider lm-studio --model <返回的-id> --yes
```

预设地址为 `http://localhost:1234/v1`。

## vLLM

vLLM 在常用端口监听时运行：

```bash
lapp provider add --id vllm --yes
lapp models refresh --provider vllm --apply --yes
lapp models list --provider vllm
lapp default set --task chat --provider vllm --model <返回的-id> --yes
```

预设地址为 `http://localhost:8000/v1`。

## SDK 调用

不需要额外的“允许无认证”开关。`auth.type: "none"` 就是完整策略：

```ts
import { createLappClient, loadProfile } from "@openlapp/lapp";

const profile = loadProfile();
const client = createLappClient({
  profile,
  provider: "ollama",
  model: "<返回的-id>",
});

const response = await client.chat({
  messages: [{ role: "user", content: "你好" }],
});
```

## 故障排除

- 刷新要求 `provider.json` 配置 `modelDiscovery`；预设会自动配置。
- 发现 URL 必须与 `baseUrl` 同源。
- 合法的远端空列表不会造成变化。
- 已有本地模型和元数据永远不会被删除或覆盖。
- 如果服务返回的能力信息不完整，直接编辑权威 `models.json` 条目。
