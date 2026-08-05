# CLAUDE.md

Contributor guidance for `lapp-js`.

## Product boundary

`lapp-js` implements LAPP as a trusted local Provider Registry:

- `@openlapp/lapp` loads, validates, queries, resolves, refreshes, edits, and
  writes local profiles; its optional client calls upstream providers directly.
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

The canonical protocol lives in the sibling `openlapp/lapp` repository. This
repository vendors all four v1 Schemas, the bilingual protocol and agreements,
and the canonical conformance fixtures so published packages remain
self-contained. `spec-lock.json` records either an immutable canonical commit
or an explicitly labelled development working-tree snapshot with full content
hashes. `pnpm verify:spec` also byte-compares an available sibling checkout.
A working-tree snapshot is never release provenance: commit the canonical
changes and regenerate the lock before enabling CI or release workflows. When
a Schema shape changes, update the spec, validator fixtures, vendored
schemas/specifications/conformance data, and lock together. A semantic-only
rule change updates the spec, validator, fixtures, and snapshot without
inventing a Schema change.

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

The SDK builds ESM, CJS, source maps, and declarations. `pnpm clean` removes
`dist` but preserves the versioned
Schema snapshot.

CI runs build, lint, tests, docs, and spec checks on Node 18/20/22, plus Ubuntu
and Windows Node 22 package/bin smokes. Only pushing a `v*` tag starts a
public release; the tag must match all three committed workspace manifest versions.
Internal `0.x` builds publish only to the loopback Verdaccio Registry through
the `registry:*` scripts, without a Git tag or GitHub Release. Public package
publishing begins at `1.0.0`; prereleases then use `next` and stable versions
use `latest`.

Stable release artifacts must not contain unreleased install notices or draft
spec status. The actual Distributor must complete legal review and supply its
identity, contact, governing law, dispute terms, controlling language, and
privacy notice before relying on the bundled user-agreement template as
binding.

## SDK architecture

All profile and connection behavior belongs in `packages/lapp/src/`.

- `config/`: resolve explicit path, `LAPP_HOME`, or `~/.lapp`; parse standard
  JSON; `loadProfile` returns only validated domain data; `inspectProfile`
  returns partial redacted diagnostics.
- `validate/`: Ajv validates the four strict Schemas, then a small semantic
  pass checks cross-file identity, aliases, defaults, URLs, protocols, headers,
  and secret references.
- `manage/`, `plan.ts`, `write/`, `writer/`, `manager/`: immutable semantic
  operations, stable reads/revisions, global current-user locking, CAS,
  validated transactions, and containment-safe temp/fsync/rename writes with
  reverse actual-action rollback. There is no daemon, gateway, or automatic
  stale-lock stealing.
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
pack smoke must install produced SDK tarballs outside the workspace and invoke
the real package entry points.
