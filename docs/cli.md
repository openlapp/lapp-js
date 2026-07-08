# CLI reference

`lapp` is the command-line interface for LAPP — a thin wrapper over `@openlapp/lapp`. All profile logic lives in the SDK; the CLI parses arguments, calls the SDK, prints results, and redacts secrets by default.

## Common tasks

The two things you do most:

```bash
lapp chat "Say hi in five words."              # chat with the default model
lapp chat openai/gpt-4o-mini "Quick one."      # …or a specific provider/model
lapp chat "Count to ten" --stream              # stream the reply
```

**Adding a provider.** Two ways — a one-line preset or a fully explicit command:

```bash
# 1) Preset — fills protocol, baseUrl, and suggested env secret automatically
lapp provider add --id openai --model gpt-4o --yes

# 2) Fully explicit (custom/self-hosted providers)
lapp provider add --id my-proxy \
  --protocol openai-chat-completions --base-url https://my-proxy.example.com/v1 \
  --secret env://MY_PROXY_KEY --yes
```

See `lapp presets` for the built-in preset list (openai, anthropic, deepseek, openrouter, ollama, lm-studio, vllm, kimi, minimax, siliconflow).

**Checking health.**

```bash
lapp doctor              # validate + can each enabled provider become a client?
lapp ping openai/gpt-4o  # 1-token test request
lapp inspect             # human-readable summary (secrets redacted)
```

## Synopsis

```text
lapp validate [path]
lapp inspect [path] [--reveal-secrets]
lapp provider add|set [path] --id <id|preset> [--protocol <p>...] [--protocol-base-url <url>] [--protocol-header 'k: v']... [--base-url <url>] [--secret <ref>] [--auth-type bearer|header|query|none] [--auth-header <name>] [--auth-query-param <name>] [--no-auth] [--model <id>] [--name <s>] [--header 'k: v']... [--link k=v]... [--enabled|--disabled] [--force]
lapp provider remove [path] --id <id>
lapp model add|set [path] --provider <id> --id <id> [--alias <a>...] [--type <t>] [--capability <c>...] [--input-modality <m>...] [--output-modality <m>...] [--context-window <n>] [--max-output-tokens <n>] [--model-protocol <p>] [--link k=v]... [--metadata k=v]... [--metadata-json '{...}'] [--enabled|--disabled]
lapp model remove [path] --provider <id> --id <id>
lapp models list [path]
lapp models sync [path] --provider <id> [--apply] [--remove-stale] [--set-default] [--kind chat|embedding|image|tts|video]
lapp default set [path] --provider <id> --model <id> [--kind chat|embedding|image|tts|video]
lapp env [path] --format bash|zsh|fish|powershell|cmd [--resolve] [--allow-plaintext]
lapp presets
lapp ping [provider[/model]] [path]
lapp chat [provider[/model]] <message> [path] [--provider <id> --model <id>] [--stream] [--tool <name:description:schema>] [--session <name> | --continue] [--system <prompt>] [--file <path>...] [--json] [--debug]
lapp chat --list-sessions
lapp chat --delete-session <name>
lapp chat --delete-session-id <id>
lapp doctor [path]
lapp completions <bash|zsh|fish|powershell>
```

## Global flags

| Flag | Meaning |
|------|---------|
| `--dry-run` | Show the change plan but do not write anything. |
| `--yes` | Apply a write command after showing the plan. Without `--yes` and with real changes, the command exits non-zero so CI does not mistake a skipped write for success. |
| `--reveal-secrets` | Show secret values instead of redacted placeholders. Trusted environments only. |
| `--help`, `-h` | Show usage. |
| `--version`, `-v` | Show version. |

Every write command shows a change plan first and needs `--yes` to apply (or `--dry-run` to preview only).

## Path argument

Most commands accept an optional `[path]`. If omitted, the CLI resolves the profile root in this order:

1. The path argument, if given.
2. The `LAPP_HOME` environment variable.
3. `~/.lapp`.

See [configuration.md](configuration.md#profile-path-resolution) for details.

## Daily commands

### `lapp chat [provider[/model]] <message> [path]`

Send a chat message.

```bash
lapp chat "What is LAPP?"
lapp chat openai/gpt-4o "What is LAPP?"
lapp chat "Compare A/B testing" --provider openai --model gpt-4o
lapp chat "Count to ten" --stream
lapp chat "Use the weather tool" --tool weather:'Get the weather':'{"type":"object","properties":{"city":{"type":"string"}}}'
```

Target resolution:

1. `--provider` / `--model` flags (explicit; both required together so a model is never sent to the wrong provider).
2. The first positional **only if** it matches `provider/model` (one slash, no spaces, no extra slashes) **and** the provider segment exists in the loaded profile — so a message like `2/3` or `say/hi` is treated as text, not misrouted.
3. Otherwise all positionals are the message, and the global default model is used.

Flags:

- `--provider <id>` and `--model <id>` — explicit target; both required together.
- `--stream` — stream the response.
- `--tool <spec>` — register a stub tool for smoke-testing tool calling. Format: `name[:description[:schema-json]]`. The tool result is the string `(stub)`; useful for verifying a provider honors `tool_choice=auto`.
- `--session <name>` / `--continue` / `-c` — session persistence (see below).
- `--system <prompt>` — prepend a system message.
- `--file <path>` — attach text file content to the message (repeatable).
- `--json` — output as JSON instead of plain text.

Session flags:

- `--session <name>` — save the conversation under a named session. Subsequent calls with the same name append history, giving the model full context.
- `--continue` / `-c` — resume the most recently active session. Automatically reuses the provider and model the session was created with.
- `--list-sessions` — list all saved sessions.
- `--delete-session <name>` — delete a session and its history.

Session data lives in `~/.lapp-cli/sessions/` (or `$LAPP_CLI_HOME/sessions/`) — separate from the LAPP profile so admin tools can reuse the same store.

```bash
lapp chat "My name is Klark." --session intro
lapp chat "What's my name?" --continue
# → "Your name is Klark."

lapp chat --list-sessions
lapp chat --delete-session intro
```

The model's reply is printed verbatim — redaction is not applied to it (it would mangle legitimate key-shaped content).

`lapp chat` auto-allows-unauthenticated providers (those with `--no-auth` / `auth.type: "none"` / no secret), so the Ollama flow works without extra flags.

`--debug` prints the HTTP request and response (URL, status, body excerpt) to stderr, with auth headers redacted. Useful for troubleshooting provider integration issues.

Pipe input via `-`:

```bash
echo "Review this code:" | cat - app.ts | lapp chat - --stream
```

### Shell completions

Generate a completion script for your shell:

```bash
lapp completions bash      # eval "$(lapp completions bash)"
lapp completions zsh        # source <(lapp completions zsh)
lapp completions fish       # lapp completions fish | source
lapp completions powershell # lapp completions powershell | Out-String | Invoke-Expression
```

**Installation (bash):**
```bash
echo 'eval "$(lapp completions bash)"' >> ~/.bashrc
```

### `lapp default set [path]`

Set a global default model for a kind. This is how you change what a bare `lapp chat` uses.

```bash
lapp default set --provider openai --model gpt-4o --kind chat --yes
lapp default set --provider openai --model text-embedding-3-small --kind embedding --yes
```

| `--kind` | Global slot |
|----------|-------------|
| `chat` | `defaultModel` |
| `embedding` | `defaultEmbeddingModel` |
| `image` | `defaultImageModel` |
| `tts` | `defaultTextToSpeechModel` |
| `video` | `defaultVideoModel` |

### `lapp ping [provider[/model]] [path]`

Send a 1-token test request.

```bash
lapp ping
lapp ping openai/gpt-4o
lapp ping ollama/llama3
```

### `lapp doctor [path]`

Validate the profile and check that every enabled provider can be turned into a client. Reports unsupported protocols, missing models, and other configuration problems. Exits non-zero on real problems.

```bash
lapp doctor
```

## Provider commands

### `lapp provider add|set [path]`

Add a new provider, or update an existing one. `set` overlays only the fields you supply — a partial update does not wipe other fields. `add` on a fresh root auto-creates `manifest.json`; `add --force` resets an existing populated profile to just the new provider (absorbs the old `lapp init` destructive-reset role).

**Preset (one line):**

```bash
lapp provider add --id openai --model gpt-4o --yes
lapp provider add --id ollama --yes                 # local, no auth
```

**Fully explicit:**

```bash
lapp provider add --id deepseek \
  --protocol openai-chat-completions --base-url https://api.deepseek.com/v1 \
  --secret env://DEEPSEEK_API_KEY --yes
lapp provider set --id deepseek --base-url https://api.deepseek.com/beta --yes
```

**Multi-protocol (preference order, per-protocol baseUrl/headers):**

```bash
lapp provider add --id openai \
  --protocol openai-responses --protocol-header 'OpenAI-Beta: responses=v1' \
  --protocol openai-chat-completions \
  --model gpt-4o --yes
```

Each `--protocol` starts a `protocols[]` entry; `--protocol-base-url` and `--protocol-header` attach to the most recent `--protocol`.

Flags:

- `--id <id|preset>` — provider ID or a known preset id (required).
- `--protocol <p>` — repeatable; one entry per `protocols[]` slot. Omit with a preset.
- `--protocol-base-url <url>` — per-protocol base URL (attaches to the most recent `--protocol`). Must not end with `/`.
- `--protocol-header 'k: v'` — repeatable; per-protocol request header (attaches to the most recent `--protocol`).
- `--base-url <url>` — provider base URL (required unless a preset supplies it). Must not end with `/`.
- `--secret <ref>` — secret reference, e.g. `env://NAME` or a plaintext string. A preset fills the conventional `env://<PROVIDER>_API_KEY` if you omit it.
- `--auth-type bearer|header|query|none` — auth type. `--no-auth` is shorthand for `--auth-type none`.
- `--auth-header <name>`, `--auth-query-param <name>` — custom auth header / query param name (for non-bearer schemes).
- `--no-auth` — set auth type to `none` (local/self-hosted providers).
- `--model <id>` — also add this model and set it as the chat default in one command (`add` only adds the model entry if it doesn't exist; both `add` and `set` set the default).
- `--name <s>` — display name.
- `--header 'k: v'` — repeatable; provider-level static request headers (non-secret).
- `--link k=v` — repeatable; provider `links` map (e.g. `--link docs=https://...`).
- `--enabled`, `--disabled` — flip the provider's enabled state.
- `--force` — (`add` only) reset an existing populated profile to just this provider.

### `lapp provider remove [path]`

Remove a provider and any default references that pointed at it.

```bash
lapp provider remove --id deepseek --yes
```

### `lapp presets`

List the built-in provider presets (id, protocols, auth form, baseUrl). Use a preset id with `lapp provider add --id <preset>`.

```bash
lapp presets
```

## Model commands

### `lapp model add|set [path]`

Add or update a model under a provider.

```bash
lapp model add --provider openai --id gpt-4o --type chat --alias gpt4o --yes
lapp model set --provider openai --id gpt-4o --type chat --yes
lapp model add --provider openai --id text-embedding-3-small --type embedding \
  --input-modality text --output-modality embedding --context-window 8191 --yes
```

For `add`, `--alias` defaults to the model id if omitted. For `set`, aliases are left untouched when `--alias` is omitted (overlay-only invariant).

Flags:

- `--provider <id>` — provider ID (required).
- `--id <id>` — model ID (required).
- `--alias <a>` — repeatable; aliases for the model.
- `--type <t>` — model type: `chat`, `embedding`, `image`, `tts`, `video`, `rerank`, … (open string).
- `--capability <c>` — repeatable; capability tags (`tools`, `vision`, `streaming`, …).
- `--input-modality <m>` / `--output-modality <m>` — repeatable; modality lists (`text`, `image`, `audio`, …).
- `--context-window <n>` / `--max-output-tokens <n>` — integer limits.
- `--model-protocol <p>` — per-model protocol override (route one model through a different adapter).
- `--link k=v` — repeatable; model `links` map.
- `--metadata k=v` — repeatable; model `metadata` (string values).
- `--metadata-json '{...}'` — full metadata object (JSON).
- `--enabled`, `--disabled` — per-model enable flag.

### `lapp model remove [path]`

Remove a model and clear any default that pointed at it.

```bash
lapp model remove --provider openai --id gpt-4o --yes
```

### `lapp models list [path]`

Print each provider and its model ids.

```bash
lapp models list
```

### `lapp models sync [path]`

Fetch the provider's model list and show what would change.

```bash
lapp models sync --provider openai
lapp models sync --provider openai --apply --yes
lapp models sync --provider ollama --apply --set-default --yes
```

Flags:

- `--provider <id>` — provider to sync (required).
- `--apply` — write the merged model list back to disk.
- `--remove-stale` — drop provider-sourced entries the provider no longer reports (manual entries are kept).
- `--set-default` — after applying, set the first synced model of `--kind` (default `chat`) as the global default for that kind. Requires `--apply`.

The sync command automatically passes `allowUnauthenticated: true`, so it works with local providers such as Ollama without extra flags.

## Inspection & export

### `lapp validate [path]`

Load and validate a profile. Prints diagnostics and exits non-zero on errors.

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

### `lapp env [path]`

Emit shell statements for a profile's secrets, so you can source them into tools that read keys from environment variables.

```bash
lapp env --format bash
lapp env --format fish --resolve --allow-plaintext
```

Flags:

- `--format` — `bash`, `zsh`, `fish`, `powershell`, or `cmd`.
- `--resolve` — read `env://` values from the current environment.
- `--allow-plaintext` — include plaintext secrets (without this, they are omitted).

See [security.md](security.md) for the opt-in policy.

## Provider presets

| Preset | Protocols | baseUrl | Auth |
|--------|-----------|---------|------|
| `openai` | `openai-responses`, `openai-chat-completions` | `https://api.openai.com/v1` | `env://OPENAI_API_KEY` |
| `anthropic` | `anthropic-messages` | `https://api.anthropic.com` | `env://ANTHROPIC_API_KEY` |
| `deepseek` | `openai-chat-completions` | `https://api.deepseek.com/v1` | `env://DEEPSEEK_API_KEY` |
| `openrouter` | `openai-chat-completions` | `https://openrouter.ai/api/v1` | `env://OPENROUTER_API_KEY` |
| `ollama` | `openai-chat-completions` | `http://localhost:11434/v1` | `--no-auth` |
| `lm-studio` | `openai-chat-completions` | `http://localhost:1234/v1` | `--no-auth` |
| `vllm` | `openai-chat-completions` | `http://localhost:8000/v1` | `--no-auth` |
| `kimi` / `moonshot` | `openai-chat-completions` | `https://api.moonshot.cn/v1` | `env://MOONSHOT_API_KEY` |
| `minimax` | `openai-chat-completions` | `https://api.minimaxi.com/v1` | `env://MINIMAX_API_KEY` |
| `siliconflow` | `openai-chat-completions` | `https://api.siliconflow.cn/v1` | `env://SILICONFLOW_API_KEY` |

- `lapp-js` never auto-appends `/v1` — presets include it where the provider needs it.
- Don't end `--base-url` with `/`.
- For Anthropic, the adapter dedups a trailing `/v1` only when it is the sole last segment.
- For local servers, the preset sets `--no-auth`. Full walkthrough: [local-providers.md](local-providers.md).
- Extended protocols (e.g. `gemini-generate-content`) are NOT presets; edit `provider.json` by hand.

## Exit codes

| Code | Meaning |
|------|---------|
| `0` | Success, or validation passed with warnings only, or a write command with no changes. |
| `1` | Command failed (validation errors, configuration problem, write not applied because `--yes` was omitted but there were changes). |
| `2` | CLI usage error (missing required flag, unknown subcommand). |

## Migrating from `lapp init`

`lapp init` was removed. Replace it with `lapp provider add`:

```bash
# before
lapp init ~/.lapp --provider openai --protocol openai-chat-completions \
  --base-url https://api.openai.com/v1 --secret env://OPENAI_API_KEY --model gpt-4o --yes
# after (preset)
lapp provider add --id openai --model gpt-4o --yes
# after (explicit, no preset)
lapp provider add --id openai --protocol openai-chat-completions \
  --base-url https://api.openai.com/v1 --secret env://OPENAI_API_KEY --model gpt-4o --yes
```

`--force` (reset an existing profile) is now `lapp provider add --force`.
