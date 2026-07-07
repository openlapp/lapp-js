# LAPP JS — Claude Code agent guidance

> This file is not user-facing documentation. For guidance on using `lapp-js`, see the [user docs](../getting-started.md) and the archived full version of this guidance at [internal/CLAUDE.md](internal/CLAUDE.md).

When working in this repository, preserve the following invariants. The full historical rationale, architecture, and contributor commands are in [internal/CLAUDE.md](internal/CLAUDE.md).

## Cross-cutting rules

- **SDK-first design**: all profile parsing, editing, validation, env export, and client request logic belongs in `@openlapp/lapp`. The CLI only parses args, calls the SDK, prints, and redacts.
- **Disabled providers** (`enabled: false`) are kept in memory so writes can round-trip the on-disk file, but are skipped by the client and by env-export.
- **Secrets**: redact by default everywhere. Resolving `env://` requires explicit opt-in. The client fails fast on unresolved secrets — never substitute a bogus value.
- **Auth-header dedup**: adapters strip auth-carrying keys (`authorization`, `x-api-key`) case-insensitively from user `requestHeaders` before adding their own. When `auth.queryParam` is set, header auth is stripped.
- **URL handling**: never auto-append `/v1` for OpenAI-compatible providers. Anthropic dedups a trailing `/v1` only when it is the sole last segment. `baseUrl` should not end with `/`.
- **Internal fields**: `__`-prefixed keys are bookkeeping only and stripped on write.

## Where things live

- User-facing docs: `docs/*.md`
- Archived design / build / review records: `docs/internal/*.md`
- SDK source: `packages/lapp/src/`
- CLI source: `packages/cli/src/index.ts`
- Build/test commands: `pnpm build`, `pnpm test`
