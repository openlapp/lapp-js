# CLAUDE.md

Contributor guidance for `lapp-js`.

## Product boundary

`lapp-js` implements LAPP as a trusted local Provider Registry:

- `@openlapp/lapp` loads, validates, queries, resolves, refreshes, edits, and
  writes local profiles; its optional client calls upstream providers directly.
- `@openlapp/cli` is a thin SDK wrapper with stable JSON output.
- Applications may also implement the three-file LAPP contract directly.

v1 is limited to the local Registry, explicit Profile management, connection
resolution, and optional direct upstream calls. Unreleased drafts have no
compatibility or migration layer.

The profile is standard JSON only:

```text
~/.lapp/global.json
~/.lapp/providers/<id>/provider.json
~/.lapp/providers/<id>/models.json
```

`models.json` is authoritative. Remote model refresh is explicit, only appends
unknown IDs or fills missing names, and never removes or overwrites local data.

## Canonical spec and schemas

The canonical spec is pinned to commit
`5b6b4bd47b1d16cbede43d821046fc89e87c9689`. This repository vendors the three
v1 Schemas in `packages/lapp/schema/` so published packages remain
self-contained. Both packages also vendor the canonical bilingual protocol
specifications and bilingual user agreements. `spec-lock.json` stores that full
commit and immutable content hashes; `pnpm verify:spec` also verifies an available sibling checkout is at the
exact pinned commit. CI explicitly checks out that SHA, so push the canonical
commit before using it in `lapp-js` CI or release workflows. When a Schema shape
changes, update the spec, validator fixtures, vendored schemas/specifications, and lock
together. A semantic-only rule change updates the spec, validator, fixtures,
and pinned commit without inventing a Schema change.

Do not restore build-time Schema copying from a mutable sibling checkout.

## Commands

Run from the repository root with Node `>=18.18.0` and pnpm 10:

- `pnpm install --frozen-lockfile`
- `pnpm build`
- `pnpm lint`
- `pnpm test`
- `pnpm verify:docs`
- `pnpm verify:spec`
- `pnpm smoke:pack`

The SDK builds ESM, CJS, source maps, and declarations. The CLI builds an ESM
`lapp` executable. `pnpm clean` removes `dist` but preserves the versioned
Schema snapshot.

CI runs build, lint, tests, docs, and spec checks on Node 18/20/22, plus Ubuntu
and Windows Node 22 package/bin smokes. Only pushing a `v*` tag starts a
release; the tag must match both committed package versions. Prereleases
publish under `next`, stable versions under `latest`.

Stable release artifacts must not contain unreleased install notices or draft
spec status. The actual Distributor must complete legal review and supply its
identity, contact, governing law, dispute terms, controlling language, and
privacy notice before relying on the bundled user-agreement template as
binding.

## SDK architecture

All profile and connection behavior belongs in `packages/lapp/src/`; the CLI
must not duplicate it.

- `config/`: resolve explicit path, `LAPP_HOME`, or `~/.lapp`; parse standard
  JSON; `loadProfile` returns only validated domain data; `inspectProfile`
  returns partial redacted diagnostics.
- `validate/`: Ajv validates the three strict Schemas, then a small semantic
  pass checks cross-file identity, aliases, defaults, URLs, protocols, headers,
  and secret references.
- `manage/`, `plan.ts`, `write/`: immutable patch operations, file plans,
  containment checks, validation, and same-directory temp/fsync/rename writes.
  v1 assumes one writer and has no profile-wide transaction or backup.
- `connection.ts`: the only `listModels` and `resolveConnection` path. Listing
  is pure; resolution handles canonical IDs, aliases, enabled state, ordered
  protocol intersection, and strict auth.
- `sync/index.ts`: despite the directory name, this is only the explicit
  `refreshModels` implementation. It performs strict same-origin model
  discovery and returns a new in-memory Profile without writing.
- `client/`: adapters for `openai-chat-completions`, `openai-responses`, and
  `anthropic-messages`. Every request target comes from `resolveConnection`.

Package-root exports are explicit in `packages/lapp/src/index.ts`. Parsing
helpers, Ajv test hooks, adapter internals, and discovery internals stay private.

## CLI architecture

`packages/cli/src/index.ts` is bootstrap/router only. `args.ts` uses strict
`node:util.parseArgs`; `commands/profile.ts` owns profile commands,
`commands/runtime.ts` owns resolve/ping/chat, and `output.ts` owns JSON envelopes,
errors, exit semantics, and redaction.

Machine output is one `{"version":1,"data":...}` document; errors use the same
versioned envelope on stderr. No CLI command emits a credential. Raw values are
accepted only through a no-echo TTY prompt or stdin, never an argv value. Never
add prompts, diagnostics, or debug text to JSON stdout.

## Invariants

- Do not accept alternate file formats, old field spellings, or silent auth
  defaults.
- Core objects reject unknown properties; extension data belongs in
  `extensions`.
- Provider IDs are rejected, never sanitized; every write/delete target must
  stay under the selected root.
- `requestHeaders` are non-secret, cannot carry auth or cookies, use names that
  are unique case-insensitively, and cannot collide with header auth.
- `modelDiscovery.url` must be same-origin with `baseUrl`; remote URLs use
  HTTPS, loopback may use HTTP, and credential-bearing requests reject redirects.
- `listModels` performs no I/O or secret resolution.
- `selectConnection` is the canonical pure model/protocol selector;
  `resolveConnection` asynchronously applies the credential resolver.
- Missing environment/Vault secrets and binding mismatches fail before any
  request; plaintext writes require explicit opt-in and warn.
- Vault backend failures never fall back to files, environment variables, or
  plaintext. Native error messages and rollback diagnostics must be redacted.
- Removing a provider/model referenced by a default is rejected until the
  default changes.
- Preserve unrelated dirty-worktree changes.

## Tests

Use isolated temporary Profile roots and stubbed or local `fetch` implementations.
Security and non-trivial parsing changes need one focused regression test. The
pack smoke must install produced tarballs outside the workspace and invoke the
real package entry points and `lapp` binary.
