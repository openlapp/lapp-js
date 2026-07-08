# @openlapp/lapp

[LAPP](https://github.com/openlapp/lapp)（Local AI Provider Profiles，本地 AI 提供者配置）的 TypeScript SDK。

读取、验证、编写、管理 `.lapp` 配置，并直接调用提供者 —— 不是网关，没有持久化服务器。

> **Languages:** [English](https://github.com/openlapp/lapp-js/blob/main/README.md) | [中文](https://github.com/openlapp/lapp-js/blob/main/README_zh.md)

## 安装

```bash
npm install @openlapp/lapp
```

需要 Node 18.18 或更高版本。

## 快速开始

```ts
import { loadProfile, createLappClient } from "@openlapp/lapp";

const profile = loadProfile();                  // 解析 ~/.lapp
const client = createLappClient({
  profile,
  provider: "openai",
  model: "gpt-4o",
  resolveSecrets: true,
});

const resp = await client.chat({
  messages: [{ role: "user", content: "你好！" }],
});
console.log(resp.text);
```

## 功能

- **加载并验证**磁盘上的 `.lapp` 配置。
- **管理**提供者、模型和默认值，使用纯函数且不可变。
- **原子写入**配置（内存中验证、写临时文件、重命名覆盖目标）。
- **调用提供者**通过 `createLappClient` 选择对应协议适配器。
- **导出密钥**为 shell 语句，供从环境变量读取密钥的工具使用。

## 文档

- [SDK 指南](https://github.com/openlapp/lapp-js/blob/main/docs/zh/sdk.md)
- [API 参考](https://github.com/openlapp/lapp-js/blob/main/packages/lapp/docs/api.md)
- [配置文件](https://github.com/openlapp/lapp-js/blob/main/docs/zh/configuration.md)
- [安全说明](https://github.com/openlapp/lapp-js/blob/main/docs/zh/security.md)
- [故障排除](https://github.com/openlapp/lapp-js/blob/main/docs/zh/troubleshooting.md)

TypeScript 定义以 `dist/index.d.ts` 为准。

## 许可证

MIT
