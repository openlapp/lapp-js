# 入门指南

LAPP 让 AI 应用共享一个本地 Provider 与模型 Registry。应用仍然直接向选中的
上游 API 发送请求。

选择最适合应用的最小接入方式：

1. 直接读取 JSON Profile，自行实现 LAPP 规则。
2. 在 TypeScript 中使用 `@openlapp/lapp`。
3. 调用 `lapp`，消费稳定的 JSON 输出。

## 安装

```bash
npm install @openlapp/lapp
npm install -g @openlapp/cli
```

需要 Node.js 18.18 或更高版本。

## 创建 Profile

CLI 是创建标准 Provider 两文件结构的最快方式；设置默认值时才会创建
`global.json`。预设会补充已知地址、协议、认证结构和模型发现 URL。

```bash
export OPENAI_API_KEY=sk-...
lapp provider add --id openai --model gpt-4o-mini --env OPENAI_API_KEY --yes
lapp validate
lapp models list
```

自定义上游需要显式提供字段：

```bash
lapp provider add \
  --id custom \
  --base-url https://ai.example.com/v1 \
  --protocol openai-chat-completions \
  --env CUSTOM_AI_KEY \
  --models-protocol openai-models \
  --models-url https://ai.example.com/v1/models \
  --model chat-model \
  --yes
```

交互式输入原始 key 时可以省略 `--env`：CLI 会无回显提示，并保存为
`vault://<provider>/default`。非交互原始输入使用
`--vault <credential-id> --stdin`。不需要凭据的 loopback Provider 使用
`--no-auth`。写命令会先展示文件计划并要求 `--yes`；`--dry-run` 不会写 Profile
或 Vault。

## 刷新本地模型目录

`models.json` 始终是权威目录。刷新是显式且非破坏性的操作：

```bash
lapp models refresh --provider openai                 # 预览新增项
lapp models refresh --provider openai --apply --yes   # 写入新增项
```

刷新保留所有已有模型和本地字段。默认值需要单独设置：

```bash
lapp default set --task chat --provider openai --model gpt-4o-mini --yes
```

## 方式一：直接读取 Profile

任何语言的应用都可以读取 `global.json`、`provider.json` 和 `models.json`。符合规范
的实现仍须执行 Schema 与语义规则：目录与 ID 一致、ID/alias 唯一、启用状态、
协议选择、同源模型发现、严格认证、密钥引用 grammar 以及 canonical 默认值。没有
Vault 后端的实现仍须识别 `vault://`，只有真正执行需要凭据的远端操作时才显式
报不支持。

当项目不希望引入 TypeScript 依赖或子进程时，可采用这种方式。完整文件合同见
[配置文档](configuration.md)。

## 方式二：使用 TypeScript SDK

```ts
import {
  listModels,
  loadProfile,
  refreshModels,
  resolveConnection,
} from "@openlapp/lapp";

const profile = loadProfile();

const models = listModels(profile, { providerId: "openai" });

const connection = await resolveConnection(
  profile,
  { providerId: "openai", model: "gpt-4o-mini" },
  { supportedProtocols: ["openai-responses", "openai-chat-completions"] },
);

// connection 包含 canonical 模型 ID、地址、请求头与解析后的认证信息。

const preview = await refreshModels(profile, "openai");
console.log(preview.added);
// 只有应用决定应用变更后，才持久化 preview.nextProfile。
```

`listModels()` 是纯函数，不进行 I/O 或密钥解析。`resolveConnection()` 异步解析
选中连接的凭据。`refreshModels()` 只请求一个已配置发现地址，返回新的内存
Profile，不会自行写盘。

SDK 还提供直连聊天的 `createLappClient()`：

```ts
import { createLappClient } from "@openlapp/lapp";

const client = createLappClient({ profile, default: "chat" });
const response = await client.chat({
  messages: [{ role: "user", content: "你好" }],
});
console.log(response.text);
```

## 方式三：消费 CLI JSON

```bash
lapp models list --json
lapp resolve --default chat --protocol openai-responses --json
```

机器输出始终是一个 `{"version":1,"data":...}` 文档。CLI 永远不会输出解析后的
凭据；`resolve` 只报告 scheme 与状态，`credential status` 检查已知 Vault 引用
时也不会泄露内容。完整命令面和退出码见 [CLI 参考](cli.md)。

## 下一步

- [SDK 指南](sdk.md)
- [配置文档](configuration.md)
- [安全说明](security.md)
- [协议说明](protocols.md)
- [本地 Provider](local-providers.md)
- [故障排除](troubleshooting.md)
