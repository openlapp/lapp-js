# @openlapp/cli

Thin command-line wrapper for `@openlapp/lapp`. It reads a local LAPP profile,
lists and refreshes models, resolves connection credentials, and can call the
upstream provider directly. It runs no background service.

## Install

```bash
npm install -g @openlapp/cli
```

Node.js 18.18 or newer is required.

## Usage

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

The bracketed connection fields on `provider add` may be omitted only for a
recognized preset. Custom Providers require `--base-url`, at least one
`--protocol`, and an authentication choice. A raw credential defaults to the
current-user device Vault: use `--vault <id>` with hidden TTY input, or add
`--stdin` for piped input. `--env <NAME>` stores only a reference.
`--plaintext --allow-plaintext` is the explicit warned escape hatch.

Common examples:

```bash
lapp provider add --id openai --model gpt-4o-mini --yes
lapp credential status --provider openai
lapp credential set --provider openai --stdin --overwrite --yes
lapp default set --task chat --provider openai --model gpt-4o-mini --yes
lapp models list --json
lapp models refresh --provider openai
lapp models refresh --provider openai --apply --yes
lapp resolve --default chat --json
lapp chat "Hello" --default chat
```

`models refresh` is a preview unless both `--apply` and `--yes` are present.
It only appends newly discovered model IDs; it never removes local models or
overwrites existing model fields. `--dry-run` performs no credential, Vault,
network, or profile I/O; omit it to fetch a real preview.

JSON output is one document shaped as `{"version":1,"data":...}`. JSON errors
go to stderr as `{"version":1,"error":...}`. `resolve` reports only the
credential scheme, availability, and Vault binding state; there is no get or
export command. JSON mode never prompts for credential input.

See the full [CLI reference](https://github.com/openlapp/lapp-js/blob/main/docs/cli.md).
The installed package also includes the [English user agreement](./USER_AGREEMENT.en.md)
and [中文用户协议](./USER_AGREEMENT.zh-CN.md). Package installation distributes
the files but does not itself record affirmative acceptance.

The release-locked [English protocol](./spec.en.md) and
[中文协议](./spec.zh-CN.md) are distributed byte-for-byte with the CLI.

## License

MIT
