# @openlapp/cli

`@openlapp/lapp` 的轻量级 CLI 包装。

所有配置逻辑都在 SDK 中；CLI 只负责解析参数、调用 SDK、打印结果并对密钥脱敏。

> **Languages:** [English](https://github.com/openlapp/lapp-js/blob/main/README.md) | [中文](https://github.com/openlapp/lapp-js/blob/main/docs/zh/README.md)

## 安装

```bash
npm install -g @openlapp/cli
```

需要 Node 18.18 或更高版本。

## 用法

```text
lapp validate [path]
lapp inspect [path] [--reveal-secrets]
lapp init [path] --provider <id> --protocol <p> --base-url <url> [--secret <ref>] [--model <id>]
lapp provider add|set [path] --id <id> --protocol <p> --base-url <url> [--secret <ref>]
lapp provider remove [path] --id <id>
lapp model add|set [path] --provider <id> --id <id> [--alias <a>...] [--type <t>]
lapp model remove [path] --provider <id> --id <id>
lapp models sync [path] --provider <id> [--apply] [--remove-stale]
lapp default set [path] --provider <id> --model <id> [--kind chat|embedding|image|tts|video]
lapp env [path] --format bash|zsh|fish|powershell|cmd [--resolve] [--allow-plaintext]
lapp ping [provider[/model]] [path]
lapp chat [provider[/model]] <message> [path] [--provider <id> --model <id>] [--stream] [--tool <name:description:schema>]
lapp doctor [path]
```

## 全局参数

- `--dry-run` — 显示变更计划但不写入。
- `--yes` — 应用变更计划。
- `--reveal-secrets` — 显示密钥真实值而非脱敏占位符。
- `--help`, `-h` — 显示用法。
- `--version`, `-v` — 显示版本。

## 文档

- [CLI 参考](https://github.com/openlapp/lapp-js/blob/main/docs/zh/cli.md) — 完整的逐命令参考和示例。
- [入门指南](https://github.com/openlapp/lapp-js/blob/main/docs/zh/getting-started.md)
- [安全说明](https://github.com/openlapp/lapp-js/blob/main/docs/zh/security.md)
- [故障排除](https://github.com/openlapp/lapp-js/blob/main/docs/zh/troubleshooting.md)

## 许可证

MIT
