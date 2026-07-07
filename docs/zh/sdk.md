# SDK 指南

`@openlapp/lapp` 是 LAPP 的 TypeScript SDK。它可以读取、验证、编写、管理 `.lapp` 配置，并直接向配置的提供者发送请求。

## 安装

```bash
npm install @openlapp/lapp
```

需要 Node 18.18 或更高版本。

## 核心模型

```text
.lapp 配置
  -> @openlapp/lapp SDK
  -> 协议适配器
  -> 提供者 API
```

SDK 是核心产品；CLI 只是它的第一个消费者。所有配置逻辑都应放在 SDK 中。

## 加载配置

### `loadProfile(options?)`

读取并验证 `.lapp` 目录。解析顺序：显式 `path` 选项 → `LAPP_HOME` 环境变量 → `~/.lapp`。

```ts
import { loadProfile } from "@openlapp/lapp";

const profile = loadProfile();                          // 默认
const profile = loadProfile({ path: "/etc/lapp" });     // 显式路径
const profile = loadProfile({ skipValidate: true });    // 仅解析，不验证
```

`loadProfile` 返回归一化后的 `LappProfile`。`enabled: false` 的提供者会被保留，以便写回时还原磁盘文件。没有 `models.json` 的提供者其 `models` 为 `null`。

### `resolveLappRoot(explicit?)`

在不加载配置的情况下解析根目录。

```ts
const root = resolveLappRoot();
```

### `inspectProfile(profile, { revealSecrets? })`

人类可读的摘要：脱敏的密钥、每个提供者的模型列表、诊断信息。

```ts
const summary = inspectProfile(profile);
```

`revealSecrets: true` 仅在可信环境中使用。

### `validateProfile(profile)`

同时执行 JSON Schema（ajv）和语义检查（重复别名、全局默认引用是否存在、密钥方案警告、敏感头警告）。返回 `{ valid, diagnostics, errors, warnings, infos }`。

```ts
const result = validateProfile(profile);
```

## 管理配置（纯函数、不可变）

所有变更函数都返回新的 `LappProfile`，不会修改磁盘。

| 函数 | 用途 |
|------|------|
| `createProfile(input)` | 创建内存中的空配置（不写磁盘）。 |
| `upsertProvider(profile, input)` | 插入或更新提供者；未指定的字段会被保留。 |
| `upsertModel(profile, input)` | 在提供者下插入或更新模型。 |
| `removeProvider(profile, id)` | 移除提供者，并清除指向它的默认引用。 |
| `removeModel(profile, { providerId, model })` | 按 id 或别名移除模型，并清除指向它的默认设置。 |
| `replaceProviderModels(profile, id, models)` | 替换某个提供者的整个 `models.json`（同步流程）。 |
| `setDefaultModelRef(profile, key, target)` | 设置任意默认槽位（`defaultModel`、`defaultEmbeddingModel` 等）。 |
| `setDefaultModel(profile, target)` | 设置 `defaultModel`（聊天槽位）的便捷包装。 |
| `isSupportedProtocol(protocol)` | 是否为 3 个 v1 核心协议之一。 |

示例：

```ts
let profile = createProfile({ rootDir: "~/.lapp" });
profile = upsertProvider(profile, {
  id: "openai",
  protocol: "openai-chat-completions",
  baseUrl: "https://api.openai.com/v1",
  auth: { secret: "env://OPENAI_API_KEY" },
});
profile = upsertModel(profile, {
  providerId: "openai",
  id: "gpt-4o",
  type: "chat",
  aliases: ["gpt4o"],
});
profile = setDefaultModel(profile, { providerId: "openai", model: "gpt-4o" });
```

## 计划与写入

### `planChanges(before, after)`

计算文件级别的增/改/删差异。

```ts
const plan = planChanges(before, after);
```

### `writeProfileAtomic(profile, { before? })`

先在内存中验证，然后原子写入：

1. 在内存中构建完整内容。
2. 写入前验证。
3. 写到目标文件同目录的隐藏临时文件。
4. 关闭临时文件。
5. 通过重命名覆盖目标文件。
6. 失败时仅删除临时文件。

没有备份、没有回滚、没有临时目录。传入 `options.before` 可以在写入成功后清理已移除提供者的孤儿 `provider.json`/`models.json`。

```ts
await writeProfileAtomic(profile, { before });
```

新文件以 `.json` 写入；已有的 `.jsonc` 文件会作为 `.json` 目标处理。

## 密钥

| 函数 | 用途 |
|------|------|
| `parseSecretRef(raw)` | 解析 `plaintext` / `env://NAME` / `keychain://` / `file://` 字符串。 |
| `redactSecret(raw)` | 对密钥进行安全展示脱敏。 |
| `resolveSecret(ref, { resolve, env })` | 返回解析后的值或错误。**显式 opt-in**；除非 `resolve: true`，否则不会读取 `process.env`。 |

v1 支持：`plaintext` 和 `env://`。`keychain://` 和 `file://` 会被解析，但运行时抛出 `UnsupportedSecretSchemeError`。

```ts
const ref = parseSecretRef("env://OPENAI_API_KEY");
const value = resolveSecret(ref, { resolve: true });
```

完整策略见 [security.md](security.md)。

## 客户端

### `createLappClient(options)`

解析目标并返回绑定到对应协议适配器的客户端。

```ts
const client = createLappClient({
  profile,
  resolveSecrets: true,  // 真正调用提供者时必须
  env: { OPENAI_API_KEY: "sk-..." },  // 可选覆盖
});
```

目标解析优先级：

1. 显式的 `provider` / `model` 选项。
2. `global.defaultModel`（仅在兼容时）。
3. 第一个启用提供者的第一个启用模型。

选项：

- `provider`、`model` — 显式目标
- `resolveSecrets` — 显式 opt-in 解析密钥
- `allowUnauthenticated` — 跳过认证头，用于本地/自托管提供者
- `env` — 环境变量覆盖
- `fetchImpl` — 自定义 `fetch` 实现

### 客户端方法

| 方法 | 返回 | 说明 |
|------|------|------|
| `client.chat(input)` | `Promise<LappResponse>` | 非流式。如果 `input.stream: true` 会抛出错误（请用 `stream()`）。 |
| `client.rawChat(input)` | `Promise<unknown>` | 返回提供者原生响应。 |
| `client.stream(input)` | `AsyncIterable<LappStreamEventUnion>` | `delta` / `tool-call` / `usage` / `finish` / `error`。 |
| `client.executeWithTools(input, tools, handlers, options?)` | `Promise<{ text, turns, messages }>` | 多轮工具调用循环。 |
| `client.testConnection()` | `Promise<TestConnectionResult>` | 发送 1 token 探测请求。 |
| `client.providerId` / `client.model` / `client.protocol` | `string` | 解析后的目标。 |

### `LappResponse`

```ts
{
  text: string;
  provider: string;
  model: string;
  protocol: string;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  finishReason?: string;
  toolCalls?: ParsedToolCall[];
  raw: unknown;  // 完整的提供者原始响应，未改动
}
```

### 流式输出

```ts
for await (const ev of client.stream({ messages })) {
  if (ev.kind === "delta") process.stdout.write(ev.text);
  if (ev.kind === "tool-call") console.log("tool:", ev.name, ev.arguments);
  if (ev.kind === "usage") console.log("usage:", ev.inputTokens, ev.outputTokens);
  if (ev.kind === "finish") console.log("finish:", ev.reason);
  if (ev.kind === "error") console.error("error:", ev.message);
}
```

## 配置查询

### `listModels(profile, options?)`

将配置展平为每个模型一条记录。

```ts
const models = listModels(profile, { providerId: "openai" });
// [{ providerId, modelId, protocol, baseUrl, type, capabilities, ... }, ...]
```

选项：`providerId`、`includeDisabled`、`includeDisabledModels`。

## 模型同步

| 函数 | 用途 |
|------|------|
| `fetchProviderModels(profile, providerId, options?)` | 从提供者的 `/models` 端点获取模型列表。Anthropic 没有 `links.models` 时抛出 `ModelSyncUnsupportedError`。 |
| `buildModelSyncResult(before, fetched, protocol)` | 计算 `{ models, added, removed, updated }` 差异。 |
| `syncProviderModels(profile, providerId, options?)` | 一次完成获取 + 差异计算。 |
| `applySyncedModels(before, result)` | 合并到 `ModelsConfig`，保留用户编辑的字段。结果会标记 `__lappUpdatedAtSource: "sync"`，以便写入时重新生成 `updatedAt`。 |

## 环境变量导出

### `exportEnv(profile, { format, resolve?, allowPlaintext? })`

为配置中的密钥生成 shell 语句。

```ts
const out = exportEnv(profile, { format: "bash", resolve: true, allowPlaintext: false });
```

`resolve: true` 才能读取 `process.env`；`allowPlaintext: true` 才能包含明文密钥。

## 错误类型

| 错误 | 抛出时机 |
|------|----------|
| `TargetResolutionError` | 找不到提供者/模型、所有提供者被禁用、没有启用模型。 |
| `UnsupportedProtocolError` | 提供者的协议不是 3 个 v1 核心协议之一。 |
| `MissingEnvSecretError` | 使用 `env://NAME` 但 `process.env[NAME]` 未设置。 |
| `UnsupportedSecretSchemeError` | 使用 `keychain://` 或 `file://` 方案（v1 限制）。 |
| `ModelSyncUnsupportedError` | 对没有公开模型列表的协议执行同步。 |
| `StreamingUnsupportedError` | 协议适配器没有 `parseStream`。 |

## TypeScript 定义

`dist/index.d.ts` 是类型的权威来源。符号索引见 [packages/lapp/docs/api.md](../../packages/lapp/docs/api.md)。
