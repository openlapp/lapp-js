# 安全说明

LAPP v1 假定：与 Profile 或共享 Vault 同属一个 OS 用户、并被明确授予访问权限的
应用是可信应用。应用需要直接与上游 Provider 通信，因此
`resolveConnection()` 会返回可用凭据。

不要把 LAPP Profile 或解析后的连接交给不可信代码。如果应用不能得到原始凭据，
就需要独立的策略服务；这不属于 v1。

## 密钥形式

只允许三种形式：

| 形式 | 示例 | 建议 |
|------|------|------|
| Vault 引用 | `"vault://openai/default"` | 官方 SDK 新建凭据的默认方式；由当前用户的系统凭据库保护。 |
| 环境变量引用 | `"env://OPENAI_API_KEY"` | 支持；密钥不会进入 Profile。 |
| Plaintext | `"sk-..."` | 允许但产生警告；密钥会留在磁盘上。 |

环境变量名必须匹配 `[A-Za-z_][A-Za-z0-9_]*`。Vault 引用必须正好包含 Provider
ID 和 credential ID，且 Provider ID 与 Profile 一致。`keychain://`、`file://`、
畸形引用与未知 URI 形式直接判为非法，不会静默解释。

Vault 只提供静态存储保护，不是应用沙箱。同一 OS 用户下任何兼容进程都可能读取
记录；应用构造直连 Provider 请求时也会得到明文。LAPP v1 不提供逐应用 ACL、
网关、不可导出承诺、跨设备同步、密码恢复或权威审计日志。

## 严格认证

只能使用一个明确的 auth variant：

```json
{ "type": "none" }
{ "type": "bearer", "secret": "vault://openai/default" }
{ "type": "header", "name": "x-api-key", "secret": "env://ANTHROPIC_API_KEY" }
{ "type": "query", "name": "key", "secret": "env://PROVIDER_KEY" }
```

未知类型和缺失字段都是错误，不存在隐式 Bearer 行为。`requestHeaders` 不能包含
认证、代理认证、Cookie 或 API key 请求头。名称按大小写不敏感规则必须唯一，且
不能与 header auth 名称冲突。

## 何时解析密钥

- `loadProfile()` 验证密钥引用，但不解析值。
- `inspectProfile()` 只返回脱敏后的密钥摘要。
- `listModels()` 不解析密钥，也不执行 I/O。
- 异步 `resolveConnection()` 与 `refreshModels()` 只解析选中 Provider 的密钥；
- `createLappClient()` 创建的 client 在每次请求前重新解析，因此轮换 Vault 后
  无需重建 client。

默认 resolver 在处理环境变量引用时读取 `process.env`，只有处理 Vault 引用时才
打开当前用户的系统凭据库。测试和嵌入应用可注入 env map 与
`CredentialVault`。环境变量、Vault 记录、原生后端缺失，或 envelope/绑定不合法
时，都会在网络请求前失败，且不会回退到其他密钥形式。

## CLI 显示策略

`inspect`、`resolve`、`credential status`、诊断和 JSON 输出都不会显示凭据。
CLI 不提供 get 或 export；原始凭据只能通过无回显终端输入或 stdin 传入，不能
作为命令行参数值。

Provider 错误文本在进入 CLI 诊断前会清理常见凭据形状。这只是纵深防御，不能
代替“不记录请求头和解析后连接”的基本规则。

## 地址绑定

Vault envelope 绑定 Provider ID、标准化 origin 与认证 type/name。Header 名称转为
小写后绑定，query 参数名保持大小写敏感。兼容客户端返回明文前必须校验绑定，并在
注入认证前再次校验最终请求 origin。此外：

- `modelDiscovery.url` 必须与 `baseUrl` 同源；
- 远端 origin 必须使用 HTTPS；
- 本地开发允许 loopback HTTP；
- URL 不能包含用户名、密码或 fragment；
- 携带认证的发现请求不会跟随重定向。

启用 Profile 前必须审查。Profile 同时控制凭据引用和目标地址，因此从仓库复制或
由他人提供的 Profile 是可执行的安全配置，不是无害数据。
绑定能防止被修改的 Profile 通过官方 SDK 静默把 Vault 凭据送往其他 origin，但
不能阻止恶意同用户进程直接读取共享系统凭据记录。

## 平台存储与恢复

Windows 实现使用当前用户的原生 Credential Manager。macOS 与 Linux 仅尽力支持，
并依赖可工作的原生凭据服务。原生模块或服务不可用时，Vault 操作返回 typed error；
LAPP 不会创建明文或加密文件回退。

Vault 记录不属于 `LAPP_HOME` 备份，LAPP 也不会同步它。OS 账户、系统凭据库或设备
重置可能使记录不可用。应在上游 Provider 保留独立恢复方式，例如轮换或新建 API
key。

## 文件安全

Provider ID 使用严格、文件名安全的 grammar。Writer 在每次写入和删除前验证目标
仍位于选中的 Profile 根目录内；非法或冲突 ID 会被拒绝，不会经过字符清洗后继续。

## 建议

- 将权威 Profile 放在用户控制的 `LAPP_HOME`，不要默认使用不可信项目目录。
- 新输入密钥默认使用 SDK Vault；外部管理的 secret 可用 `env://`；不要提交
  plaintext 凭据。
- 只有经过明确审查和显式 opt-in 才选择 plaintext storage。
- 只有服务确实无需凭据时才使用 `auth.type: "none"`。
- `modelDiscovery` 保持与 Provider 同源。
- 手工修改后运行 `lapp validate`。
