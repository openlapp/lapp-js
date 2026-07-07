# CLI reference

`lapp` is the command-line interface for LAPP. It is a thin wrapper over `@openlapp/lapp`: all profile logic lives in the SDK, and the CLI only parses arguments, calls the SDK, prints results, and redacts secrets.

## Synopsis

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

## Global flags

| Flag | Meaning |
|------|---------|
| `--dry-run` | Show the change plan but do not write anything. |
| `--yes` | Apply a write command after showing the plan. |
| `--reveal-secrets` | Show secret values instead of redacted placeholders. Use only in trusted environments. |
| `--help`, `-h` | Show usage. |
| `--version`, `-v` | Show version. |

## Path argument

Most commands accept an optional `[path]`. If omitted, the CLI resolves the profile root in this order:

1. The path argument, if given.
2. The `LAPP_HOME` environment variable.
3. `~/.lapp`.

See [configuration.md](configuration.md#profile-path-resolution) for details.

## Commands

### `lapp validate [path]`

Load and validate a profile. Prints diagnostics and exits non-zero if any errors are present.

```bash
lapp validate
lapp validate /etc/lapp
```

### `lapp inspect [path]`

Print a human-readable summary of the profile. Secrets are redacted by default.

```bash
lapp inspect
lapp inspect --reveal-secrets
```

### `lapp init [path]`

Create a new `.lapp` profile. This command starts from an empty profile; if a profile already exists at the target path, use `--force` to overwrite it.

```bash
lapp init ~/.lapp \
  --provider openai \
  --protocol openai-chat-completions \
  --base-url https://api.openai.com/v1 \
  --secret env://OPENAI_API_KEY \
  --model gpt-4o \
  --yes
```

Flags:

- `--provider <id>` — provider ID (required)
- `--protocol <p>` — protocol ID (required)
- `--base-url <url>` — provider base URL (required)
- `--secret <ref>` — secret reference, e.g. `env://NAME` or a plaintext string
- `--model <id>` — also add this model and set it as the default
- `--no-auth` — set auth type to `none` for local/self-hosted providers
- `--yes` — write the profile immediately

### `lapp provider add|set [path]`

Add a new provider or update an existing one. `set` overlays only the fields you supply, so a partial update does not wipe other fields.

```bash
lapp provider add --id deepseek --protocol openai-chat-completions --base-url https://api.deepseek.com/v1 --secret env://DEEPSEEK_API_KEY --yes
lapp provider set --id deepseek --base-url https://api.deepseek.com/beta --yes
```

Flags:

- `--id <id>` — provider ID (required)
- `--protocol <p>` — protocol ID (required for `add`)
- `--base-url <url>` — provider base URL (required for `add`)
- `--secret <ref>` — secret reference
- `--no-auth` — set auth type to `none`
- `--enabled`, `--disabled` — flip the provider's enabled state

### `lapp provider remove [path]`

Remove a provider and any default references that pointed at it.

```bash
lapp provider remove --id deepseek --yes
```

### `lapp model add|set [path]`

Add or update a model under a provider.

```bash
lapp model add --provider openai --id gpt-4o --type chat --alias gpt4o --yes
lapp model set --provider openai --id gpt-4o --type chat --yes
```

For `add`, `--alias` defaults to the model id if omitted. For `set`, aliases are left untouched when `--alias` is omitted.

Flags:

- `--provider <id>` — provider ID (required)
- `--id <id>` — model ID (required)
- `--type <t>` — model type: `chat`, `embedding`, `image`, `tts`, `video`
- `--alias <a>` — repeatable; aliases for the model

### `lapp model remove [path]`

Remove a model and clear any default that pointed at it.

```bash
lapp model remove --provider openai --id gpt-4o --yes
```

### `lapp models sync [path]`

Fetch the provider's model list and show what would change.

```bash
lapp models sync --provider openai
lapp models sync --provider openai --apply --yes
lapp models sync --provider openai --apply --remove-stale --yes
```

Flags:

- `--provider <id>` — provider to sync (required)
- `--apply` — write the merged model list back to disk
- `--remove-stale` — drop provider-sourced entries that the provider no longer reports (manual entries are kept)

The sync command automatically passes `allowUnauthenticated: true` so it works with local providers such as Ollama.

### `lapp default set [path]`

Set a global default model for a given kind.

```bash
lapp default set --provider openai --model gpt-4o --kind chat --yes
lapp default set --provider openai --model text-embedding-3-small --kind embedding --yes
```

Kinds map to the global default slots:

| `--kind` | Global slot |
|----------|-------------|
| `chat` | `defaultModel` |
| `embedding` | `defaultEmbeddingModel` |
| `image` | `defaultImageModel` |
| `tts` | `defaultTextToSpeechModel` |
| `video` | `defaultVideoModel` |

### `lapp env [path]`

Emit shell statements for a profile's secrets so you can source them into tools that read keys from environment variables.

```bash
lapp env --format bash
lapp env --format fish --resolve --allow-plaintext
```

Flags:

- `--format` — `bash`, `zsh`, `fish`, `powershell`, or `cmd`
- `--resolve` — read `env://` values from the current environment
- `--allow-plaintext` — include plaintext secrets (without this, they are omitted)

See [security.md](security.md) for the opt-in policy.

### `lapp ping [provider[/model]] [path]`

Send a 1-token test request to a provider.

```bash
lapp ping
lapp ping openai/gpt-4o
lapp ping ollama/llama3
```

### `lapp chat [provider[/model]] <message> [path]`

Send a chat message.

```bash
lapp chat "What is LAPP?"
lapp chat openai/gpt-4o "What is LAPP?"
lapp chat "Compare A/B testing" --provider openai --model gpt-4o
lapp chat "Count to ten" --stream
lapp chat "Use the weather tool" --tool weather:'Get the weather':'{"type":"object","properties":{"city":{"type":"string"}}}'
```

Flags:

- `--provider <id>` and `--model <id>` — explicit target; both required together
- `--stream` — stream the response
- `--tool <spec>` — register a stub tool for smoke-testing tool calling (`name[:description[:schema-json]]`)

### `lapp doctor [path]`

Validate the profile and check that every enabled provider can be turned into a client. Reports unsupported protocols, missing models, and other configuration problems.

```bash
lapp doctor
```

## Exit codes

| Code | Meaning |
|------|---------|
| `0` | Success, or validation passed with warnings only. |
| `1` | Command failed (validation errors, configuration problem, write not applied). |
| `2` | CLI usage error (missing required flag, unknown subcommand). |

## Examples cookbook

### OpenAI with env secret

```bash
lapp init ~/.lapp \
  --provider openai \
  --protocol openai-chat-completions \
  --base-url https://api.openai.com/v1 \
  --secret env://OPENAI_API_KEY \
  --model gpt-4o \
  --yes
```

### Anthropic with a `links.models` override

```bash
lapp provider add \
  --id anthropic \
  --protocol anthropic-messages \
  --base-url https://api.anthropic.com \
  --secret env://ANTHROPIC_API_KEY \
  --yes

lapp model add --provider anthropic --id claude-sonnet-4 --type chat --yes
lapp default set --provider anthropic --model claude-sonnet-4 --kind chat --yes
```

### Local Ollama

```bash
lapp init ~/.lapp \
  --provider ollama \
  --protocol openai-chat-completions \
  --base-url http://localhost:11434/v1 \
  --no-auth \
  --model llama3 \
  --yes

lapp models sync --provider ollama --apply --yes
```

### Export secrets for Aider

```bash
lapp env --format bash --resolve >> ~/.bashrc
```

For full security guidance, see [security.md](security.md).
