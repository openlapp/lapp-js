# LAPP JS SDK and CLI Design

## 1. Product Boundary

`lapp-js` is a TypeScript implementation layer for LAPP.

It has three roles:

1. **SDK core**: read, validate, write, and manage LAPP profiles.
2. **Client SDK**: send requests to configured providers using protocol adapters.
3. **CLI**: expose SDK workflows for humans and scripts.

It is not a gateway. It does not run a persistent server, accept inbound model requests, proxy traffic for other applications, or manage billing.

## 2. Package Shape

Recommended monorepo layout:

```text
lapp-js/
├── packages/
│   ├── lapp/          # @openlapp/lapp SDK
│   └── cli/           # lapp CLI
├── docs/
├── package.json
├── pnpm-workspace.yaml
└── tsconfig.base.json
```

The SDK is the product. The CLI is only the first consumer.

## 3. File Format Policy

- SDK should read existing `.json` and `.jsonc` profile files.
- SDK should write new files as `.json` by default.
- SDK does not need to preserve comments in v1.
- SDK should not silently rewrite unrelated files.
- SDK writes must be atomic per file.

Atomic write rule:

1. Build complete content in memory.
2. Validate before writing.
3. Write to a hidden temporary file in the same directory as the target file.
4. Close the temporary file.
5. Rename it over the target path.
6. On failure, best-effort remove only the temporary file.

No temporary directory, no backup files, no rollback system.

## 4. Secret Policy

v1 supports only:

- plaintext secret strings
- `env://NAME`

`keychain://` and `file://` may be parsed as references, but runtime secret resolution should return an explicit unsupported result unless support is intentionally added later.

Default behavior:

- never print full secrets in CLI output
- never include full secrets in validation diagnostics
- require explicit SDK option to resolve secret values
- support redacted inspection by default

## 5. SDK Core API

Suggested public API:

```ts
loadProfile(options?: LoadProfileOptions): Promise<LappProfile>
validateProfile(profile: LappProfile): ValidationResult
inspectProfile(profile: LappProfile): ProfileSummary

createProfile(input: CreateProfileInput): LappProfile
upsertProvider(profile: LappProfile, input: ProviderInput): LappProfile
removeProvider(profile: LappProfile, providerId: string): LappProfile
upsertModel(profile: LappProfile, input: ModelInput): LappProfile
removeModel(profile: LappProfile, target: ModelTarget): LappProfile
setDefaultModel(profile: LappProfile, target: ModelTarget): LappProfile

planChanges(before: LappProfile | null, after: LappProfile): ChangePlan
writeProfileAtomic(profile: LappProfile, options?: WriteOptions): Promise<void>
```

Important constraints:

- Profile mutation APIs should be pure or predictably immutable where possible.
- Write APIs should validate before touching disk.
- CLI should call these APIs, not implement profile editing itself.

## 6. Client SDK API

The client layer turns profile configuration into direct provider API calls.

Suggested API:

```ts
createLappClient(options?: CreateClientOptions): Promise<LappClient>

interface LappClient {
  chat(input: ChatInput): Promise<LappResponse>
  rawChat(input: ChatInput): Promise<unknown>
  testConnection(): Promise<TestConnectionResult>
}
```

Target selection:

```ts
createLappClient({ provider: "deepseek", model: "deepseek-chat" })
createLappClient({ model: "fast" })
createLappClient() // uses global default if available
```

Supported v1 protocols:

| Protocol | SDK method | Notes |
|---|---|---|
| `openai-chat-completions` | `chat`, `rawChat` | POST `/chat/completions` relative to configured base URL when needed |
| `openai-responses` | `chat`, `rawChat` | Maps simple chat input to Responses API input |
| `anthropic-messages` | `chat`, `rawChat` | Maps chat messages to Anthropic Messages format |

Unsupported protocols must fail clearly with `UnsupportedProtocolError`.

## 7. Unified Response Shape

SDK should return a normalized response while preserving raw output.

```ts
interface LappResponse {
  text: string
  provider: string
  model: string
  protocol: string
  usage?: {
    inputTokens?: number
    outputTokens?: number
    totalTokens?: number
  }
  finishReason?: string
  raw: unknown
}
```

`rawChat()` exists for users who want provider-native response handling.

## 8. CLI Commands

The CLI is a thin wrapper over SDK APIs.

Initial commands:

```text
lapp validate [path]
lapp inspect [path]
lapp init [path]
lapp provider add|set|remove
lapp model add|set|remove
lapp default set
lapp env [path]
lapp ping [provider[/model]]
lapp chat [provider[/model]] <message>
lapp doctor [path]
```

CLI behavior:

- write commands show a change plan before writing unless `--yes` is supplied
- all write commands support `--dry-run`
- output must redact secrets by default
- `chat` and `ping` are direct client SDK calls, not gateway calls

## 9. Explicit Non-goals for v1

Do not implement in v1:

- persistent gateway or local proxy
- GUI manager
- automatic IDE configuration rewriting
- keychain write or migration
- backup or rollback system
- remote provider model synchronization as a required path
- semantic routing or fallback chains
