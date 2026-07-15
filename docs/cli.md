# CLI reference

`lapp` is a thin wrapper over `@openlapp/lapp`. It reads the local provider
registry and either returns connection data or communicates with the selected
upstream provider directly. It runs no background service.

## Synopsis

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

The bracketed connection fields on `provider add` may be omitted only when
`--id` selects a recognized preset. Custom Providers require `--base-url`, at
least one `--protocol`, and an authentication choice.

## Profile path and writes

Profile commands accept `[path]`; runtime commands use `--path`. When omitted,
the CLI uses `LAPP_HOME`, then `~/.lapp`.

Provider, model, and default commands show a change plan. Add `--yes` to write
it or `--dry-run` to guarantee a preview. Fields omitted from a `set` command
are preserved.

```bash
lapp provider add --id openai --model gpt-4o-mini --yes
lapp provider add --id local --base-url http://127.0.0.1:11434/v1 \
  --protocol openai-chat-completions --no-auth --yes
lapp provider set --id openai --disabled --yes
lapp model add --provider openai --id gpt-4.1 --type chat --yes
lapp default set --task chat --provider openai --model gpt-4.1 --yes
```

Provider authentication sources are mutually exclusive:

- `--vault <credential-id>` stores hidden TTY input in the current-user Vault;
  non-interactive use requires `--stdin`, and replacement requires
  `--overwrite`;
- `--env <NAME>` stores an environment reference without reading its value;
- `--plaintext --allow-plaintext` stores hidden or piped input directly in the
  profile and prints a warning;
- `--no-auth` selects no authentication.

When a new authenticated Provider omits the source, an interactive terminal
defaults to `vault://<provider>/default` and prompts without echo. A
non-interactive caller must choose `--stdin` or `--env`; JSON mode never
prompts. `--auth-type bearer|header|query` and `--auth-name` select the auth
shape. Static non-secret headers use repeatable `--header NAME=VALUE`. Model
discovery is configured with both
`--models-protocol openai-models|anthropic-models` and `--models-url`.

Model fields use `--name`, repeatable `--alias`, `--protocol`, `--capability`,
`--input-modality`, and `--output-modality`, plus `--type`,
`--context-window`, `--max-output-tokens`, `--enabled`, or `--disabled`.

## Credentials

`credential set` stores or rotates a Vault record and updates the Provider
reference as one guarded operation. It reads from a hidden terminal by default
or from piped stdin with `--stdin`. `credential status` reports existence and
binding state without returning the value. `credential delete` removes only
the shared Vault record; it does not rewrite or remove the Provider.

```bash
lapp credential set --provider openai --stdin --yes
lapp credential set --provider openai --id secondary --stdin --overwrite --yes
lapp credential status --provider openai --json
lapp credential delete --provider openai --id secondary --yes
```

A dry run never prompts and never reads or writes Vault. There is no credential
get, export, or rebind command.

## Models

`models list` only reads the local authoritative `models.json` files.

```bash
lapp models list
lapp models list --provider openai --json
```

`models refresh` contacts the configured model-discovery endpoint and previews
new model IDs. It does not write unless both `--apply` and `--yes` are present.
Refresh appends new IDs in sorted order, preserves local order and fields, and
never removes models.

`--dry-run` is a no-I/O validation mode: it does not resolve credentials, read
Vault, contact the model-discovery endpoint, or write the Profile. Run without
`--dry-run` to fetch a real preview.

```bash
lapp models refresh --provider openai
lapp models refresh --provider openai --dry-run
lapp models refresh --provider openai --apply --yes --json
```

## Resolve and direct requests

Resolve a canonical model ID, protocol, endpoint, headers, and authentication:

```bash
lapp resolve --provider openai --model gpt-4o-mini --json
lapp resolve --default chat --protocol openai-responses \
  --protocol openai-chat-completions --json
```

`resolve` never resolves or prints a credential value. It reports the secret
scheme, whether that source is currently available, and whether a Vault record
matches the Provider binding.

`ping` and `chat` resolve the same target and call the upstream directly.
Without target flags they use the `chat` default.

```bash
lapp ping --default chat
lapp chat "Summarize this" --default chat
lapp chat "Count to ten" --provider openai --model gpt-4o-mini --stream
lapp chat "Reply briefly" --system "Be concise" --json
```

`--stream` and `--json` cannot be combined. A message can also be read from
stdin when no message arguments are provided.

## Inspection, presets, and JSON

- `validate` loads a complete valid profile or exits with an error.
- `inspect` reports partial profile information and diagnostics without secrets.
- `presets` lists built-in provider defaults used by `provider add`.

Machine output is always one JSON document:

```json
{"version":1,"data":{}}
```

With `--json`, errors are written to stderr:

```json
{"version":1,"error":{"code":"MODEL_NOT_FOUND","message":"..."}}
```

stdout contains no prompts, diagnostics, or debug text in JSON mode.

## Exit codes

| Code | Meaning |
|------|---------|
| `0` | Success. |
| `1` | Invalid profile, unavailable secret, network, provider, or runtime error. |
| `2` | Usage error, including unknown flags and invalid flag combinations. |
