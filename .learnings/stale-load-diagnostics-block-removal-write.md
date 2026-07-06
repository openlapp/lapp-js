---
name: stale-load-diagnostics-block-removal-write
description: Removing a provider whose on-disk models.json failed to parse makes writeProfileAtomic refuse the write, because the load-time ERROR diagnostic is carried into the after-profile.
date: 2026-07-05
tags: [lapp-js, write, validate, bug]
---

When `loadProfile` encounters a malformed `models.json`, `loadProvider` emits
an ERROR diagnostic and sets `provider.models = null`, but keeps the provider
in `profile.providers`. If the user then removes that provider
(`removeProvider(before, id)`), the resulting `after` profile still carries the
ERROR in `after.diagnostics` (cloned by `removeProvider`). `writeProfileAtomic`
re-validates `after` and **refuses to write** ("refusing to write invalid
profile"), so the orphan `models.json` can never be deleted — the cleanup flow
is blocked by the very diagnostic describing the file we want to remove.

**Why it bites:** the diagnostic describes a file that no longer exists in the
`after` profile; it is stale but still blocks the atomic write that would
delete the offending file on disk.

**How to apply:** when testing or implementing "remove a broken provider",
either (a) clear `next.diagnostics` before `writeProfileAtomic`, or (b) pass
`skipValidate: true` for the cleanup write, or (c) the SDK should re-derive
diagnostics from `after` rather than carrying them from `before`. This is a
residual from the round-1 review of lapp-js (`docs/code-review-plan.md`), not
yet fixed in the SDK.
