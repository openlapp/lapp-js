/**
 * Diff provider-fetched models against the existing models.json entries.
 */

import type { ModelEntry } from "../types.js";
import type { ModelSyncResult } from "./types.js";

function arraysEqual(a: string[] | undefined, b: string[] | undefined): boolean {
  // The `a === b` guard handles the "both undefined" case (one object
  // literal `[]` would never equal another `[]` by reference, but we never
  // // pass literal arrays here — fields are absent, not empty). The `!a ||
  // // !b` guard handles "exactly one is undefined". This pattern was
  // // originally flagged in code review as potentially misbehaving on
  // // `JSON.stringify(undefined)` producing the string `"undefined"`, but
  // // that concern is moot: we never stringify here.
  if (a === b) return true;               // both undefined or same reference
  if (!a || !b) return false;              // one is undefined/nully, other is not
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  for (let i = 0; i < sa.length; i++) {
    if (sa[i] !== sb[i]) return false;
  }
  return true;
}

function sameEntry(a: ModelEntry, b: ModelEntry): boolean {
  // Compare fields the sync owns. User-curated fields (aliases, enabled,
  // links, metadata) are intentionally ignored so manual tweaks survive.
  if (a.name !== b.name) return false;
  if (a.type !== b.type) return false;
  if (a.contextWindow !== b.contextWindow) return false;
  if (a.maxOutputTokens !== b.maxOutputTokens) return false;
  if (!arraysEqual(a.capabilities, b.capabilities)) return false;
  if (!arraysEqual(a.inputModalities, b.inputModalities)) return false;
  if (!arraysEqual(a.outputModalities, b.outputModalities)) return false;
  return true;
}

export function diffModels(
  before: ModelEntry[],
  fetched: ModelEntry[],
): Pick<ModelSyncResult, "added" | "removed" | "updated"> {
  const beforeById = new Map(before.map((m) => [m.id, m]));
  const fetchedById = new Map(fetched.map((m) => [m.id, m]));

  const added: ModelEntry[] = [];
  const removed: ModelEntry[] = [];
  const updated: ModelEntry[] = [];

  for (const [id, existing] of beforeById) {
    if (!fetchedById.has(id)) {
      removed.push(existing);
    }
  }

  for (const [id, fresh] of fetchedById) {
    const existing = beforeById.get(id);
    if (!existing) {
      added.push(fresh);
    } else if (!sameEntry(existing, fresh)) {
      updated.push(fresh);
    }
  }

  return { added, removed, updated };
}
