# 故障排除

先执行验证和脱敏检查：

```bash
lapp validate
lapp inspect
```

需要让其他程序消费结果时使用 `--json`。

## 类型化错误

| 错误 | 含义 | 修复 |
|------|------|------|
| `ProfileValidationError` | JSON 目录树未通过结构或语义验证。 | 运行 `lapp inspect`，逐项修复 ERROR 诊断。 |
| `TargetResolutionError` | 无法解析 Provider、模型、alias、默认值、启用状态或协议交集。 | 查看错误 `code`；核对 canonical ID、启用状态、默认值和应用支持的协议。 |
| `MissingEnvSecretError` / `ENV_SECRET_MISSING` | 缺少 `env://NAME` 对应的值。 | 导出变量，或传入显式 SDK 环境变量 map。 |
| `CredentialError` | 密钥引用、Vault 后端、记录、权限或绑定失败。 | 查看稳定 `code`；先用 `credential status` 检查，再恢复或显式替换凭据。 |
| `ModelRefreshError` | 未配置发现，或出现 HTTP、响应结构、分页错误。 | 检查 `modelDiscovery`、地址 origin、凭据和远端响应。 |
| `StreamingUnsupportedError` | 选中的直连 adapter 不支持流式。 | 使用 `chat()` 或选择支持流式的协议。 |

`TargetResolutionError.code` 包括 `PROVIDER_NOT_FOUND`、
`PROVIDER_DISABLED`、`MODEL_NOT_FOUND`、`MODEL_DISABLED`、
`MODEL_AMBIGUOUS`、`DEFAULT_NOT_FOUND`、`PROTOCOL_NOT_SUPPORTED`。

`ModelRefreshError.code` 包括 `DISCOVERY_NOT_CONFIGURED`、
`INVALID_RESPONSE`、`HTTP_ERROR`、`PAGINATION_ERROR`。

## Schema 快照错误

如果 SDK 报告 LAPP Schema 缺失或未注册，请检查受版本控制的快照是否仍在
`packages/lapp/schema/`；若被删除，请从版本控制恢复。`pnpm verify:spec` 会将该
快照与固定的 canonical spec commit 比对。

## Profile 无法加载

- 文件必须是标准 JSON，名称为 `provider.json`、`models.json` 和
  `global.json`。
- 每个存在的文件都必须使用 `"schemaVersion": "1.0"`。
- Provider 目录名必须等于 Provider ID。
- 核心对象拒绝未知字段；实现数据应移入 `extensions`。
- 即使 `loadProfile()` 无法返回有效 Profile，也可以运行
  `lapp inspect --json` 查看部分、已脱敏的诊断。

## 模型刷新失败

逐项检查：

1. `provider.json` 包含 `modelDiscovery.protocol` 和绝对 URL。
2. 发现 URL 与 `baseUrl` 使用相同 origin。
3. 远端 URL 使用 HTTPS，或地址是 loopback HTTP。
4. 选中的环境变量或 Vault 凭据可用，并仍与 Provider ID、origin 和认证形态一致。
5. 响应符合配置的发现协议。

非法 HTTP 200 响应是错误，不是空模型目录。合法空列表不会修改 Profile。

## 远端模型消失后仍保留在本地

这是预期行为。`models.json` 是权威目录，刷新永不删除本地条目。确认不再需要后，
再显式删除该模型。

## 已有模型元数据没有更新

刷新会保留本地字段。它只追加未知 ID，并可补充当前缺失的显示名称。如需有意修改
本地字段，请编辑 `models.json` 或使用 `lapp model set`。

## 模型 alias 解析结果异常

同一 Provider 内的 ID 和 alias 必须唯一，验证器会拒绝歧义。默认值始终保存
canonical 模型 ID；默认值指向异常时请检查 `global.json`。

## 认证问题

- 只能使用一个合法 `auth` variant：`none`、`bearer`、`header` 或 `query`。
- 自定义 header/query 认证使用 `name` 字段。
- 只接受 plaintext、`env://NAME` 与 `vault://provider/credential`。
  `keychain://`、`file://` 和未知 scheme 都不合法。
- 静态 `requestHeaders` 不能携带认证或 Cookie。
- `lapp resolve --default chat --json` 只显示 scheme 与凭据状态，永不显示密钥；
  CLI 不提供 reveal 或 export。
- `VAULT_BINDING_MISMATCH` 表示 Provider ID、标准化 origin、auth type 或 auth name
  已改变。使用 `credential set --overwrite` 重新输入；LAPP 不自动 rebind。
- `VAULT_BACKEND_UNAVAILABLE` 表示原生模块或 OS 凭据服务不可用；不会回退到
  plaintext 或文件。

## 报告问题

在 [lapp-js 仓库](https://github.com/openlapp/lapp-js)提交 issue，并附上命令、
退出码、脱敏后的 `lapp inspect --json` 输出，以及不含 plaintext 凭据的最小
Profile。

## 另见

- [配置文档](configuration.md)
- [安全说明](security.md)
- [协议说明](protocols.md)
- [本地 Provider](local-providers.md)
