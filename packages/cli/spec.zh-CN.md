# LAPP 1.1 规范

LAPP（Local AI Provider Profiles）是供 AI 应用使用的本机 Model Source Registry。LAPP 1.0 定义 API-key 风格的 provider；LAPP 1.1 在保留全部合法 1.0 profile 的同时，新增通过用户授权订阅访问模型的 Auth Model Source。

LAPP 是文件约定，不定义 daemon、gateway、proxy、路由服务、计费系统或远程控制面。应用可以自行读取文件，也可以调用实现本规范的 SDK 或 CLI。

## 根目录与文件

默认根目录是 `~/.lapp`。应用可以支持 `LAPP_HOME`；设置后，它表示完整根目录并优先于默认位置。

```text
~/.lapp/
├── providers/
│   └── <providerId>/
│       ├── provider.json
│       └── models.json
├── auth/
│   └── <authId>/
│       ├── auth.json
│       └── models.json
└── global.json
```

- `providers/` 中每个目录代表一个 provider。
- 每个 provider 目录同时包含 `provider.json` 和 `models.json`。
- LAPP 1.1 的 `auth/` 中每个目录代表一个 Auth Model Source；每个 auth 目录同时包含
  `auth.json` 和 `models.json`。
- `global.json` 可选。
- LAPP v1 文件只能是 UTF-8 编码的 I-JSON，不支持 JSONC 或其他扩展名。
- `manifest.json` 在 LAPP v1 中没有语义。

LAPP 1.0 的 `provider.json`、`models.json` 与 `global.json` 保持
`"schemaVersion": "1.0"` 及冻结的 Schema。LAPP 1.1 新增
`"schemaVersion": "1.1"` 的 `auth.json` 与扩展版 `global.json`；auth 所属的
`models.json` 刻意复用未变化的 1.0 models Schema。`schemaVersion` 是文档版本，
上述受控组合合法，其他组合与未知版本必须拒绝。核心对象不接受未知字段；实现自定义
数据只能放入 `extensions`。

只要 profile 含 `auth/`，就必须同时包含合法的 1.1 `global.json`，否则以
`AUTH_REQUIRES_GLOBAL_1_1` 拒绝。1.0 profile 仍要求 `providers/` 且禁止 `auth/`；
1.1 profile 中 `providers/` 与 `auth/` 可分别省略，但至少一个必须是目录。这个版本门
确保合规的旧 1.0 reader/writer 会拒绝 auth profile，而不是静默忽略订阅状态。

每个 object 的 member name 经 JSON escape 解析后必须唯一。字符串只能包含
Unicode scalar value。数字必须是有限的 IEEE 754 binary64 值；所有整数都必须位于
`-9007199254740991` 到 `9007199254740991`（含端点）的互操作范围。规则递归适用于
`extensions`。静默保留重复 key 中某一个值，或静默舍入 unsafe integer 的解析器不合规。

[`schema/`](https://github.com/openlapp/lapp/tree/main/schema/) 定义文件形状。下文补充 JSON Schema 无法表达的跨文件与安全约束。

## 当前用户状态目录

`LAPP_HOME` 选择 Profile 数据；`LAPP_STATE_HOME` 选择当前用户的协调状态，两者彼此
独立。显式设置 `LAPP_STATE_HOME` 时，它就是完整状态路径；否则默认值为：

- Windows：`%LOCALAPPDATA%\OpenLAPP`；
- macOS：`~/Library/Application Support/OpenLAPP`；
- Linux：`$XDG_STATE_HOME/openlapp`；未设置 `XDG_STATE_HOME` 时使用
  `~/.local/state/openlapp`。

实现不得从 `LAPP_HOME`、工作目录或仓库 checkout 推导该路径。平台支持时，状态目录
应限制为当前 OS 用户访问。规范 writer lock 固定为
`<LAPP_STATE_HOME>/locks/writer-v1.lock`，owner record 为其中的 `owner.json`。

## 标识符

Provider ID 与 auth ID 都必须匹配：

```text
^[a-z0-9][a-z0-9._-]{0,63}$
```

它不能是 Windows 保留设备名（大小写不敏感的 `CON`、`PRN`、`AUX`、`NUL`、`COM1`–`COM9` 或 `LPT1`–`LPT9`，包括带扩展名的保留 basename），也不能以点结尾。Provider 目录名必须与 `provider.id` 完全一致，auth 目录名必须与 `auth.id` 完全一致。实现必须拒绝非法 ID，不得把 ID 清洗后当作文件名。Provider ID 与 auth ID 属于由字段 tag 区分的两个命名空间，因此可以同名。

Model ID 是发送给上游的原始字符串，可以包含 `/`，但不能是空字符串、纯空白或含控制字符。同一 provider 或 Auth Model Source 内的全部 model ID 和 alias 共用一个唯一命名空间。

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
- `providerType` 是可选、不透明的 provider family 元数据。存在时必须匹配
  `^[a-z0-9][a-z0-9._-]{0,63}$`。它使用开放词汇：本规范不保留任何供应商名称、不赋予
  adapter 行为，实现也不得根据 `id`、`baseUrl` 或 model ID 猜测该值。LAPP 1.0 的执行与
  protocol 选择 MUST NOT 查询或使用 `providerType`。
- `enabled` 缺省为 `true`。
- `baseUrl` 是上游 API 基础地址。OpenAI-compatible 实现不得猜测或插入版本路径；协议明确定义的 endpoint 路径仍需应用。
- `protocols` 是非空、有序协议 ID 列表。
- `requestHeaders` 保存可选的非密钥静态 HTTP 头。
- `modelDiscovery` 启用显式远端模型刷新。
- `extensions` 保存带命名空间的实现自定义数据。

### 协议选择

核心上游协议 ID 为：

- `openai-chat-completions`
- `openai-responses`
- `anthropic-messages`
- `openai-images`
- `openai-audio-speech`

这些 ID 的 canonical request 与 response mapping 由
[`sdk-v1`](https://github.com/openlapp/lapp/tree/main/tools/validator/fixtures/conformance/sdk-v1/) conformance fixtures 固定。
其中三个对话 fixture 还固定 SSE 与 tool-call mapping。

可以保存其他符合语法的 ID。实现无法执行时必须返回 unsupported-protocol 错误，不能静默改成另一种协议。

协议顺序就是偏好顺序。应用声明支持协议集合后，选择模型候选中第一个属于该集合的协议；应用未传支持集合时选择第一个候选。模型存在 `model.protocols` 时以它为候选，否则继承 `provider.protocols`。

#### `openai-images`

该协议把 `image-generation` operation 映射为 `baseUrl` 下
`images/generations` 的 JSON `POST`。选中的模型固定写入 `model`；typed input 的
`prompt`、`count`、`size`、`outputFormat` 分别映射到 `prompt`、`n`、`size`、
`output_format`。typed `size` 是含整数 `width` 和 `height` 的 object；wire `size`
是 `<width>x<height>` 字符串。未提供的可选输入字段不得自行补值。

Response `data` 中含 `b64_json` 的项目归一化为 inline `image` artifact；media type
优先使用 response 的 `output_format`，缺省时使用请求的 output format。含 `url` 的项目
归一化为 URL artifact，归一化过程中不得隐式下载。图片编辑、variation、partial-image
event 和 streaming 不属于该 v1 protocol ID。

#### `openai-audio-speech`

该协议把 `text-to-speech` operation 映射为 `baseUrl` 下 `audio/speech` 的 JSON
`POST`。选中的模型固定写入 `model`；typed input 的 `text`、`voice`、
`outputFormat`、`speed` 分别映射到 `input`、`voice`、`response_format`、`speed`。
未提供的可选输入字段不得自行补值。

成功 response body 是音频字节，归一化为一个 inline `audio` artifact。media type
优先使用合法的 response `Content-Type`，缺省时按请求 output format 对应的 registered media
type 确定。SSE speech event 不属于该 v1 protocol ID；实现可以增量读取普通 audio
body，但最终仍归一化为同一个 artifact。

### URL

`baseUrl` 和 `modelDiscovery.url` 必须是绝对 HTTP(S) URL，不能带用户名、密码或
fragment。远端 URL 必须使用 HTTPS；只有 loopback 主机（`localhost`、
`127.0.0.0/8` 和 `::1`）可以使用 HTTP。

Origin 比较和 Vault 绑定必须使用标准序列化 URL origin：scheme 小写；host 使用 URL
Standard/IDNA ASCII 序列化；IPv6 必要时带方括号；HTTP 的 `80` 和 HTTPS 的 `443`
默认端口省略；非默认端口显式保留。Path、query 与 fragment 不属于 origin。例如
`https://EXAMPLE.com:443/v1?x=1` 的 origin 是 `https://example.com`。Opaque 或
`null` origin 非法。只有序列化 origin 的字节完全相同才算同源。

协议在 `baseUrl` 下定义 endpoint 时，实现必须把它追加到 URL pathname，而不是拼接到序列化 URL 字符串，并保留已配置的 query 参数。

存在 `modelDiscovery` 时，其 URL 必须与 `baseUrl` 的 canonical origin 相同。带认证
的请求必须使用 `redirect: error` 或等价行为，凭据绝不能跟随重定向。Path 或 query
不同不会改变 origin，但实现仍必须精确请求配置的 URL。

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

## auth.json

LAPP 1.1 Auth Model Source 描述通过用户授权 runtime driver 访问的模型，而不是静态
provider URL 与 API-key 形状：

```json
{
  "schemaVersion": "1.1",
  "id": "codex-personal",
  "name": "Codex Personal",
  "driver": "openai-codex",
  "enabled": true,
  "protocols": ["openai-responses"],
  "config": {
    "originator": "openlapp"
  }
}
```

`schemaVersion`、`id`、`driver` 与 `protocols` 必填。`name` 是可选非空显示名，
`enabled` 缺省为 `true`。`driver` 必须匹配
`^[a-z0-9][a-z0-9._-]{0,63}$`，是显式 runtime adapter key；实现不得根据 auth ID、
model ID 或 config 猜测 driver。`protocols` 是非空有序列表，语法与 provider protocol
ID 相同。可选的 `config` 与 `extensions` 都是 I-JSON object，未知成员必须无损保留。
`config` 与 `extensions` 都只允许非密钥元数据；递归地把 key 忽略大小写并去掉 ASCII 分隔符后，若
其包含凭据名必须拒绝。同一规则也适用于 Auth source 的 `models.json` 顶层及每个 model 的
`extensions`。若 key
包含 `token`、`secret`、`password`、`passphrase`、`apiKey`、`privateKey`、`accessKey`、
`sessionKey`、`signingKey`、`credential`、`cookie` 或 `authorization` 等凭据家族，必须拒绝；
`authorizationCode`、`deviceCode`、`codeVerifier`、`deviceAuthId`、`userCode` 等 OAuth
临时凭据名同样必须拒绝。唯一允许的敏感家族例外是精确的公开元数据 key
`tokenEndpoint` 与 `deviceCodeUrl`；`clientId`、`discoveryUrl`、`modelsUrl`、
`inferenceBaseUrl`、`issuer`、`scope`、`reasoningEffort`、`accountId` 仍然合法。

`auth.json` 是 Model Source 元数据，不是 token 文件。Access token、refresh token、
Cookie、authorization code 等可用凭据不得写入 `config`、`extensions`、Auth source 的 `models.json`
extensions、
diagnostic 或日志。Runtime driver 应把私有授权状态保存在适当的当前用户受保护存储中。
Profile 校验与模型列表读取不得调用 driver、解析授权状态或访问网络。

实现可以在尚未实现某个 driver 时读取和列出 Auth Model Source；执行未知或不可用 driver
时必须明确返回 unsupported，不得把它重新解释成 provider、猜 URL 或 fallback 到其他凭据。

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

下列值是 well-known 互操作词汇，而不是封闭 enum：

- operation：`chat`、`embedding`、`image-generation`、`video-generation`、
  `text-to-speech`、`music-generation`；
- 输入/输出模态：`text`、`image`、`audio`、`video`；
- capability：上述 operation 名，以及 `stream`、`tool-call` 和 `reasoning`。

未知的非空白值仍然合法并且必须保留。音乐和歌曲使用 `audio` 输出模态与
`music-generation` capability；TTS 使用相同输出模态与 `text-to-speech`
capability。`type` 始终是不透明描述数据，不是路由 key。

存在 `protocols` 时，它必须是所属 provider 或 Auth Model Source protocols 的非空子集；
缺省时继承 owner 的有序 protocols。

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

`defaults` 把操作名映射到 canonical provider 和 model ID。操作名是小写标识符；
well-known 名称见上文 `models.json` 一节，其他语法合法的操作名仍然允许。

默认值必须用 canonical ID 引用现有且启用的 provider 和 model，不能把 alias 写入 `global.json`。没有 `global.json` 的 profile 仍然合法。

LAPP 1.1 只改变引用与文档版本。`RegistryModelRef` 必须严格是以下两个封闭 object 之一：

```json
{ "providerId": "deepseek", "modelId": "deepseek-v4-flash" }
{ "authId": "codex-personal", "modelId": "gpt-5-codex" }
```

两个 selector 互斥；同时出现、同时缺失或含未知成员都非法。Provider ref 保持 1.0
语义。Auth ref 必须指向现有且启用的 Auth Model Source 与启用的 canonical model ID，
不得保存 alias。1.1 的 `defaults` 可以为空，允许先登记来源、稍后再选默认模型。

## 连接解析

输入 provider/auth model selection 或默认操作名后，实现必须：

1. 必要时先解析 default；
2. 按带 tag 的 selector 找到存在且启用的 provider 或 Auth Model Source；
3. 在该来源的 model ID 与 aliases 中解析 `model`，歧义时报错；
4. 确认模型启用，并把 alias 归一成 canonical model ID；
5. 按前述有序交集规则选择协议；
6. 对 provider 验证 URL 与静态 headers，解析 secret、执行 Vault 绑定校验并只构造一种认证方式；
7. 对 Auth Model Source 返回 canonical auth ID、driver、model ID、protocol 与无损 config，
   但不在这一阶段读取 driver 授权状态；
8. 由选中的 provider adapter 或 auth driver 执行请求。

读取或解析模型列表不得解析 secret、读取 driver token 或访问网络。Provider 请求执行与
显式刷新可以按需解析凭据；auth 执行只在发送前即时解析 driver 状态。

## 校验与诊断

实现必须依次执行 I-JSON、版本 Schema 与语义校验。未知、畸形或不受支持的 1.0/1.1
数据必须拒绝；LAPP 1.0 保持冻结，LAPP 1.1 是显式加法版本，而不是对 1.0 的重新解释。已存在的
managed document path 如果不是 regular file（包括 symlink 或 directory），必须以
`NON_REGULAR_FILE` 拒绝。

合规 diagnostic 只由 `(level, code, location)` 标识：

- `level` 为 `ERROR` 或 `WARN`；
- `code` 是稳定的全大写 ASCII 下划线标识符；
- `location` 是相对所选 LAPP root 的 POSIX path，可选追加 `#` 与 RFC 6901 JSON
  Pointer。

Location 不能是绝对路径、不能以 `./` 开头、不能含反斜杠。文件级诊断只使用路径；
member 诊断必须使用解码后的精确 member path，并将 `~` 转义为 `~0`、`/` 转义为
`~1`，例如 `providers/deepseek/provider.json#/auth/secret` 或
`auth/codex-personal/auth.json#/driver`。Message 可以本地化，
输出顺序也可以不同；二者都不参与合规身份。任何诊断字段都不得出现 secret、Vault
envelope 或未脱敏 native error。

## Profile revision

Profile revision 是根据 managed bytes 与相关文件状态计算的不透明 CAS 值。文本格式为
`sha256:` 后接 64 个小写十六进制字符，调用方只能比较是否相等。

### Revision-v1（冻结的 LAPP 1.0）

SHA-256 输入以 ASCII 字节 `lapp-profile-revision-v1` 和一个 NUL 字节开头，之后是
四字节无符号大端 record 数量，再接下述 records。

Record set 始终包含 `global.json` 与 `providers`。当 `providers` 是目录时，还包含它
每个 direct child directory 的 structure record；每个该 provider directory 另包含
`providers/<name>/provider.json` 与 `providers/<name>/models.json`。不包含更深层
entry、临时 sibling、lock、Vault record、mode、timestamp、inode 或其他 OS metadata。

Record 按 POSIX 相对路径 UTF-8 字节做 lexicographic 排序。每项 framing 为：

```text
u32be(path 字节长度) || path UTF-8 || state
```

`state` 是单字节：`00` 表示 missing，`01` 表示 regular file，`02` 表示 directory，
`03` 表示其他对象（包括 symlink）。Regular file 随后追加
`u64be(content 字节长度) || 原始 content bytes`。因此 missing、empty、directory 与
non-file 状态互不混淆，也不会解析或归一化 JSON。Reference vectors 位于
[`tools/validator/fixtures/conformance/revision-v1.json`](https://github.com/openlapp/lapp/blob/main/tools/validator/fixtures/conformance/revision-v1.json)。

Direct provider directory name 在 framing 前必须能表示为 well-formed UTF-8，且只包含
Unicode scalar value。无法表示的 raw POSIX filename 必须让 revision 以
`PROFILE_PATH_INVALID` 失败，不能用 replacement character 解码。Writer 绝不能创建
此类名称。合法 LAPP provider ID 只含 ASCII，因此总能满足该规则。

### Revision-v2（LAPP 1.1）

Revision-v2 使用与 v1 相同的 framing、state byte、原始内容与 UTF-8 排序规则，文本格式
仍为 `sha256:`。Domain 是 ASCII `lapp-profile-revision-v2` 后接一个 NUL byte。Record
set 始终包含 `global.json`、`providers` 与 `auth`；provider records 与 revision-v1 完全
相同。当 `auth` 是目录时，还包含每个 direct auth directory 的 structure record，以及
各目录的 `auth/<name>/auth.json` 与 `auth/<name>/models.json`。不包含更深层 entry 或
driver token-store record。

冻结 vectors 位于
[`tools/validator/fixtures/conformance/revision-v2.json`](https://github.com/openlapp/lapp/blob/main/tools/validator/fixtures/conformance/revision-v2.json)。
实现不得把 auth path 加入 revision-v1，也不得为 1.1 复用 revision-v1 domain。1.1
snapshot 使用 revision-v2；兼容 reader 读取 1.0 profile 时仍返回 revision-v1。

## Stable read

返回完整 Profile 或 snapshot 的 reader 都必须执行 stable read，无论 caller 是否准备
mutation。默认最多执行三次完整尝试，每次必须：

1.0 profile 的尝试用 revision-v1 bracket，1.1 profile 用 revision-v2。兼容两版的 reader
可以在读取前后分别计算两套候选 revision，再根据校验通过的 `global.json` 只比较对应的
一对；不得拿 revision-v1 与 revision-v2 互相比。

1. 确认 `writer-v1.lock` 不存在；
2. 计算 `revisionBefore`；
3. 读取完整 Profile，执行 I-JSON、Schema 与语义校验，但不解析凭据、不访问网络；
4. 计算 `revisionAfter`；
5. 再次确认 `writer-v1.lock` 不存在；
6. 仅在两个 revision 完全相同时接受 snapshot。

稳定但非法的 Profile 返回 canonical validation diagnostics。看到 lock 或 revision 不同
的尝试必须整体丢弃。三次都未成功时返回 `PROFILE_READ_UNSTABLE`，绝不能返回 mixed
snapshot。实现可以接受更低的 caller-supplied attempt limit，但不得静默无限重试。

## 当前用户全局 writer 协调

所有合规 writer（包括只修改 Vault 的凭据操作）都必须持有
`<LAPP_STATE_HOME>/locks/writer-v1.lock` 这一把当前用户全局锁。Device Vault 在当前
OS 用户下共享，因此即使操作不同 `LAPP_HOME` root，也必须串行化。

获取锁就是以不替换现有对象的方式原子创建 `writer-v1.lock` 目录。创建成功后，owner
用 exclusive-create 写入 I-JSON `owner.json`，且只能包含：

```json
{
  "version": 1,
  "token": "123e4567-e89b-12d3-a456-426614174000",
  "pid": 1234,
  "createdAt": "2026-07-17T09:30:00Z"
}
```

`token` 是 canonical 小写连字符 UUID string；`pid` 是 `0` 到
`9007199254740991` 的整数；`createdAt` 使用 Schema 规定的 canonical RFC 3339 UTC
subset，以 `Z` 结尾且秒数为 `00` 到 `59`。其日期与时间还必须是实际存在的 Gregorian
calendar value，不能只匹配 lexical pattern。Record 没有 heartbeat 或 expiry 字段。Versioned schema 为
[`schema/writer-lock.schema.json`](https://github.com/openlapp/lapp/blob/main/schema/writer-lock.schema.json)。
Creator 进入 mutation critical section 前必须 flush owner record。Exclusive owner
creation 或 flush 失败时，只有刚创建该目录的 creator 可以尝试 ownership-safe cleanup；
cleanup 失败则保留锁供显式恢复，并让 acquisition 失败。

目录已存在时，默认获取等待上限为 5000 ms；超时返回 `PROFILE_LOCKED`。正常操作绝不
能根据 `createdAt`、process identity、PID 是否存活、文件年龄或 heartbeat 推断锁已
废弃，也绝不能 steal 或 replace 该锁。

释放前，owner 必须重读、校验 `owner.json` 并要求 token 完全一致；随后先把 lock
directory 原子 rename 成 owner-specific sibling，再删除改名后的目录，从而不会删除
新 owner 的锁。Token 不符、record 畸形、filesystem object 异常或 ownership-safe
release 失败都返回 `PROFILE_LOCK_INVALID`，并保留观察到的锁。

Lock repair 是独立、显式且经用户授权的操作。它必须先展示或返回观察到的 owner
record，接收该精确 token 作为确认，重读并比较 token，然后把 lock directory 原子
rename 成 repair-specific sibling 后删除。Token 变化时必须中止。Owner 缺失或畸形
时无法完成 token compare；合规 repair 必须返回 `PROFILE_LOCK_INVALID` 并保留锁。
Operator 在独立证明没有 writer 活跃后选择的 tokenless 手工 filesystem recovery 明确
位于 LAPP 协议之外。Repair 绝不自动触发，也不得使用年龄、PID 或 heartbeat
heuristic。

## CAS 写入与 rollback

所有 writer mutation（包括仅 Vault credential set/delete）都必须携带 stable Profile
read 得到的 `expectedRevision`。Writer 必须：

1. 获取当前用户全局锁；
2. 持锁时使用同样最多三次尝试的 revision bracketing 得到 coherent current Profile（因
   writer 自己持锁，此处省略 lock-absence checks）；
3. 在任何 Vault access、文件创建、删除或修改前比较该 revision 与
   `expectedRevision`；
4. 不同则返回 `PROFILE_CONFLICT`，不产生任何 mutation；
5. 在内存应用一个 semantic operation，再校验完整 proposed Profile；
6. 第一次 side effect 前立即重算 revision，再次要求它等于 `expectedRevision`；检测到
   non-conforming manual edit 时同样返回 `PROFILE_CONFLICT`；
7. 只提交 proposal 真正改变的文件。

每次写入或删除前都必须解析 target 并证明它仍在 LAPP root 内。Managed path 上的
symlink 或其他 non-regular object 必须拒绝。Changed file 应写入 restrictive temporary
sibling、flush 后 atomic rename；平台支持时还要 flush containing directory。Unchanged
file 不得重写。多个 changed profile path 按 revision 使用的同一 UTF-8 bytewise 顺序
提交。Required provider 与 auth directory 按该顺序在文件前创建。只有两个 managed file 都
已删除且目录为空时才能删除 provider 或 auth directory；writer 绝不能递归删除未知 content。
删除 provider 或 Auth Model Source 前，writer 必须在第一次 side effect 之前检查其目录；若除两个 managed
regular file 外还存在任何 entry，必须在不产生 mutation 的情况下拒绝整个 commit。
删除目录前还必须再次检查为空；目录新出现 content 属于 profile step failure，必须
触发 rollback，绝不能把留下 orphan content 的状态当作成功 commit。
Directory action 也按实际 action 的严格逆序 rollback。

向 1.0 profile 添加首个 Auth Model Source 是一次显式 CAS transaction：写入 auth 两个
文档，同时创建或升级 `global.json` 为 1.1，并返回 revision-v2。合规 writer 绝不能在
`global.json` 缺失或仍为 1.0 时创建 `auth/`。删除最后一个 auth source 时不得隐式降级
profile 或 revision algorithm。

第一次 side effect 前，writer 必须保存每个 affected profile path 与 Vault record 的
精确旧状态，包括 present 与 absent 的区别。任一 profile step 失败时，按 commit 的逆序
恢复已改变 path；即使前一项 rollback 失败，也必须继续尝试所有必要 rollback。

组合 Vault mutation 与 Profile change 时，先验证完整 proposal，保存 Vault 原值，再
修改 Vault，最后提交 Profile。Profile commit 失败时先 rollback Profile，再把 Vault
恢复为精确旧 record 或 absent。全部恢复成功则返回原始且已脱敏的 write failure。
Profile-only transaction 的 Profile rollback 不完整返回
`PROFILE_UPDATE_PARTIAL_FAILURE`。任何修改过 Vault 的 transaction 只要 Profile
rollback 或 Vault restoration 任一不完整，top-level code 就使用安全优先级更高的
`CREDENTIAL_UPDATE_PARTIAL_FAILURE`；structured redacted details 可以同时记录 Profile
restoration 不完整。因此二者同时失败时也确定由
`CREDENTIAL_UPDATE_PARTIAL_FAILURE` 优先。Partial-failure diagnostic 不得泄漏新旧
secret。全局锁必须持有到 rollback 完成并 ownership-safe release。

Dry run 只执行 stable read、semantic mutation 与 proposal validation；不得获取 mutation
lock、解析或查看 Vault record、写 temporary file 或改变 Profile state。
