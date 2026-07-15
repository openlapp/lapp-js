# LAPP JS — Claude Code agent guidance

This file is contributor guidance. User documentation starts at
[`docs/getting-started.md`](docs/getting-started.md); the full contributor
summary is [`docs/internal/CLAUDE.md`](docs/internal/CLAUDE.md).

## Product contract

- `@openlapp/lapp` is the implementation. Profile parsing, validation, editing,
  model refresh, connection resolution, persistence, and direct requests belong
  in the SDK.
- `@openlapp/cli` is a thin strict-argument and output layer over SDK use cases.
- A Profile contains standard JSON only: optional `global.json`, and mandatory
  `provider.json` plus `models.json` for every Provider.
- `models.json` is authoritative. Refresh is explicit and only adds unknown IDs
  or missing display names.
- Public v1 behavior ends at local discovery, connection resolution, optional
  direct upstream calls, and explicit Profile management.

## Invariants

- `loadProfile` returns validated domain data; `inspectProfile` is the redacted
  recovery path for invalid trees.
- Disabled entries remain in memory but are omitted from normal model listing
  and rejected during resolution.
- `listModels` performs no I/O or secret resolution.
- `selectConnection` is the pure model/alias/default/protocol selector;
  asynchronous `resolveConnection` adds credential resolution.
- Authentication is the strict `none | bearer | header | query` union. Real
  secrets are plaintext, `env://NAME`, or `vault://provider/credential`.
  High-level writes default to Vault; no credential failure may silently fall
  back to another form.
- Vault records bind provider ID, normalized origin, and auth type/name. Direct
  clients resolve immediately before every request and never cache plaintext
  for the client lifetime.
- Static `requestHeaders` contain no authentication or cookies, use names that
  are unique case-insensitively, and never collide with header authentication.
- Provider IDs are rejected, never sanitized. Every write/delete must remain
  under the selected Profile root.
- Model discovery is same-origin, remote HTTPS or loopback HTTP, and rejects
  credential-bearing redirects.
- Core objects reject unknown properties; implementation data belongs in
  `extensions`.
- Removing a Provider/model referenced by a default is rejected until the
  default changes.

## Repository map and checks

- SDK: `packages/lapp/src/`
- CLI router and commands: `packages/cli/src/index.ts`, `args.ts`, `commands/`
- User docs: `docs/`
- Contributor detail: `docs/internal/CLAUDE.md`

Run `pnpm build`, `pnpm lint`, `pnpm test`, `pnpm verify:docs`,
`pnpm verify:spec`, and `pnpm smoke:pack` before release work. Releases start
only when a `v*` tag is pushed; both committed package versions must already
match that tag. Both packages must contain identical English and Chinese user
agreements. Preserve unrelated dirty-worktree changes.
