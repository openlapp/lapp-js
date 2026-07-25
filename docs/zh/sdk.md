# SDK 指南

`@openlapp/lapp` 是 LAPP v1 本地 Registry 的 TypeScript 实现。它可以加载、验证、
查询、刷新、编辑和写入 Profile。应用可以把解析后的连接交给自己的上游库，也可以
使用内置直连客户端。

```bash
npm install @openlapp/lapp
```

需要 Node.js 18.18 或更高版本。

## 加载与检查

```ts
import { inspectProfile, loadProfile } from "@openlapp/lapp";

const profile = loadProfile();
const other = loadProfile({ path: "/etc/lapp" });
const inspection = inspectProfile();
```

路径解析顺序为显式 `path`、`LAPP_HOME`、`~/.lapp`。

`loadProfile()` 只返回通过验证、标准化的 `LappProfile`；输入非法时抛出
`ProfileValidationError`。返回值保留禁用项，但不包含诊断或源文件元数据。

`inspectProfile({ path? })` 用于处理损坏 Profile。它返回部分 Provider 信息和
脱敏诊断，不暴露密钥值。

使用 `validateProfile(profile)` 验证内存 Profile；使用
`resolveLappRoot(explicit?)` 只解析根目录而不加载文件。

## 列出模型

```ts
import { listModels } from "@openlapp/lapp";

const enabled = listModels(profile);
const openai = listModels(profile, { providerId: "openai" });
const all = listModels(profile, { includeDisabled: true });
```

`listModels()` 是同步纯函数：不执行文件/网络 I/O，也不解析凭据。每个
`ModelDescriptor` 包含 Provider/模型 ID、继承或模型专属协议、地址、启用状态和
本地描述元数据。

## 选择并解析连接

只需要目标元数据、不应接触凭据时，使用同步纯函数：

```ts
import { resolveConnection, selectConnection } from "@openlapp/lapp";

const plan = selectConnection(
  profile,
  { providerId: "openai", model: "fast-chat" }, // ID 或 alias
  { supportedProtocols: ["openai-responses", "openai-chat-completions"] },
);

const selected = selectConnection(profile, { default: "chat" });
```

`selectConnection()` 返回带有未解析 `auth` 和凭据绑定的 `ConnectionPlan`，
不执行文件、环境变量、Vault 或网络 I/O。

可信调用方需要可用认证时，再异步解析：

```ts
const explicit = await resolveConnection(
  profile,
  { providerId: "openai", model: "fast-chat" },
  {
    env: { OPENAI_API_KEY: process.env.OPENAI_API_KEY },
    vault: testVault,
  },
);

const resolvedDefault = await resolveConnection(profile, { default: "chat" });
```

返回值为：

```ts
{
  providerId: string;
  modelId: string;             // canonical ID
  protocol: string;
  baseUrl: string;
  requestHeaders: Record<string, string>;
  auth:
    | { type: "none" }
    | { type: "bearer"; secret: string }
    | { type: "header"; name: string; secret: string }
    | { type: "query"; name: string; secret: string };
}
```

选项是 `{ supportedProtocols?, env?, vault?, resolver? }`。传入 `env` 可使用
显式来源替代 `process.env`；传入 `vault` 可注入 `CredentialVault`；传入
`resolver` 会替代前两者并具有最高优先级。只有遇到 `vault://` 引用时才会延迟
打开系统 Vault。

凭据在内存中解析，返回的连接必须视为敏感数据。禁用或歧义目标、缺失默认值或
凭据、Vault 后端不可用、绑定不符、协议不匹配都会抛出类型化错误。凭据 scheme
之间绝不相互回退。

## 使用凭据 Vault

```ts
import {
  createCredentialResolver,
  openSystemCredentialVault,
} from "@openlapp/lapp";

const vault = await openSystemCredentialVault();
const resolver = createCredentialResolver({ vault });
```

`openSystemCredentialVault()` 打开当前 OS 用户原生凭据库的适配器。它不会创建
加密文件，也绝不回退到环境变量或明文。缺少原生模块会让此调用失败；系统凭据
服务不可用可能在第一次操作时失败。两者都会使用
`CredentialError.code === "VAULT_BACKEND_UNAVAILABLE"`。

Vault 引用的固定形式是 `vault://<providerId>/<credentialId>`。系统记录使用
service `dev.lapp.vault.v1` 和 account `<providerId>/<credentialId>`。

`CredentialVault` 提供：

```ts
await vault.put(reference, secret, binding, { overwrite: false });
const secret = await vault.resolve(reference, binding);
const status = await vault.status(reference, binding);
const deleted = await vault.delete(reference);
```

存储的 envelope 严格绑定 Provider ID、标准化精确 origin（不含 base URL 路径）和
认证 type/name。Header 名转为小写；query 参数名保持大小写敏感。任何绑定字段
改变后，解析都会以 `VAULT_BINDING_MISMATCH` 失败；应重新录入凭据，不能静默
重新绑定。

`createCredentialResolver({ env?, vault? })` 处理明文、`env://NAME` 和
`vault://provider/credential`。`resolve(raw, binding)` 返回可用密钥；
`status(raw, binding)` 在不暴露密钥的前提下报告 scheme、可用性，以及已有 Vault
记录的绑定状态。它延迟打开系统 Vault，也不缓存明文。

Vault 保护的是静态存储，不是应用沙箱：同一 OS 用户下的兼容应用在成功解析后
可以得到明文密钥。

## 刷新模型

```ts
import { refreshModels } from "@openlapp/lapp";

const abortController = new AbortController();
const result = await refreshModels(profile, "openai", {
  env: { OPENAI_API_KEY: process.env.OPENAI_API_KEY },
  vault,
  signal: abortController.signal,
});

console.log(result.added, result.diagnostics);
```

`refreshModels()` 请求一个 Provider 的已配置发现 URL，并返回
`{ nextProfile, added, diagnostics }`。它绝不自行写盘。合并只会补充缺失显示名称，
并按 ID 排序追加未知模型；永不覆盖或删除已有模型。非法 HTTP/JSON/分页会抛出
`ModelRefreshError`，输入保持不变。

凭据选项是 `{ env?, vault?, resolver? }`，其优先级和禁止回退规则与
`resolveConnection()` 相同。测试可以注入 `options.fetch`。`options.signal` 会
传递到每个发现请求；携带凭据的请求拒绝重定向。
请按下文示例，把 `result.nextProfile` 与稳定读取获得的 revision 一起交给
`commitProfileTransaction()` 提交。

## 管理和写入 Profile

管理函数都是不可变函数：

| 函数 | 用途 |
|------|------|
| `createProfile({ rootDir })` | 创建空的内存 Profile。 |
| `upsertProvider(profile, input)` | 添加或 patch Provider；保留未提供字段。 |
| `prepareProviderUpdate(profile, input)` | 纯函数式准备 Provider 与可选待提交 Vault 写入，并应用 SDK 凭据存储默认值。 |
| `upsertModel(profile, input)` | 添加或 patch 模型；保留未提供字段。 |
| `removeProvider(profile, id)` | 删除未被引用的 Provider。 |
| `removeModel(profile, target)` | 按 ID 或 alias 删除未被引用的模型。 |
| `setDefault(profile, task, target)` | 保存 canonical 任务默认值。 |

使用 `planChanges(before, after)` 预览文件变化。公开的
`writeProfileAtomic(after, { before })` 底层 primitive 会验证并写入标准 JSON，
但不会自行取得全局锁或执行 CAS；专用集成必须同时补齐两者。官方 Profile-only、
Vault-only 和组合变更统一使用 `commitProfileTransaction()`：它持有当前用户全局
写锁，强制要求预期 revision，在第一次副作用前再次检查，并协调回滚。

Node Manager Host 对渲染器暴露的是另一种 opaque revision：它组合 canonical
Profile revision 与 Manager 自己维护的 Vault generation。因此，即使仅轮换 Vault、
Profile 字节没有变化，旧 snapshot 也会失效并返回 `PROFILE_CONFLICT`。

新增原始凭据时，先准备，再执行一次受锁事务：

```ts
import {
  commitProfileTransaction,
  loadProfile,
  prepareProviderUpdate,
  readStable,
  resolveLappRoot,
} from "@openlapp/lapp";

const root = resolveLappRoot();
const current = readStable(root, () => loadProfile({ path: root }));
const prepared = prepareProviderUpdate(current.value, {
  id: "openai",
  baseUrl: "https://api.openai.com/v1",
  protocols: ["openai-responses"],
  auth: {
    type: "bearer",
    credential: { secret: userInput },
  },
  models: [],
});

await commitProfileTransaction({
  rootDir: root,
  before: current.value,
  next: prepared.profile,
  expectedRevision: current.revision,
  ...(prepared.vaultWrite ? { vaultWrite: prepared.vaultWrite } : {}),
});
```

省略 `credential.storage` 时默认写入 Vault，credential ID 默认为 `default`。
SDK 从最终 Provider 配置推导绑定，调用方不能自行传入 origin。使用
`{ storage: "env", name: "NAME" }` 只写入 `env://NAME` 引用而不读取环境变量。
只有显式传入 `{ secret, storage: "plaintext" }` 才会把原始密钥放入 Profile，
此时结果包含 `PLAINTEXT_SECRET_IN_USE` warning。

`prepareProviderUpdate()` 返回
`{ profile, credentialRef?, vaultWrite?, warnings }`，没有任何副作用。
`commitProfileTransaction()` 在同一个全局锁内用 CAS 与回滚提交可选 Vault 写入和
Profile。已有
`AuthConfig` 的调用方仍可使用底层同步 `upsertProvider()`；该函数不管理或解析凭据。

## 桌面 Manager Host

Node 嵌入应用可以把 Profile、Vault 与 Provider 连接测试权限留在可信进程。
历史 host bridge 从显式 Node-only 子路径导入：

```ts
import { createNodeLappManagerHost } from "@openlapp/lapp/manager-host";

const host = createNodeLappManagerHost({
  path: process.env.LAPP_HOME,
});
```

Renderer 与 preload 只应从 browser-safe contract 子路径导入类型和协议版本：

```ts
import type { LappManagerBridgeV1 } from "@openlapp/lapp/manager-contract";
```

`LappManagerBridgeV1` 只暴露五项窄能力：`handshake()`、`getSnapshot()`、
`transact()`、`testConnection()` 与可选 `subscribe()`。Snapshot 含不透明 revision
和脱敏后的 Profile/凭据状态，绝不包含明文凭据。变更使用带预期 revision 的语义
`ManagerOperation`。Node Host 会串行事务、通过当前用户全局跨进程锁协调官方
writer、在修改前重新核对 revision，并在后续 Profile 提交失败时恢复 Vault 记录。

Bridge 不提供凭据 get、resolve、export 或 rebind 操作。绑定不匹配时必须先保存预期
Provider 配置，再重新录入凭据。不要向 renderer 暴露底层 `CredentialVault`、文件
系统、网络、事务 helper 或通用 IPC API。

SDK 为 CLI 等官方 writer 集成公开
`commitProfileTransaction()`、`computeProfileRevision()`、`readProfileStable()`、`readStable()`、
`withWriterLock()`、`inspectWriterLock()` 与 `repairWriterLock()`。所有
`LAPP_HOME` 通过 `LAPP_STATE_HOME` 共享当前 OS 用户写锁；正常 writer 不会按
年龄、PID 或 heartbeat 偷锁。修复必须由 operator 显式执行，并提供刚观察到的
owner token。合同见[API 参考](../../packages/lapp/docs/api.md)。

目前还没有稳定、受支持的 GUI 正式版。
[`openlapp/lapp-manager`](https://github.com/openlapp/lapp-manager) 已包含当前的
Tauri/Vue/Naive UI Alpha 实现及其合同；Electron 示例仅保留为已过时的历史原型。

## 直连客户端

```ts
import { createLappClient } from "@openlapp/lapp";

const client = createLappClient({
  profile,
  provider: "openai",
  model: "gpt-4o-mini",
  vault,
});

const response = await client.chat({
  messages: [{ role: "user", content: "你好" }],
  maxTokens: 200,
});
```

`provider` 和 `model` 必须同时提供；也可以都省略并使用 `default`（默认为
`chat`）。工厂函数会同步选择并验证目标，但不会解析凭据。每次 Provider 操作都会
在使用前即时解析当前凭据；client 不缓存已解析明文，因此 Vault 轮换会在下一次
操作生效。发送认证信息前，client 会再次核对最终请求 origin，并使用
`redirect: "error"`。

`redactSuccessfulSecrets` 默认为 `true`，上游即使回显已解析凭据，也不会把它
放进成功响应对象或 stream event。只有必须原样保留上游成功响应时才显式设为
`false`。错误、日志和诊断始终脱敏。

客户端方法：

| 方法 | 结果 |
|------|------|
| `chat(input)` | 标准化 `LappResponse`。 |
| `rawChat(input)` | Provider 原生响应。 |
| `stream(input)` | 异步 `delta`、`tool-call`、`usage`、`finish`、`error` 事件。 |
| `executeWithTools(input, tools, handlers, options?)` | 完整工具循环文本、轮次和 transcript。 |
| `testConnection()` | 小型直连请求结果。 |

`ChatInput.extra` 可以添加 Provider 原生字段，但不能覆盖目标、messages/input、
stream、tools 或认证字段。`AbortSignal` 会传到底层请求。工具参数必须能解析为对象
并通过工具 JSON Schema 后，handler 才会执行。

## 多媒体生成客户端

根包还导出四个彼此独立的工厂：`createImageGenerationClient`、
`createVideoGenerationClient`、`createSpeechSynthesisClient` 和
`createMusicGenerationClient`。图片与语音分别使用通用 `openai-images` 和
`openai-audio-speech` wire。视频与音乐提供稳定的输入、Job、wait、stream、输出 part
和错误类型，但 LAPP 1.0 不内置其 wire Adapter；因此构造时会在解析凭据或访问网络前
返回 `PROTOCOL_NOT_SUPPORTED`。

```ts
const image = createImageGenerationClient({ profile });
const result = await image.generate({
  prompt: "一个小红圆",
  count: 1,
  size: { width: 1024, height: 1024 },
  outputFormat: "png",
});

const speech = createSpeechSynthesisClient({ profile });
for await (const event of speech.stream({ text: "你好", voice: "alloy" })) {
  if (event.kind === "audio") consume(event.bytes);
}
```

每个工厂只按模型或 Provider 声明的协议顺序选择第一个已支持协议；不会读取
`providerType`，不会根据 ID/URL 猜供应商、探测服务端或静默切换 wire。`extra` 只能
使用 Adapter 白名单，不能覆盖保留字段。URL artifact 不会自动下载；必须调用
`downloadArtifact(artifact, { maxBytes })`。Provider 认证仅发送给同源 artifact URL，
并拒绝重定向。`wait()` 默认每 2 秒轮询、30 分钟超时；本地超时或终止不代表远端取消。

## 错误

公开类型化错误还包括 `ProfileLockedError`、`ProfileLockInvalidError`、
`ProfileReadUnstableError`、`ProfileRevisionConflictError`、
`ProfilePathInvalidError` 与 `ProfileUpdatePartialFailureError`，以及
`ProfileValidationError`、`TargetResolutionError`、`CredentialError`、
`MissingEnvSecretError`、`ModelRefreshError` 和 `StreamingUnsupportedError`。
协议无交集时使用
`TargetResolutionError.code === "PROTOCOL_NOT_SUPPORTED"`。

应匹配稳定的 `CredentialError.code`，不要匹配已经脱敏的 message：

```text
INVALID_SECRET_REFERENCE
UNSUPPORTED_SECRET_SCHEME
ENV_SECRET_MISSING
VAULT_BACKEND_UNAVAILABLE
VAULT_CREDENTIAL_NOT_FOUND
VAULT_CREDENTIAL_EXISTS
VAULT_RECORD_INVALID
VAULT_BINDING_MISMATCH
VAULT_ACCESS_DENIED
VAULT_OPERATION_FAILED
CREDENTIAL_UPDATE_PARTIAL_FAILURE
```

这些公开错误绝不暴露原生 cause 或凭据值。组合事务一旦已经修改 Vault，
只要 Profile 回滚或 Vault 恢复任一不完整，顶层就使用凭据 partial-failure
code；Profile 回滚不完整时，稳定的 `causes` 还包含
`PROFILE_UPDATE_PARTIAL_FAILURE`。即使两类恢复同时失败，也仍由凭据 code
确定性优先。

完整导出索引见 [API 参考](../../packages/lapp/docs/api.md)。
