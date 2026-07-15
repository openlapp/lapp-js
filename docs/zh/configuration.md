# 配置

LAPP Profile 是一个标准 JSON 目录树，用来描述上游 Provider、本地权威模型目录
以及可选的任务默认值。

## Profile 位置

SDK 和 CLI 按以下顺序解析根目录：

1. 显式路径参数或 `{ path }` 选项。
2. `LAPP_HOME`。
3. `~/.lapp`。

只接受 `.json` 文件。每个文件都使用 `"schemaVersion": "1.0"`。

## 目录结构

```text
~/.lapp/
├── global.json
└── providers/
    ├── openai/
    │   ├── provider.json
    │   └── models.json
    └── local/
        ├── provider.json
        └── models.json
```

设置默认值前可以没有 `global.json`。每个 Provider 都必须有 `models.json`；空的
权威目录写作 `{"schemaVersion":"1.0","models":[]}`。

Provider 目录名必须与 `provider.json#id` 完全一致。Provider ID 必须匹配
`^[a-z0-9][a-z0-9._-]{0,63}$`，且不能是 Windows 保留名。

## `provider.json`

```json
{
  "schemaVersion": "1.0",
  "id": "openai",
  "name": "OpenAI",
  "enabled": true,
  "baseUrl": "https://api.openai.com/v1",
  "protocols": ["openai-responses", "openai-chat-completions"],
  "auth": {
    "type": "bearer",
    "secret": "vault://openai/default"
  },
  "requestHeaders": {
    "OpenAI-Organization": "org-example"
  },
  "modelDiscovery": {
    "protocol": "openai-models",
    "url": "https://api.openai.com/v1/models"
  }
}
```

必填字段为 `schemaVersion`、`id`、`baseUrl`、`protocols` 和 `auth`。可选字段为
`name`、`enabled`、`requestHeaders`、`modelDiscovery` 与 `extensions`。

`protocols` 是有序、非空的协议 ID 列表。模型可以缩小该列表。解析连接时，SDK
选择应用支持的第一个候选协议，不进行协议转换。

### 认证

认证是严格的 tagged union：

```json
{ "type": "none" }
{ "type": "bearer", "secret": "vault://openai/default" }
{ "type": "header", "name": "x-api-key", "secret": "env://ANTHROPIC_API_KEY" }
{ "type": "query", "name": "key", "secret": "provider-key-in-plaintext" }
```

密钥只能是 plaintext、`env://NAME` 或
`vault://<providerId>/<credentialId>`。Vault 引用必须正好包含两个可移植 ID，
其中 provider segment 必须等于当前 Provider 的 `id`。百分号编码、query、
fragment、额外路径、`keychain://`、`file://` 与未知 scheme 都不合法。
Plaintext 会留在 `provider.json` 中，因此虽然允许使用，但会产生警告。

官方 SDK 新增原始凭据时默认写入当前 OS 用户的系统凭据库，Profile 中只保存
Vault 引用。同一 OS 用户下所有兼容应用都可能使用这份凭据。受保护记录绑定
Provider ID、标准化 origin 和认证 type/name；这些字段发生变化后必须显式重新
保存凭据。

`requestHeaders` 只用于非秘密静态请求头。名称必须是合法 HTTP token，值不能
包含 CR/LF，而且不能配置认证或 Cookie 请求头。名称按大小写不敏感规则必须唯一，
也不能与 header auth 名称重复。

### 模型发现

可选的 `modelDiscovery` 支持两种响应合同：

- `openai-models`
- `anthropic-models`

发现 URL 必须与 `baseUrl` 同源。远端地址必须使用 HTTPS；只有 loopback 主机可以
使用 HTTP。携带认证的发现请求不会跟随重定向。

## `models.json`

```json
{
  "schemaVersion": "1.0",
  "models": [
    {
      "id": "gpt-4o-mini",
      "name": "GPT-4o mini",
      "aliases": ["fast-chat"],
      "protocols": ["openai-responses", "openai-chat-completions"],
      "type": "chat",
      "inputModalities": ["text", "image"],
      "outputModalities": ["text"],
      "capabilities": ["streaming", "tools"],
      "contextWindow": 128000,
      "maxOutputTokens": 16384
    }
  ]
}
```

`models.json` 是本地权威数据，不是生成式缓存。模型 ID 可以包含 `/`，但不能是
空白字符串或包含控制字符。同一 Provider 的所有模型 ID 和 alias 共用唯一命名
空间。

`model.protocols` 可省略；省略时继承 Provider 协议，存在时必须是非空子集。其他
描述字段都是可选的。实现特有数据应放在 `extensions` 中。

`models refresh` 只会按 ID 排序追加新的远端模型，并可补充当前缺失的显示名称。
它保留已有顺序和字段，也不会删除已从上游消失的模型。

## `global.json`

```json
{
  "schemaVersion": "1.0",
  "defaults": {
    "chat": {
      "providerId": "openai",
      "modelId": "gpt-4o-mini"
    }
  }
}
```

默认值 key 是任务名。值只能使用 canonical 模型 ID，不能使用 alias，而且必须引用
启用的 Provider 和模型。删除被引用的 Provider 或模型前，必须先修改对应默认值。

## 禁用项与扩展

禁用的 Provider 和模型仍保留在内存中，以便原样写回。`listModels()` 默认不返回
它们，`resolveConnection()` 也会拒绝解析它们。

核心对象拒绝未知字段。实现特有字段统一放入 `extensions` 对象。

## 写入

低级 SDK 管理函数是不可变纯函数，不会自行写盘。异步高级函数
`upsertProviderWithCredential()` 默认把原始密钥写入 Vault；选择明文必须显式
指定 storage，并会返回警告。该函数返回新的内存 Profile；检查
`planChanges()` 后仍需显式调用 `writeProfileAtomic()`。每个变化文件都会先验证，
再写入同目录临时文件，执行 fsync 后重命名。v1 假定同一时刻只有一个写者，
不提供 Profile 级事务或备份。
