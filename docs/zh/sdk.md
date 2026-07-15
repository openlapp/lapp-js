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
import { refreshModels, writeProfileAtomic } from "@openlapp/lapp";

const abortController = new AbortController();
const result = await refreshModels(profile, "openai", {
  env: { OPENAI_API_KEY: process.env.OPENAI_API_KEY },
  vault,
  signal: abortController.signal,
});

console.log(result.added, result.diagnostics);
await writeProfileAtomic(result.nextProfile, { before: profile });
```

`refreshModels()` 请求一个 Provider 的已配置发现 URL，并返回
`{ nextProfile, added, diagnostics }`。它绝不自行写盘。合并只会补充缺失显示名称，
并按 ID 排序追加未知模型；永不覆盖或删除已有模型。非法 HTTP/JSON/分页会抛出
`ModelRefreshError`，输入保持不变。

凭据选项是 `{ env?, vault?, resolver? }`，其优先级和禁止回退规则与
`resolveConnection()` 相同。测试可以注入 `options.fetch`。`options.signal` 会
传递到每个发现请求；携带凭据的请求拒绝重定向。

## 管理和写入 Profile

管理函数都是不可变函数：

| 函数 | 用途 |
|------|------|
| `createProfile({ rootDir })` | 创建空的内存 Profile。 |
| `upsertProvider(profile, input)` | 添加或 patch Provider；保留未提供字段。 |
| `upsertProviderWithCredential(profile, input, options?)` | 添加或 patch Provider，并应用 SDK 的凭据存储默认值。 |
| `upsertModel(profile, input)` | 添加或 patch 模型；保留未提供字段。 |
| `removeProvider(profile, id)` | 删除未被引用的 Provider。 |
| `removeModel(profile, target)` | 按 ID 或 alias 删除未被引用的模型。 |
| `setDefault(profile, task, target)` | 保存 canonical 任务默认值。 |

使用 `planChanges(before, after)` 预览文件变化；使用
`writeProfileAtomic(after, { before })` 验证并写入标准 JSON。写入会拒绝路径逃逸和
非法 Profile。v1 假定同一时刻只有一个写者。

新增原始凭据时，使用异步的受管写入接口：

```ts
import { upsertProviderWithCredential } from "@openlapp/lapp";

const result = await upsertProviderWithCredential(profile, {
  id: "openai",
  baseUrl: "https://api.openai.com/v1",
  protocols: ["openai-responses"],
  auth: {
    type: "bearer",
    credential: { secret: userInput },
  },
  models: [],
}, { vault });

// Vault 已更新，但磁盘尚未写入。
await writeProfileAtomic(result.profile, { before: profile });
```

省略 `credential.storage` 时默认写入 Vault，credential ID 默认为 `default`。
SDK 从最终 Provider 配置推导绑定，调用方不能自行传入 origin。使用
`{ storage: "env", name: "NAME" }` 只写入 `env://NAME` 引用而不读取环境变量。
只有显式传入 `{ secret, storage: "plaintext" }` 才会把原始密钥放入 Profile，
此时结果包含 `PLAINTEXT_SECRET_IN_USE` warning。

`upsertProviderWithCredential()` 返回
`{ profile, credentialRef?, warnings }`，绝不自行把 Profile 写入磁盘。已有
`AuthConfig` 的调用方仍可使用底层同步 `upsertProvider()`；该函数不管理或解析凭据。

## 直连客户端

```ts
import { createLappClient } from "@openlapp/lapp";

const client = createLappClient({
  profile,
  provider: "openai",
  model: "gpt-4o-mini",
  vault,
  // Provider 内容会写入终端或日志时启用。
  redactSuccessfulSecrets: true,
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

CLI 始终启用 `redactSuccessfulSecrets`，防止上游回显 Vault 凭据并将其写入
stdout。SDK 调用方也可以显式启用；它会在成功内容与凭据字面值相同时改写响应，
所以 SDK 默认关闭。

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

## 错误

公开类型化错误包括 `ProfileValidationError`、`TargetResolutionError`、
`CredentialError`、`MissingEnvSecretError`、`ModelRefreshError` 和
`StreamingUnsupportedError`。协议无交集时使用
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

这些公开错误绝不暴露原生 cause 或凭据值。

完整导出索引见 [API 参考](../../packages/lapp/docs/api.md)。
