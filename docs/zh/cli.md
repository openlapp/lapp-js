# CLI 参考

`lapp` 是 `@openlapp/lapp` 的轻量命令行包装。它读取本地 Provider
Registry，返回连接信息，或者直接与选中的上游通信；不运行网关或后台服务。

## 命令概要

```text
lapp validate [path] [--json]
lapp inspect [path] [--json]
lapp provider add [path] --id <id> [--base-url <url>] [--protocol <id>...] [--vault <id> [--stdin] [--overwrite] | --env <name> | --plaintext [--stdin] --allow-plaintext | --no-auth] [--model <id>] [--yes | --dry-run]
lapp provider set [path] --id <id> [options] [--yes | --dry-run]
lapp provider remove [path] --id <id> [--yes | --dry-run]
lapp credential set [path] --provider <id> [--id <id>] [--stdin] [--overwrite] [--yes | --dry-run] [--json]
lapp credential status [path] --provider <id> [--id <id>] [--json]
lapp credential delete [path] --provider <id> [--id <id>] [--yes | --dry-run] [--json]
lapp model add [path] --provider <id> --id <id> [options] [--yes | --dry-run]
lapp model set [path] --provider <id> --id <id> [options] [--yes | --dry-run]
lapp model remove [path] --provider <id> --id <id> [--yes | --dry-run]
lapp default set [path] --task <task> --provider <id> --model <id> [--yes | --dry-run]
lapp models list [path] [--provider <id>] [--json]
lapp models refresh [path] --provider <id> [--apply --yes | --dry-run] [--json]
lapp resolve [--path <path>] (--provider <id> --model <id> | --default <task>) [--protocol <id>...] [--json]
lapp presets [--json]
lapp ping [--path <path>] [--provider <id> --model <id> | --default <task>] [--json]
lapp chat [message...] [--path <path>] [--provider <id> --model <id> | --default <task>] [--system <prompt>] [--stream | --json]
lapp help
lapp version
```

`provider add` 中方括号标出的连接字段只有在 `--id` 命中已知预设时才能省略。
自定义 Provider 必须提供 `--base-url`、至少一个 `--protocol`，以及
一种认证来源。

## Profile 路径与写入

Profile 命令接受位置参数 `[path]`，运行时命令使用 `--path`。省略时依次读取
`LAPP_HOME` 和 `~/.lapp`。

Provider、模型和默认值命令都会先显示变更计划。使用 `--yes` 写入，或使用
`--dry-run` 保证仅预览。`set` 命令不会覆盖未提供的字段。

```bash
lapp provider add --id openai --model gpt-4o-mini --yes
lapp provider add --id local --base-url http://127.0.0.1:11434/v1 \
  --protocol openai-chat-completions --no-auth --yes
lapp provider set --id openai --disabled --yes
lapp model add --provider openai --id gpt-4.1 --type chat --yes
lapp default set --task chat --provider openai --model gpt-4.1 --yes
```

Provider 的认证来源互斥：

- `--vault <credential-id>` 把无回显 TTY 输入保存到当前用户 Vault；非交互
  模式必须增加 `--stdin`，覆盖已有记录还必须增加 `--overwrite`；
- `--env <NAME>` 只保存环境变量引用，不读取变量值；
- `--plaintext --allow-plaintext` 把隐藏输入或 stdin 明文写入 Profile，并输出
  风险警告；
- `--no-auth` 表示无需认证。

新建需认证的 Provider 未指定来源时，交互终端默认使用
`vault://<provider>/default` 并无回显录入。非交互调用方必须选择 `--stdin`
或 `--env`；JSON 模式永不弹出输入。认证形状由
`--auth-type bearer|header|query` 和 `--auth-name` 指定。非秘密静态请求头
使用可重复的 `--header NAME=VALUE`。模型发现必须同时提供
`--models-protocol openai-models|anthropic-models` 和 `--models-url`。

模型字段使用 `--name`、可重复的 `--alias`、`--protocol`、`--capability`、
`--input-modality`、`--output-modality`，以及 `--type`、`--context-window`、
`--max-output-tokens`、`--enabled` 或 `--disabled`。

## 凭据

`credential set` 在一个受保护的组合操作中保存或轮换 Vault 记录，并更新
Provider 引用；默认从无回显终端读取，也可用 `--stdin` 读取管道输入。
`credential status` 只报告记录是否存在和绑定状态，不返回值。
`credential delete` 只删除共享 Vault 记录，不重写或删除 Provider。

```bash
lapp credential set --provider openai --stdin --yes
lapp credential set --provider openai --id secondary --stdin --overwrite --yes
lapp credential status --provider openai --json
lapp credential delete --provider openai --id secondary --yes
```

dry-run 不提示输入，也不读写 Vault。CLI 不提供 credential get、export 或
rebind 命令。

## 模型目录

`models list` 只读取本地权威 `models.json`：

```bash
lapp models list
lapp models list --provider openai --json
```

`models refresh` 请求已配置的模型发现地址，并预览新增模型 ID。只有同时提供
`--apply` 和 `--yes` 才写盘。刷新会按 ID 排序追加新模型，保留原有顺序和字段，
永不删除模型。

`--dry-run` 是无 I/O 的验证模式：不会解析凭据、读取 Vault、请求模型发现地址或
写入 Profile。需要获取真实预览时，请不要使用 `--dry-run`。

```bash
lapp models refresh --provider openai
lapp models refresh --provider openai --dry-run
lapp models refresh --provider openai --apply --yes --json
```

## 解析连接与直接请求

解析 canonical 模型 ID、协议、地址、请求头和认证信息：

```bash
lapp resolve --provider openai --model gpt-4o-mini --json
lapp resolve --default chat --protocol openai-responses \
  --protocol openai-chat-completions --json
```

`resolve` 永远不解析或打印凭据值，只报告 secret scheme、当前可用性，以及
Vault 记录是否匹配 Provider 绑定。

`ping` 和 `chat` 使用相同的目标解析规则，并直接请求上游。未指定目标时使用
`chat` 默认值。

```bash
lapp ping --default chat
lapp chat "总结这段内容" --default chat
lapp chat "数到十" --provider openai --model gpt-4o-mini --stream
lapp chat "简短回答" --system "保持简洁" --json
```

`--stream` 不能与 `--json` 组合。未提供消息参数时，也可以从 stdin 读取消息。

## 检查、预设与 JSON

- `validate` 加载完整有效的 Profile；有错误时退出失败。
- `inspect` 返回可读取的部分 Profile 信息和诊断，永不显示密钥。
- `presets` 列出 `provider add` 可用的内置 Provider 默认值。

机器输出始终是一个 JSON 文档：

```json
{"version":1,"data":{}}
```

使用 `--json` 时，错误写入 stderr：

```json
{"version":1,"error":{"code":"MODEL_NOT_FOUND","message":"..."}}
```

JSON 模式的 stdout 不混入提示、诊断或调试文本。

## 退出码

| 退出码 | 含义 |
|--------|------|
| `0` | 成功。 |
| `1` | Profile、密钥、网络、Provider 或运行时错误。 |
| `2` | 用法错误，包括未知参数和非法参数组合。 |
