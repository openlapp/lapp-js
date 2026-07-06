# @openlapp/cli

Thin CLI wrapper over [`@openlapp/lapp`](https://www.npmjs.com/package/@openlapp/lapp).

All profile logic lives in the SDK; the CLI only parses args, calls the SDK, prints results, and redacts secrets.

## Install

```bash
npm install -g @openlapp/cli
```

## Usage

```
lapp validate [path]
lapp inspect [path] [--reveal-secrets]
lapp init [path] --provider <id> --protocol <p> --base-url <url>
lapp provider add [path] --id <id> --protocol <p> --base-url <url>
lapp model add [path] --provider <id> --id <id>
lapp ping [provider[/model]] [path]
lapp chat [provider[/model]] <message> [path]
lapp doctor [path]
```

## License

MIT
