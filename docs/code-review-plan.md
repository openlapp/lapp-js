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

