# lapp-js

**LAPP**（Local AI Provider Profiles，本地 AI Provider Profile）的官方
TypeScript SDK 与 CLI。LAPP 是开放的本地 Provider Profile 协议：应用发现模型
和连接信息后，直接与上游 Provider 通信。

> **语言：** [English](README.md) | [中文](README_zh.md)

```text
推荐：应用 -> @openlapp/lapp -> 上游 API
直连：应用 -> 读取 ~/.lapp -> 上游 API
CLI： 应用 -> lapp JSON 输出 -> 上游 API
```

应用始终直接与上游 Provider 通信；不存在 daemon、gateway、proxy 或请求路由
服务。官方集成建议使用 SDK，使应用无需自行处理凭据存储细节；直接实现协议和
调用 CLI 仍然是符合规范的开放接入路径。

| 包 | 用途 |
|----|------|
| [`@openlapp/lapp`](docs/zh/sdk.md) | 加载和管理 Profile、列出和刷新模型、解析凭据，也可直接调用支持的聊天 API。 |
| [`@openlapp/cli`](docs/zh/cli.md) | 提供稳定 JSON 输出的轻量命令行包装。 |

## 安装

> 当前包只发布到本机 beta Registry。下面的 npmjs 命令从首次公开 `1.0.0`
> 开始生效；贡献者请使用[本机 beta Registry](dev/registry/README.md)。

```bash
npm install @openlapp/lapp
npm install -g @openlapp/cli
```

需要 Node.js 18.18 或更高版本。

## Profile

LAPP v1 只使用标准 JSON 和三种文件：

```text
~/.lapp/
├── global.json
└── providers/
    └── openai/
        ├── provider.json
        └── models.json
```

`models.json` 是本地权威模型目录。只有显式请求时才访问远端发现地址，而且只会
追加新模型；不会删除模型，也不会覆盖已有本地字段。

完整合同见[配置文档](docs/zh/configuration.md)。

## CLI 快速开始

```bash
export OPENAI_API_KEY=sk-...
lapp provider add --id openai --model gpt-4o-mini --env OPENAI_API_KEY --yes
lapp default set --task chat --provider openai --model gpt-4o-mini --yes
lapp models list --json
lapp resolve --default chat --json
lapp chat "你好" --default chat
```

显式刷新已经配置的远端模型目录：

```bash
lapp models refresh --provider openai                 # 预览
lapp models refresh --provider openai --apply --yes   # 追加新模型
```

CLI 永远不会打印解析后的凭据。交互式输入新的原始 key 时，默认保存到当前用户的
Vault；使用 `--env NAME` 则保留外部管理的环境变量引用。

## SDK 快速开始

```ts
import {
  createLappClient,
  listModels,
  loadProfile,
  resolveConnection,
} from "@openlapp/lapp";

const profile = loadProfile();
const models = listModels(profile);

const connection = await resolveConnection(
  profile,
  { default: "chat" },
  { supportedProtocols: ["openai-responses", "openai-chat-completions"] },
);

// 可以把 connection 交给自己的上游客户端，也可以使用 SDK 的便利客户端：
const client = createLappClient({ profile, default: "chat" });
const response = await client.chat({
  messages: [{ role: "user", content: "你好" }],
});

console.log(models.length, connection.modelId, response.text);
```

`resolveConnection` 在调用时异步解析 plaintext、`env://NAME` 或
`vault://provider/credential`，返回选中的协议、canonical 模型 ID、地址、请求头
和认证信息。Client 会在每次直连请求前重新解析，因此轮换 Vault 后无需重建。

## Manager 状态

目前还没有稳定、受支持的 GUI 正式版。独立的
[`openlapp/lapp-manager`](https://github.com/openlapp/lapp-manager) 仓库已经包含
基于 Tauri 2、Vue 3、TypeScript 与 Naive UI 的 Alpha 实现，并在进程内链接公开的
Rust SDK；不会引入 sidecar、daemon、gateway 或 proxy。当前源码和测试可以证明实现
状态，但签名并完成安装验证的安装包以及稳定 UI 合同仍属于发布工作。

原 `@openlapp/react` 和 `@openlapp/vue` 包继续保持移除。可复用的产品、安全、
无障碍和行为合同由 Manager 文档维护，不再恢复为公开的框架包。

[Electron bridge 示例](examples/electron-manager/README.md)是当前 Node
Manager Host 的非受支持集成参考；它不是完整 GUI，也不是独立 Manager 的实现基础。

## 支持的协议

| 连接协议 | 直连聊天客户端 | 模型发现 |
|----------|----------------|----------|
| `openai-chat-completions` | 聊天、流式、工具 | `openai-models` |
| `openai-responses` | 聊天、流式、工具 | `openai-models` |
| `anthropic-messages` | 聊天、流式、工具 | `anthropic-models` |

Profile 可以保存由应用自行实现的其他协议 ID。SDK 内置聊天客户端遇到这些协议时
会返回 code 为 `PROTOCOL_NOT_SUPPORTED` 的 `TargetResolutionError`，不会猜测
调用方式。

## 文档

- **[入门指南](docs/zh/getting-started.md)**——三种接入方式
- **[CLI 参考](docs/zh/cli.md)**——命令、JSON 输出和退出码
- **[SDK 指南](docs/zh/sdk.md)**——发现、解析、刷新与直连调用
- **[Manager](https://github.com/openlapp/lapp-manager)**——独立的 Tauri/Vue/Naive UI Alpha 源码与合同
- **[本机 beta Registry](dev/registry/README.md)**——私有 Verdaccio 发布与全新安装验证
- [配置文档](docs/zh/configuration.md)——v1 JSON Profile 合同
- [安全说明](docs/zh/security.md)——信任边界和凭据处理
- [协议说明](docs/zh/protocols.md)——协议选择和模型发现
- [本地 Provider](docs/zh/local-providers.md)——Ollama、LM Studio 与 vLLM
- [故障排除](docs/zh/troubleshooting.md)——错误与常见修复
- [用户协议与风险披露](packages/lapp/USER_AGREEMENT.zh-CN.md)——两个包均随包分发的
  安装协议模板
- [API 参考](packages/lapp/docs/api.md) · [CHANGELOG](CHANGELOG.md)

## v1 边界

- 密钥只能是 plaintext、`env://NAME` 或 `vault://provider/credential`。官方 SDK
  默认把新凭据写入当前用户的系统 Vault；创建明文必须显式 opt-in。
- 远端模型刷新是显式、非破坏性的操作，不是后台缓存。
- 同一 OS 用户下的可信进程显式解析连接后，LAPP 不再阻止该进程使用凭据。
- 官方 Profile + Vault 变更共享一个当前用户全局写锁；正常 writer 永远不会按
  年龄、PID 或 heartbeat 偷锁。
- SDK 默认从成功响应中脱敏已解析凭据；只有显式
  `redactSuccessfulSecrets: false` 才保留原文，错误和诊断始终脱敏。

## 许可证

MIT
