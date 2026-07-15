# LAPP v1 规范

LAPP（Local AI Provider Profiles）是供 AI 应用使用的本机 Provider Registry。应用可以用它发现已配置模型，把选中的模型解析成上游 URL 和凭据，然后直接与上游通信。

LAPP 是文件约定，不定义 daemon、gateway、proxy、路由服务、计费系统或远程控制面。应用可以自行读取文件，也可以调用实现本规范的 SDK 或 CLI。

## 根目录与文件

默认根目录是 `~/.lapp`。应用可以支持 `LAPP_HOME`；设置后，它表示完整根目录并优先于默认位置。

```text
~/.lapp/
├── providers/
│   └── <providerId>/
│       ├── provider.json
│       └── models.json
└── global.json
```

- `providers/` 中每个目录代表一个 provider。
- 每个 provider 目录同时包含 `provider.json` 和 `models.json`。
- `global.json` 可选。
- LAPP v1 文件只能是 UTF-8 标准 JSON，不支持 JSONC 或其他扩展名。
- `manifest.json` 在 LAPP v1 中没有语义。

三种文档都必须包含 `"schemaVersion": "1.0"`。实现必须拒绝不支持的版本。核心对象不接受未知字段；实现自定义数据只能放入 `extensions`。

[`schema/`](./schema/) 定义文件形状。下文补充 JSON Schema 无法表达的跨文件与安全约束。

## 标识符

Provider ID 必须匹配：

```text
^[a-z0-9][a-z0-9._-]{0,63}$
```

它不能是 Windows 保留设备名（大小写不敏感的 `CON`、`PRN`、`AUX`、`NUL`、`COM1`–`COM9` 或 `LPT1`–`LPT9`，包括带扩展名的保留 basename），也不能以点结尾。Provider 目录名必须与 `provider.id` 完全一致。实现必须拒绝非法 ID，不得把 ID 清洗后当作文件名。

Model ID 是发送给上游的原始字符串，可以包含 `/`，但不能是空字符串、纯空白或含控制字符。同一 provider 内的全部 model ID 和 alias 共用一个唯一命名空间。

## provider.json

```json
{
  "schemaVersion": "1.0",
  "id": "deepseek",
  "name": "DeepSeek",
  "enabled": true,
  "baseUrl": "https://api.deepseek.com",
  "protocols": ["openai-chat-completions"],
  "auth": {
    "type": "bearer",
    "secret": "vault://deepseek/default"
  },
  "modelDiscovery": {
    "protocol": "openai-models",
    "url": "https://api.deepseek.com/models"
  }
}
```

字段：

- `schemaVersion`、`id`、`baseUrl`、`protocols` 和 `auth` 必填。
- `name` 是可选显示名称。
- `enabled` 缺省为 `true`。
- `baseUrl` 是上游 API 基础地址。OpenAI-compatible 实现不得猜测或插入版本路径；协议明确定义的 endpoint 路径仍需应用。
- `protocols` 是非空、有序协议 ID 列表。
- `requestHeaders` 保存可选的非密钥静态 HTTP 头。
- `modelDiscovery` 启用显式远端模型刷新。
- `extensions` 保存带命名空间的实现自定义数据。

### 协议选择

核心对话协议 ID 为：

- `openai-chat-completions`
- `openai-responses`
- `anthropic-messages`

可以保存其他符合语法的 ID。实现无法执行时必须返回 unsupported-protocol 错误，不能静默改成另一种协议。

协议顺序就是偏好顺序。应用声明支持协议集合后，选择模型候选中第一个属于该集合的协议；应用未传支持集合时选择第一个候选。模型存在 `model.protocols` 时以它为候选，否则继承 `provider.protocols`。

### URL

`baseUrl` 和 `modelDiscovery.url` 必须是绝对 URL，不能带用户名、密码或 fragment。远端 URL 必须使用 HTTPS；只有 loopback 主机（`localhost`、`127.0.0.0/8` 和 `::1`）可以使用 HTTP。

协议在 `baseUrl` 下定义 endpoint 时，实现必须把它追加到 URL pathname，而不是拼接到序列化 URL 字符串，并保留已配置的 query 参数。

存在 `modelDiscovery` 时，其 URL 必须与 `baseUrl` 同源。带认证的请求必须使用 `redirect: error` 或等价行为，凭据绝不能跟随重定向。

### 认证

`auth` 必须严格匹配以下一种：

```json
{ "type": "none" }
{ "type": "bearer", "secret": "vault://deepseek/default" }
{ "type": "header", "name": "X-Custom-Key", "secret": "env://API_KEY" }
{ "type": "query", "name": "api_key", "secret": "explicit-plaintext-secret" }
```

任何认证类型都没有隐式 fallback。Bearer 生成 `Authorization: Bearer <value>`；header 和 query 使用配置的 `name`，不会自动增加前缀。

LAPP v1 只支持三种 secret：

- `env://NAME`，其中 `NAME` 是合法环境变量名；
- `vault://<providerId>/<credentialId>`，两个 ID 都必须匹配 `^[a-z0-9][a-z0-9._-]{0,63}$`、不能使用 Windows 保留设备 basename 或以点结尾，且 provider 段必须与 `provider.id` 完全一致；
- 非空明文字符串。

`env://` 与 `vault://` 必须精确匹配上述形式。Vault 引用不能含百分号编码、额外路径、query、fragment、userinfo 或端口。格式错误的 `env:` 或 `vault:` 值是非法引用，不能按明文处理。其他 URI scheme（包括 `file://` 和 `keychain://`）在 v1 中非法。校验器应对明文给出警告，因为明文更容易泄漏。新建凭据的工具收到 raw secret 时应默认写入 `vault://`；写入明文必须由用户显式选择。Secret 值绝不能写入诊断、模型数据或日志。

### 设备 Vault

Vault 引用指向由当前 OS 用户账户保护的凭据记录。它不属于某个特定 LAPP root，因此同一 OS 用户下运行的兼容 LAPP 应用可以共享该记录。存储映射固定为：

```text
service = dev.lapp.vault.v1
account = <providerId>/<credentialId>
value   = VaultEnvelopeV1 JSON
```

存储的 JSON envelope 为：

```json
{
  "version": 1,
  "providerId": "deepseek",
  "credentialId": "default",
  "origin": "https://api.deepseek.com",
  "auth": { "type": "bearer" },
  "secret": "..."
}
```

Envelope 必须且只能包含图示字段。`version` 是整数 `1`；两个 ID 遵循引用语法；`secret` 是不含 CR 或 LF 的非空字符串。`origin` 是 `baseUrl` 按标准 URL 规则序列化后的 origin；URL path 不参与绑定。Auth 绑定只能精确匹配 `{ "type": "bearer" }`、`{ "type": "header", "name": "<lowercase-name>" }` 或 `{ "type": "query", "name": "<exact-name>" }`。Header 名转为小写后绑定，因此大小写不敏感；query 参数名保持大小写敏感。

返回 Vault secret 前，实现必须校验 envelope 版本与身份，并要求 provider ID、credential ID、origin 和 auth 绑定完全匹配。绑定不符时必须失败，不能自动 rebind。后端不可用、记录不存在或记录损坏属于运行时凭据错误，不是 profile Schema 错误。实现绝不能静默回退到明文、环境变量、文件或另一份凭据。

设备 Vault 只保护静态存储中的凭据，不构成不可导出的凭据边界。获准解析记录的应用会得到可用 secret。LAPP v1 不定义逐应用访问控制、daemon、跨设备同步、主密码、自动迁移或备份。删除 profile 或应用时，不得隐式删除共享 Vault 记录。

HTTP header 名必须是合法 token，值不能含 CR 或 LF。`requestHeaders` 不得包含凭据，包括 Authorization、代理认证、Cookie 或 API-key 头；认证只能配置在 `auth` 中。
`requestHeaders` 名称按大小写不敏感规则必须唯一，也不得重复 header auth 配置的名称。

### 模型发现

`modelDiscovery.protocol` 只能是 `openai-models` 或 `anthropic-models`。URL 必须显式配置，实现不得猜测或自动追加 models 路径。

远端刷新是显式操作，必须：

1. 解析当前 provider 的 auth，并对 Vault 引用校验存储绑定；
2. 请求配置的同源 URL 且禁止跟随重定向；
3. 拒绝非 2xx、格式错误或不完整响应；
4. 归一化返回的 model ID 和可选显示名称；
5. 返回建议的新 profile，不自动写盘。

合法空列表不产生改动。刷新只把远端新 ID 按 ID 排序后追加到现有列表末尾；可以填充本地缺失的显示名称，但不能覆盖任何已有本地字段，也不能删除本地模型。

## models.json

```json
{
  "schemaVersion": "1.0",
  "models": [
    {
      "id": "deepseek-v4-flash",
      "name": "DeepSeek V4 Flash",
      "aliases": ["ds-v4-flash"],
      "protocols": ["openai-chat-completions"],
      "type": "chat",
      "inputModalities": ["text"],
      "outputModalities": ["text"],
      "capabilities": ["chat", "stream", "tool-call"],
      "contextWindow": 1000000,
      "maxOutputTokens": 384000,
      "enabled": true
    }
  ]
}
```

模型只有 `id` 必填，`enabled` 缺省为 `true`。`name`、`aliases`、`type`、模态、能力、正整数 token 限制和 `extensions` 都是本地描述数据。

存在 `protocols` 时，它必须是 provider protocols 的非空子集；缺省时继承 provider 的有序 protocols。

`models.json` 是本地权威模型目录。远端返回值只是发现输入，不是第二套事实源。应用不得根据模型名称猜测能力。

## global.json

```json
{
  "schemaVersion": "1.0",
  "defaults": {
    "chat": {
      "providerId": "deepseek",
      "modelId": "deepseek-v4-flash"
    }
  }
}
```

`defaults` 把操作名映射到 canonical provider 和 model ID。操作名是 `chat`、`embedding`、`text-to-speech` 之类的小写标识符。

默认值必须用 canonical ID 引用现有且启用的 provider 和 model，不能把 alias 写入 `global.json`。没有 `global.json` 的 profile 仍然合法。

## 连接解析

输入 `{ providerId, model }` 或默认操作名后，实现必须：

1. 必要时先解析 default；
2. 找到存在且启用的 provider；
3. 在该 provider 的 model ID 与 aliases 中解析 `model`，歧义时报错；
4. 确认模型启用，并把 alias 归一成 canonical model ID；
5. 按前述有序交集规则选择协议；
6. 验证 URL 和静态 headers；
7. 解析 secret、执行 Vault 绑定校验，并且只构造一种认证方式；
8. 返回 canonical provider ID、model ID、protocol、base URL、headers 和仅存在于内存的 auth 值。

读取模型列表不得解析 secret 或访问网络。只有连接解析和显式刷新需要凭据。

## 校验与写入

实现必须先用对应版本的 Schema 校验每个文件，再执行语义规则。每次写入和删除前，都必须解析目标绝对路径，并证明它仍在选定的 LAPP 根目录内。更新文件应在同目录写临时文件，再原子 rename。

LAPP v1 假定同一时间只有一个写入者，不定义锁、profile 级事务、合并行为或旧 draft 迁移。Vault 写入与 profile 文件写入是两个独立操作；组合执行它们的工具在 profile 写入失败时应恢复 Vault 原值，如果恢复也失败，必须返回明确的 partial-failure 错误。
