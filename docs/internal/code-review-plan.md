# lapp-js Code Review Plan

A reusable, structured review playbook for this repo. Goals: high signal, low
noise, no re-reading the whole tree each round. Anchor the CLAUDE.md
invariants to real `file:line` once, then re-apply the checklist each round.

## Why this exists

Repeated ad-hoc review was inefficient because: scope was unbounded, dimensions
mixed, the same issue reappeared each round, weak findings got "fixed" then
reverted, and there was no stop condition. This plan fixes each:

- **Bounded scope** — review by SDK layer + CLI, never the whole tree at once.
- **Orthogonal dimensions** — bug / spec / security / data-integrity /
  contract / test run as separate channels.
- **Anchored invariants** — the table below maps every CLAUDE.md cross-cutting
  rule to a real location; subsequent rounds cite the row, not a re-guess.
- **Confidence gate** — 0–100 score, `<80` dropped (rubric below).
- **Seen-set** — fixed findings go into `seen`; recurrence → residual risk, not
  a re-finding.
- **Stop condition** — one round with 0 new ≥80 findings, max 3 rounds
  (deep review cap 5).

## Phases

0. **Anchor** — the invariant table below (done once; refresh on schema/CLAUDE.md change).
1. **Discover** — fan out `module × dimension`; each reviewer returns structured
   findings only.
2. **Dedup + score** — dedup by `file:line`; score each survivor 0–100; drop `<80`.
3. **Fix** — apply only safe-fixes (gate below); else residual risk.
4. **Re-review** — re-read only changed hunks; use `codegraph_explore` for
   caller / blast-radius, not full-file re-reads.
5. **Verdict** — `Pass` / `Conditional pass` / `Do not commit`.

## Scoring rubric (reuse verbatim)

- **0** — false positive or pre-existing issue.
- **25** — might be real, unverifiable; stylistic and not in CLAUDE.md.
- **50** — real but a nitpick; rare in practice.
- **75** — high confidence; hits in practice; insufficient existing approach.
- **100** — certain; hits frequently; evidence directly confirms.

## Safe-fix gate (apply a fix only when ALL true)

- Confidence high (≥80).
- Local to the reviewed file or adjacent test/config.
- Intended behavior clear from diff/caller/test/rule.
- Does NOT change public API, schema, migration, storage format, or business
  policy.
- Re-reviewable immediately.

Never auto-fix: migrations, rollback/permission/billing logic, broad refactors,
ambiguous product behavior, anything requiring invented requirements.

## False-positive filter (do not report)

- Formatting / import order / style a linter catches.
- Naming unless it breaks a documented contract.
- Broad "missing tests" without a specific untested branch.
- Generic security warnings without a data/control-flow path.
- Pre-existing issues outside reviewed scope.
- Alternative architectures with no demonstrated bug.
- Issues requiring product intent the reviewer lacks.

## Module × dimension matrix

| Module (LOC) | Primary dimensions | Anchored invariant rows |
| --- | --- | --- |
| config/discovery.ts (297) | bug, spec, data-integrity | 1, 2, 20 |
| config/jsonc.ts (84) | spec | 3 |
| validate/index.ts (325) + constants.ts | bug, contract | 4, 5, 20 |
| manage/index.ts (244) | data-integrity, bug | 6, 7, 21 |
| plan.ts (124) | bug | 8 |
| write/atomic.ts (213) | data-integrity, security | 9, 10, 11, 21 |
| secret/index.ts (129) | security | 12 |
| env-export/index.ts (215) | security, spec | 13 |
| client/index.ts (272) + adapter.ts | bug, contract, security | 14, 15, 16, 17, 18, 19, 20 |
| client/openai-*.ts, anthropic-messages.ts | contract, security | 15, 16, 17, 18, 19, 20 |
| cli/index.ts (510) | bug, security, test | 22, 23, 24, 25 |

## Invariant anchor table (Phase 0 output)

Each row: `id — rule — location — how to verify`.

1. **Root resolution priority** (explicit path > `LAPP_HOME` > `~/.lapp`) —
   [discovery.ts:44-48](packages/lapp/src/config/discovery.ts#L44-L48) `resolveLappRoot` —
   check the if-branch order.
2. **Disabled providers kept at load** (not filtered; client/env-export skip
   them) — [discovery.ts:218-230](packages/lapp/src/config/discovery.ts#L218-L230) —
   `providers.push(loaded)` runs even when `enabled === false` (only an INFO
   diag is added).
3. **`stripJsonc` is a verbatim port** of `../lapp/tools/validator/lapp-validate.mjs::stripJsonc` —
   [jsonc.ts:13-62](packages/lapp/src/config/jsonc.ts#L13-L62) — diff against
   upstream; do not "improve" divergently.
4. **Semantic rules in code** (alias dup, global-ref existence, secret-scheme
   warning, sensitive-header warning) —
   [validate/index.ts:82-99](packages/lapp/src/validate/index.ts#L82-L99) `validateSecret`,
   [101-116](packages/lapp/src/validate/index.ts#L101-L116) `validateRequestHeaders`,
   [162-205](packages/lapp/src/validate/index.ts#L162-L205) alias owner,
   [208-274](packages/lapp/src/validate/index.ts#L208-L274) `validateGlobal`.
5. **`additionalProperties: true` forward-compat** — schemas +
   [validate/index.ts:12-14](packages/lapp/src/validate/index.ts#L12-L14) comment —
   schema won't catch unknown fields; semantic layer must.
6. **`manage/*` immutable** (`structuredClone`, return new profile) —
   [manage/index.ts:63-75](packages/lapp/src/manage/index.ts#L63-L75) `clone` —
   every upsert/remove starts with `clone(profile)`.
7. **`upsert*` overlays only caller-supplied fields** —
   [manage/index.ts:104-138](packages/lapp/src/manage/index.ts#L104-L138) `upsertProvider`,
   [156-190](packages/lapp/src/manage/index.ts#L156-L190) `upsertModel` —
   spread `existing` then conditional `...(input.x !== undefined ? ...)`; a
   partial update must not wipe siblings.
8. **`planChanges`: existing `.jsonc` → `.json` write target; new files `.json`** —
   [plan.ts:43-50](packages/lapp/src/plan.ts#L43-L50) doc,
   [59-71](packages/lapp/src/plan.ts#L59-L71) `exists` `.jsonc` fallback.
9. **Atomic write contract**: build in mem → validate → hidden same-dir temp →
   `fsync` → rename; on failure remove ONLY temp; no backup/rollback —
   [write/atomic.ts:78-115](packages/lapp/src/write/atomic.ts#L78-L115) `atomicWriteFile`,
   [138-151](packages/lapp/src/write/atomic.ts#L138-L151) validate-before-write.
10. **`options.before` unlinks orphan** provider.json/models.json after writes
    succeed — [write/atomic.ts:186-213](packages/lapp/src/write/atomic.ts#L186-L213).
11. **`stableStringify` sorts keys + strips `__`-prefixed** —
    [write/atomic.ts:37-69](packages/lapp/src/write/atomic.ts#L37-L69) —
    `Object.keys(obj).sort()` + `if (key.startsWith("__")) continue`.
12. **Secrets**: redact by default; `env://` resolves only with `resolve:true`;
    `keychain://`/`file://` parsed but throw `UnsupportedSecretSchemeError` —
    [secret/index.ts:52-60](packages/lapp/src/secret/index.ts#L52-L60) `redactSecret`,
    [79-128](packages/lapp/src/secret/index.ts#L79-L128) `resolveSecret`.
13. **env-export**: same opt-in; plaintext needs `resolve` + `allowPlaintext`;
    disabled providers skipped —
    [env-export/index.ts:65-149](packages/lapp/src/env-export/index.ts#L65-L149)
    (`enabled === false` continue at L78).
14. **Client**: resolve target → pick adapter → disabled skip → fail-fast on
    unresolved secret (never substitute placeholder) —
    [client/index.ts:107-177](packages/lapp/src/client/index.ts#L107-L177)
    (disabled check L140-142; fail-fast L158-164).
15. **Adapter interface** `buildRequest`+`parseResponse`→`LappResponse` with
    `raw` preserved — [adapter.ts:67-71](packages/lapp/src/client/adapter.ts#L67-L71),
    [28-40](packages/lapp/src/client/adapter.ts#L28-L40) — verify `raw` returned
    in all 3 adapters.
16. **Auth-header dedup** (`authorization`, `x-api-key`, case-insensitive) —
    [openai-chat.ts:15-42](packages/lapp/src/client/openai-chat.ts#L15-L42),
    [openai-responses.ts:15-40](packages/lapp/src/client/openai-responses.ts#L15-L40),
    [anthropic-messages.ts:30-57](packages/lapp/src/client/anthropic-messages.ts#L30-L57).
17. **`auth.queryParam` set → strip header auth** (avoid leaking in both URL +
    header logs) — [client/index.ts:186-211](packages/lapp/src/client/index.ts#L186-L211).
18. **Never auto-append `/v1` for OpenAI** —
    [openai-chat.ts:11-13](packages/lapp/src/client/openai-chat.ts#L11-L13),
    [openai-responses.ts:11-13](packages/lapp/src/client/openai-responses.ts#L11-L13)
    `joinUrl` is plain concat.
19. **Anthropic dedups trailing `/v1` only when sole last segment** —
    [anthropic-messages.ts:11-28](packages/lapp/src/client/anthropic-messages.ts#L11-L28)
    `joinUrl`.
20. **`baseUrl` should not end with `/`** (WARN) —
    [discovery.ts:149-155](packages/lapp/src/config/discovery.ts#L149-L155),
    [validate/index.ts:147-149](packages/lapp/src/validate/index.ts#L147-L149).
21. **Internal `__`-prefixed fields stripped on write** —
    [write/atomic.ts:60-61](packages/lapp/src/write/atomic.ts#L60-L61) +
    [162-164](packages/lapp/src/write/atomic.ts#L162-L164).
22. **CLI write commands**: show `planChanges` diff first; require `--yes` or
    `--dry-run` — [cli/index.ts:453-475](packages/cli/src/index.ts#L453-L475) `maybeWrite`.
23. **CLI secrets redacted by default; `--reveal-secrets` opt-in** —
    [cli/index.ts:179-202](packages/cli/src/index.ts#L179-L202) `cmdInspect`.
24. **CLI error text scrubbed with `redactAll`** —
    [cli/index.ts:131-135](packages/cli/src/index.ts#L131-L135),
    [508-510](packages/cli/src/index.ts#L508-L510).
25. **CLI `chat` reply printed verbatim, NOT redacted** —
    [cli/index.ts:404-408](packages/cli/src/index.ts#L404-L408).

## Tooling map

| Scenario | Use |
| --- | --- |
| Incremental pre-commit review | `code-review-local` default mode |
| Full / initial review (current state) | `code-review-local` force mode, or fan-out agents below |
| Quality cleanup (reuse/simplify/efficiency) | `/simplify` |
| Security专项 | `/security-review` |
| Verify real behavior after a fix | `/verify` |
| Locate symbols / blast-radius | `codegraph_explore` (NOT grep+read loops) |

## Cadence

- **Now** (no commits yet): one-off initial full review by subsystem.
- **Steady state**: `code-review-local` default mode per commit/PR; full review
  + `/security-review` before release.

## Round 1 results (seen-set — do not re-flag these)

Applied safe-fixes (all verified by `pnpm test`, 91 passed; `tsc --noEmit` clean
on both packages):

- discovery.ts header comment now matches the keep-disabled behavior (row 2).
- plan.ts queues orphan `models.json` for deletion when a provider with a
  malformed (un-parseable) models.json is removed (row 8 / bug).
- validate/index.ts now warns when an alias duplicates a real model id, not
  just when it duplicates another alias (row 4 / bug).
- env-export/index.ts strips CR/LF/control chars from the unresolved-branch
  reason text before embedding in `#`/`REM` comment lines — closes a shell
  injection via `env://foo\nrm -rf ~` (row 13 / security).
- client/index.ts all-disabled profile now throws "no enabled provider
  available in profile" instead of falling through to a misleading
  "provider is disabled" (row 14 / bug).
- openai-chat + openai-responses reject `stream:true` with a clear error
  instead of silently returning an empty `LappResponse` (row 15 / bug).
- cli: `default set` refuses a non-existent profile (mirrors `provider/model
  remove`); `ping` and `doctor` error output now goes through `redactAll` and
  to stderr (rows 22/24).

Refuted (do not re-flag — adversarial test proves the code is correct):

- Anthropic `joinUrl` "gateway over-strip" was reported at confidence 95 but
  is a FALSE POSITIVE. The existing regression test
  `client.test.ts > anthropic + gateway baseUrl ending in /v1 still appends /v1`
  asserts `https://gateway.corp/openai/v1` + `/v1/messages` →
  `https://gateway.corp/openai/v1/messages` and passes. The code strips `/v1`
  from the **suffix**, not the base, so the base keeps its `/v1`. The reviewer
  misread the direction of the strip.

Residual (NOT auto-fixed — need a product/architecture decision, logged here so
they are not lost):

- **client/index.ts `err.raw` leaks un-redacted response body** (Major 90).
  `redactErrorText` only scrubs the substring embedded in `Error.message`;
  `err.raw` holds the parsed-but-un-redacted body. Fix needs a deep-walk
  redaction design (don't mangle structured data). Decision needed.
- **openai-responses assistant→developer remap** (Major 80). Multi-turn
  assistant history is remapped to `role:"developer"`, which the Responses API
  treats as a high-priority instruction. Pick: drop prior assistant turns,
  merge into `instructions`, or reject multi-turn assistant input in v1.
- **ajv silent-pass when no schemas loaded** (Major 90). If the schema dir is
  missing at runtime, `ajvValidate` returns `{ok:true}` for every call, so
  `upsertProvider({protocol:"gpt-5"})` passes. Pick: fail-fast in `getAjv`,
  or emit a one-time WARN, or keep permissive.
- **write/atomic.ts `__dirName === ""`** (Minor 80). `??` doesn't catch empty
  string, so multiple providers with empty `__dirName` clobber at
  `providers/provider.json`. Contrived (loader sets `__dirName` from dir
  basename); fix is `||` if it becomes realistic.
- **validate source/type enum levels** (Minor 80/75). WARN-vs-ERROR for
  out-of-enum `source`/`type` values is a spec decision.
- **validate dedup key (level+location+message) is lossy** (Minor 80). Rare
  re-emit-on-shifted-index case; needs a discriminator field on `Diagnostic`.
- **CLI `chat --provider/--model` flags undocumented + half-behavior**
  (Suggestion 85). Document + require both, or drop and rely on positional.
- **CLI `parseFlags` doesn't support `--flag=value`** (Suggestion 80).
- **CLI direct `profile.global` mutation** (Suggestion 75). Violates "all
  editing in the SDK"; move to `setDefaultModel`/`ensureGlobal`.

Stop condition: one clean round. Round 1 produced residuals but no remaining
Critical/Major **fixable-without-decision** findings, so the loop stops here at
**Conditional pass** — the three Major residuals above block a clean `Pass`
until the product decisions are made.

## Round 2 results (seen-set — do not re-flag these)

Applied safe-fixes (all verified by `pnpm test`, 284 passed; +1 regression
test in `tools.test.ts`):

- **sync/index.ts `applySyncedModels` preservation loop** (data-integrity /
  bug, confidence 90). The condition `!existingById.has(m.id) || !result.models.some(...)`
  had a dead disjunct (`existingById` is built from the same iterated array,
  so `has(m.id)` is always true) and an inverted disjunct (skipped entries NOT
  in fetched, the opposite of intent). Result: manual `source: "manual"`
  model entries were silently dropped on every sync. Fixed by replacing the
  loop with a simple preserve-all-non-duplicates pass. Regression test
  `sync.test.ts > preserves existing entries not in the fetched list (manual
  entries survive)` seeds `before` with a manual entry absent from `fetched`
  and asserts it survives.
- **sync/types.ts `SyncOptions.removeStale` dead option** (bug, confidence 85).
  The field was accepted by `syncProviderModels` but never read; the CLI
  passed it but the actual stale removal was reimplemented in the CLI's
  `cmdModels` (`--remove-stale` filter on `source === "provider"`). Removed
  from `SyncOptions` and from the CLI's call site. The CLI's source-aware
  filter remains.
- **anthropic-messages.ts `buildMessages` lost assistant text on multi-turn
  tool loop** (bug, confidence 95). When an assistant message carried both
  `content` (text) and `toolCalls`, the mapped content array contained only
  the `tool_use` blocks; `m.content` was dropped. Multi-turn `executeWithTools`
  loops therefore lost the model's prior reasoning on every continuation.
  Fixed by emitting a text block first (when non-empty), then the tool_use
  blocks. Tool argument JSON is now parsed inside a try/catch (cross-provider
  tool history may carry an unparseable string). Regression test
  `tools.test.ts > anthropic-messages: assistant text + toolCalls round-trip
  together` seeds an assistant turn with `content: "thinking about it"` and
  one `toolCalls` entry, and asserts both blocks are present in the captured
  request.

Refuted (do not re-flag — adversarial review proves the code is correct):

- **write/atomic.ts:168 shallow copy shares `models.models` array reference**
  (manage/write reviewer, confidence 80). False positive: `manage/*` calls
  `clone(profile)` which is `structuredClone`, so the in-memory profile is
  already a deep copy. The spread in `writeProfileAtomic` only matters if the
  caller mutates `provider.models.models` between the manage call and the
  write; under normal flow (manage → write) the source array is already
  isolated.
- **manage/index.ts `upsertProvider` cannot express "clear models"**
  (manage/write reviewer, confidence 85). Not a bug: `replaceProviderModels(
  profile, providerId, null)` is the documented clearing API. `upsertProvider`
  intentionally preserves existing models when the caller's `input.models` is
  empty/undefined — by design, since `upsertProvider` is for partial updates.
  The two functions have separate, documented contracts.
- **CLI `cmdModels sync` dry-run gate "duplicated"** (CLI reviewer, confidence
  90). Not a bug. The early-return in `cmdModels` triggers on
  `flags["dry-run"] || !flags.apply` and prints sync-specific output (counts
  + detailed ids). `maybeWrite`'s check runs only when `cmdModels` falls
  through (i.e. `--apply` without `--dry-run`), and it prints file-level
  `planChanges` output. The two gates are at different abstraction levels
  (sync summary vs. file diff) and the output is complementary, not
  duplicated.
- **CLI `chat --stream` tool-call arguments not redacted** (CLI reviewer,
  confidence 85). Not a defect. `ev.arguments` is part of the model's reply
  (not error text); per invariant row 25, "CLI chat reply printed verbatim,
  NOT redacted". Tool-call args follow the same rule. The `redactAll` is
  reserved for error messages (row 24).

Residual (NOT auto-fixed — need a product/architecture decision, recorded
here for the next reviewer):

- **client/index.ts `err.raw` leaks un-redacted response body** (Major 90).
  `redactErrorText` only scrubs the substring embedded in `Error.message`;
  `err.raw` holds the parsed-but-un-redacted body. Fix needs a deep-walk
  redaction design (don't mangle structured data). Decision needed. **Carried
  forward from Round 1.**
- **openai-responses assistant→developer remap** (Major 80). Multi-turn
  assistant history is remapped to `role:"developer"`, which the Responses
  API treats as a high-priority instruction. Pick: drop prior assistant
  turns, merge into `instructions`, or reject multi-turn assistant input in
  v1. **Carried forward from Round 1.**
- **ajv silent-pass when no schemas loaded** (Major 90). If the schema dir
  is missing at runtime, `ajvValidate` returns `{ok:true}` for every call, so
  `upsertProvider({protocol:"gpt-5"})` passes. Pick: fail-fast in `getAjv`,
  or emit a one-time WARN, or keep permissive. **Carried forward from
  Round 1.**
- **write/atomic.ts `__dirName === ""`** (Minor 80). `??` doesn't catch
  empty string, so multiple providers with empty `__dirName` clobber at
  `providers/provider.json`. Contrived (loader sets `__dirName` from dir
  basename); fix is `||` if it becomes realistic. **Carried forward from
  Round 1.**
- **write/atomic.ts unconditional `updatedAt` stamp on every write**
  (Suggestion 75, below auto-fix threshold). Every non-sync write re-stamps
  `models.json`'s `updatedAt`, making it unreliable as a "last synced"
  marker. Pick: stamp only on sync flow, or preserve existing value when
  present, or accept that `updatedAt` means "last written" not "last synced".
  Decision needed.
- **sync/capabilities.ts heuristic over-matches** (Suggestion 80). The
  image-generation branch matches the bare substring `"image"`, the embedding
  branch matches `"m3"`. Could misclassify chat models with these substrings
  in their id. Documented as best-effort; a fix would narrow the needle set
  and require `id` to start with an embedding-specific token. **New in
  Round 2.**
- **sync/diff.ts `sameEntry` `JSON.stringify(undefined)`** (Bug, confidence
  90, below auto-fix threshold — single-field, easily fixed but flagged as
  residual because the diff is recomputed each sync). `a.capabilities?.slice()
  .sort()` returns `undefined` when `capabilities` is missing; the expression
  is then passed to `JSON.stringify` which produces the string `"undefined"`,
  not `""` or `null`. False positives in `updated` set when `existing` has no
  capabilities but `fresh` has `[]`. **New in Round 2.**
- **client/sse.ts `Symbol.for("ReadableStream") in body` detection**
  (Observation, confidence 85, no known failure case). The `in` operator
  traverses the prototype chain. Works for Web ReadableStream in current
  target envs but is fragile across runtimes. **New in Round 2.**
- **validate source/type enum levels, dedup key lossy, CLI parseFlags
  no-`=`-support, CLI direct `profile.global` mutation, `chat --provider/--model`
  flags undocumented** — all carried forward from Round 1.

Stop condition: **Conditional pass** at Round 2. Two Major residuals
(`err.raw` deep-walk, `assistant→developer` remap) require product decisions
and block a clean `Pass`. The other residuals are by design or sub-threshold.

## Round 3 results (pre-release cleanup, 2026-07-07)

Final cleanup of every residual carried forward from Round 1 / Round 2.
All changes verified by `pnpm test` (313 passed; +28 over Round 2) and
`pnpm build` (both packages clean).

Applied safe-fixes:

- **Major 90 `err.raw` redaction** (client/index.ts) — `redactRawObject()`
  deep-copies the parsed response body and scrubs every string leaf via
  `SECRET_PATTERNS`. Cycle-safe (WeakSet) and depth-bounded (64). Set on
  `err.raw` before throwing. Regression: 3 tests in
  `client.test.ts` (nested object, non-JSON `_rawText`, deeply-nested
  70-level).
- **Major 80 `assistant→developer` remap** (openai-responses.ts:73) —
  removed the remap. Multi-turn assistant history is forwarded as
  `role: "assistant"` to preserve `executeWithTools` continuity.
  Regression test in `client.test.ts`.
- **Major 90 ajv silent-pass when no schemas loaded** (validate/index.ts) —
  `getAjv()` now tracks `schemasLoaded` and surfaces a one-time WARN
  diagnostic in `validateProfile` (and `loadProfile`'s merged diagnostics).
  Test hook: `LAPP_SCHEMA_DIR` env var (un-declared; read via bracket
  access to keep the public surface clean). Regression: 3 tests in
  `validate-schemas-missing.test.ts`.
- **Medium 80 `sync/capabilities.ts` heuristic over-match** (sync/capabilities.ts) —
  rewritten with `idStartsWithAny` and `idHasToken` helpers; substring
  matching replaced with prefix + token-set matching. Mis-classification
  of "m3-large-chat" (embedding) and "image-classifier-v1" (image-gen)
  fixed. 4 new regression tests in `sync.test.ts`.
- **Medium 80 `write/atomic.ts` unconditional `updatedAt` stamp** (write/atomic.ts)
  — `applySyncedModels` tags the result with an internal
  `__lappUpdatedAtSource: "sync"` marker (stripped on write by
  `stableStringify`); `writeProfileAtomic` only re-stamps when this
  marker is present. The existing "stamp on every write" test in
  `schema-alignment.test.ts` updated to reflect the new behavior, plus
  a new sync-path test.
- **Minor 80 `write/atomic.ts` empty `__dirName` clobber** (write/atomic.ts) —
  `??` replaced with `||` so an empty string falls back to
  `provider.config.id` (a hand-crafted profile with `__dirName: ""` no
  longer writes to `providers//provider.json`).
- **Suggestion 80 CLI `parseFlags` no-`=`-support** (cli/src/index.ts) —
  added `--key=value` parsing. Split at first `=` so a value like
  `name=with=equals` survives intact. `--key=` (empty value) is treated
  as a boolean toggle to match the existing flag-without-value semantics.
  3 new tests in `index.test.ts`; the old "not supported" test was
  inverted.
- **Suggestion 75 CLI direct `profile.global` mutation** (cli/src/index.ts
  + manage/index.ts) — added `ensureGlobal(profile)` to the SDK; the
  CLI's `cmdDefault` now calls it instead of mutating `profile.global`
  in place. 2 tests in `manage-write.test.ts`.
- **Observation 85 SSE `Symbol.for("ReadableStream")` detection**
  (client/sse.ts) — replaced the prototype-chain `in` check with a
  constructor comparison against `globalThis.ReadableStream`. Falls back
  to AsyncIterable otherwise. Regression: 1 new test in `stream.test.ts`.

Refuted (no code change, just comment in place):

- **Bug 90 `sync/diff.ts` `JSON.stringify(undefined)` false positive** —
  `arraysEqual` never stringifies. Comment added explaining the guards.

Documented boundary (no code change intended):

- **Minor 80 `validate` dedup key (level+location+message) is lossy** —
  the `discovery.ts` merge block now carries an explicit comment
  explaining the narrow dedup key, the shifted-index re-emit case it
  doesn't cover, and why a richer discriminator would leak into the
  public `Diagnostic` type. Accept the small loss in v1.

Round 2 docs tightened:

- `chat` usage now advertises `--provider <id> --model <id>` and the
  parser requires both when either is supplied (regression: the old
  half-behavior where a model could be silently dropped if only
  `--provider` was passed).
- `validate` source-enum level: out-of-enum `source` is now **ERROR**
  (closed enum per spec), with the existing test inverted to assert
  ERROR. Unknown `type` strings remain WARN (forward-compat opaque).

Stop condition: **Pass at Round 3**. All Round 1 / Round 2 residuals
are resolved or explicitly refuted. 313/313 tests pass, `pnpm build` is
clean on both packages, no Critical / Major findings remain. The
shippable v1.0.0 release is green.

## Round 4 results (post-v1.0.0 max-effort review, 2026-07-07)

Max-effort re-review of the v1.0.0 diff (10 finder angles + 1 sweep, all
findings verified by writing throwaway vitest tests against the real
code paths and confirming each one reproduced the bug; the scratch tests
were removed after the fix landed). All 14 surviving findings were
auto-fixed. 327/327 tests pass (313 original + 14 regression tests),
`pnpm build` is clean.

Applied safe-fixes:

- **Critical 95 openai-responses stream tool-call correlation (F4)**
  (`openai-responses.ts:192`). The Responses API correlates delta events
  via top-level `item_id` (= `item.id`, e.g. `fc_123`), NOT `item.call_id`
  (`call_123`). The accumulator was keyed by `call_id` and looked up by
  `item_id`, so streamed tool-call arguments were silently empty for the
  real OpenAI Responses API. Key the accumulator by `item.id` first,
  falling back to `call_id` for compat. Verified: realistic-shape test
  yielded `arguments:""` (expected `'{"x":1}'`).

- **High 90 duplicate tool-call emission (F1/F2/F3)** across all 3
  adapters. The in-loop flush (`finish_reason` / `response.completed` /
  `message_stop`) did not clear the accumulator, so the post-loop
  truncated-stream flush re-emitted every tool call on a normal completion.
  Added a `flushed` flag in each `parseStream`. Verified: 2 events (expected 1).
  The truncated-stream path still flushes correctly.

- **High 90 `upsertProvider` wipes multi-protocol array (F9)**
  (`manage/index.ts:129`). Passing the legacy `protocol` field (no
  `protocols`) collapsed an existing multi-entry array to
  `[input.protocol]`, violating the overlay-only invariant (row 7).
  Preserve `existing.config.protocols` unless the caller passes
  `protocols`. Verified: length 1 (expected 2) before fix.

- **High 90 `redactRawObject` depth cap leaks secrets (F10)**
  (`client/index.ts:80`). The depth-64 cap short-circuited before string
  leaves could be scrubbed. Strings are now scrubbed at every depth; the
  cap only bounds structural recursion. Verified: secret nested 70 levels
  deep was present in `err.raw` (expected redacted).

- **High 85 sync drops `requestHeaders` (F5)**
  (`sync/openai-compat.ts:60`). `fetchOpenAiCompatModels` only set
  `Content-Type` + auth, so a provider requiring a non-auth static
  header (e.g. `X-Tenant-Id`) failed sync while chat worked. Now spreads
  `ctx.requestHeaders` with the same auth-strip discipline as the chat
  adapters. Verified: `X-Tenant-Id` absent from sync headers.

- **High 85 anthropic stream `input_tokens` dropped (F8)**
  (`anthropic-messages.ts:222`). `message_delta` does not carry
  `input_tokens`; capture them from `message_start` and merge into the
  usage event. Verified: yielded usage had `outputTokens:5` only
  (expected `inputTokens:42, outputTokens:5`).

- **High 80 sync marker survives manage edits (F11)**
  (`manage/index.ts:193`, `write/atomic.ts:172`). `upsertModel` and
  `removeModel` reused the `models` object carrying
  `__lappUpdatedAtSource:"sync"`, so a sync-then-manage sequence
  silently re-stamped `updatedAt` on what was actually a manage edit
  (contradicting the Round 3 design). Manage edits now `delete` the
  marker; the writer also strips it defensively. Verified: marker
  persisted as `"sync"` after `upsertModel`.

- **High 80 `idHasToken` image-generation dead code (F7)**
  (`sync/capabilities.ts:88`). `idHasToken` splits the id on
  `[-_/.]`, so the literal token `"image-generation"` was always
  split into two tokens and the branch never matched. Added
  `lowerIdHasToken` substring helper; replaced the dead call.
  Verified: model id `"image-generation"` classified as `chat`
  (expected `image`).

- **High 80 CLI `models sync` no `allowUnauthenticated` (F6)**
  (`cli/src/index.ts:435`). Local providers with `auth.type:"none"`
  (Ollama) threw on sync. CLI now passes `allowUnauthenticated: true`
  for the documented local-provider use case. Verified: sync succeeded
  with the flag and threw without it.

- **High 80 CLI `model set` wipes aliases (CLI-aliases)**
  (`cli/src/index.ts:397`). Omitting `--alias` defaulted to `[id]`,
  clobbering user-curated aliases and violating the overlay-only
  invariant (row 7). The `set` subcommand now omits aliases when not
  supplied. Verified: prior aliases wiped to `["m"]` (expected preserved).

- **Medium 75 CLI `--enabled`/`--disabled` silently ignored**
  (`cli/src/index.ts:369`). `cmdProvider` never read `flags.enabled`/
  `flags.disabled`. Now honored for both add and set.

- **Reuse 80 `SECRET_PATTERNS` duplicated in sync** (F14). Third copy
  in `sync/openai-compat.ts:15`. Extracted `packages/lapp/src/redact.ts`
  as the canonical home; client re-exports for back-compat. Adding a new
  secret pattern now covers the client, sync, and CLI in one edit.

- **Reuse 80 `buildHeaders` triplicated across adapters** (F15). Three
  copies of the auth-strip + content-type + bearer/custom-header logic
  (openai-chat, openai-responses, anthropic). Extracted
  `packages/lapp/src/client/http.ts` with `buildAuthHeaders` and
  `buildAuthHeadersWith`. Anthropic keeps a thin wrapper to handle the
  `x-api-key` + `anthropic-version` conventions.

Refuted (no code change):

- **Angle B removed-behavior auditor**: all invariant guards from the
  pre-PR code re-established in the new code.
- **Angle J conventions auditor**: no quotable CLAUDE.md violations.
- **Angle C cross-file tracer**: `createLappClient` correctly routes
  through `send` → `buildRequest` → `parseResponse`; no broken callers;
  `executeWithTools` correctly strips `stream` before delegating to
  `this.chat`.

Stop condition: **Pass at Round 4**. 327/327 tests pass (313 original
+ 14 regressions); `pnpm build` is clean on both packages. The
`/code-review` skill's 15-finding cap was not reached — 14 findings
survived verification, all fixed. Round 4 added 14 regression tests in
`tools.test.ts` (4), `manage-write.test.ts` (3), `sync.test.ts` (5),
`client.test.ts` (1), and `cli/test/index.test.ts` (2) so the
streaming tool-call bugs, manage-layer invariant violations, sync
gaps, depth-cap redaction leak, and CLI silent-no-op on
`--enabled`/`--disabled` cannot regress silently.


