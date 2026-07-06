/**
 * Change planning: compute a file-level diff between two profiles so the CLI
 * can show what `writeProfileAtomic` would do before touching disk.
 */

import fs from "node:fs";
import path from "node:path";
import type { ChangePlan, LappProfile, LappProvider } from "./types.js";

/**
 * Return the per-file operations a single provider contributes: which files
 * to create/modify (present in `after`) and which to delete (present in
 * `before` but not in `after` — including the orphan case where a surviving
 * provider's `after` no longer has models.json).
 */
function providerFileChanges(
  root: string,
  provider: LappProvider,
  beforeProvider: LappProvider | null,
): { path: string; op: "upsert" | "delete" }[] {
  const dir = path.join(root, "providers", provider.config.__dirName ?? provider.config.id);
  const out: { path: string; op: "upsert" | "delete" }[] = [];
  // provider.json: always upserted in `after`.
  out.push({ path: path.join(dir, "provider.json"), op: "upsert" });
  // models.json: upserted when `after` has models; deleted when `before` had
  // models but `after` doesn't (orphan-on-emptied-list case).
  if (provider.models && provider.models.models.length > 0) {
    out.push({ path: path.join(dir, "models.json"), op: "upsert" });
  } else if (beforeProvider && beforeProvider.models && beforeProvider.models.models.length > 0) {
    out.push({ path: path.join(dir, "models.json"), op: "delete" });
  }
  return out;
}

function globalPath(root: string): string {
  return path.join(root, "global.json");
}

function manifestPath(root: string): string {
  return path.join(root, "manifest.json");
}

/**
 * Compare a "before" profile (or null for a fresh init) with an "after"
 * profile, and list the file-level create/modify/delete operations needed.
 *
 * Existing `.jsonc` files on disk are treated as `.json` targets for writes
 * (new files are always written as `.json` per the design); a `.jsonc` file
 * with no matching `.json` is reported as a `modify` against the `.json` path.
 */
export function planChanges(
  before: LappProfile | null,
  after: LappProfile,
): ChangePlan {
  const root = after.rootDir;
  const changes: ChangePlan["changes"] = [];
  const seen = new Set<string>();

  const exists = (p: string): boolean => {
    try {
      return fs.statSync(p).isFile();
    } catch {
      // `.json` may not exist but a `.jsonc` equivalent might.
      const jsonc = p.replace(/\.json$/, ".jsonc");
      try {
        return fs.statSync(jsonc).isFile();
      } catch {
        return false;
      }
    }
  };

  const add = (kind: "create" | "modify" | "delete", p: string) => {
    const norm = path.resolve(p);
    if (seen.has(norm)) return;
    seen.add(norm);
    changes.push({ kind, path: norm });
  };

  // Providers (after).
  for (const provider of after.providers) {
    const beforeProvider = before?.providers.find((p) => p.config.id === provider.config.id) ?? null;
    for (const entry of providerFileChanges(root, provider, beforeProvider)) {
      if (entry.op === "upsert") {
        add(exists(entry.path) ? "modify" : "create", entry.path);
      } else if (exists(entry.path)) {
        add("delete", entry.path);
      }
    }
  }

  // Providers removed (before only).
  if (before) {
    for (const oldProvider of before.providers) {
      const stillThere = after.providers.some(
        (p) => p.config.id === oldProvider.config.id,
      );
      if (!stillThere) {
        for (const entry of providerFileChanges(root, oldProvider, null)) {
          // Fully removed provider: every file in its `before` is a delete.
          if (entry.op === "delete" || entry.op === "upsert") {
            if (exists(entry.path)) add("delete", entry.path);
          }
        }
        // providerFileChanges omits models.json when oldProvider.models is
        // null (e.g. the on-disk models.json failed to parse at load). Check
        // the disk directly so the orphan models.json/.jsonc is queued for
        // deletion instead of leaking when the provider is removed.
        if (!oldProvider.models) {
          const dir = path.join(root, "providers", oldProvider.config.__dirName ?? oldProvider.config.id);
          const modelsPath = path.join(dir, "models.json");
          if (exists(modelsPath)) add("delete", modelsPath);
        }
      }
    }
  }

  // global.json — create/modify when present in `after`, delete when present
  // in `before` but removed in `after`.
  if (after.global) {
    add(exists(globalPath(root)) ? "modify" : "create", globalPath(root));
  } else if (before?.global && exists(globalPath(root))) {
    add("delete", globalPath(root));
  }

  // manifest.json — same rule as global.json.
  if (after.manifest) {
    add(exists(manifestPath(root)) ? "modify" : "create", manifestPath(root));
  } else if (before?.manifest && exists(manifestPath(root))) {
    add("delete", manifestPath(root));
  }

  return { changes };
}