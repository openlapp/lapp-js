/**
 * Atomic profile writer.
 *
 * Implements the atomic write rule from `docs/sdk-cli-design.md` §3:
 *   1. Build complete content in memory.
 *   2. Validate before writing.
 *   3. Write to a hidden temporary file in the same directory as the target.
 *   4. Close the temporary file.
 *   5. Rename it over the target path.
 *   6. On failure, best-effort remove only the temporary file.
 *
 * No temp directory, no backups, no rollback. New files are written as `.json`.
 */

import fs from "node:fs";
import path from "node:path";
import { validateProfile } from "../validate/index.js";
import type { LappProfile, LappProvider } from "../types.js";
import { planChanges } from "../plan.js";

export interface WriteOptions {
  /** Skip pre-write validation. Not recommended. */
  skipValidate?: boolean;
  /** Pretty-print indent (default 2). */
  indent?: number;
  /** Append a trailing newline (default true). */
  trailingNewline?: boolean;
  /**
   * The on-disk profile state BEFORE the edit. When provided, files that
   * exist in `before` but no longer appear in `after` are unlinked, so the
   * remove flow doesn't leave orphan provider.json / models.json behind.
   * Skips silently if null/undefined.
   */
  before?: LappProfile | null;
}

function stableStringify(value: unknown, indent: number, trailingNewline: boolean): string {
  // JSON.stringify with a replacer that sorts object keys for deterministic output.
  // Cycle detection is path-aware: the `ancestors` Set tracks objects on the current
  // traversal path. A shared (non-circular) reference under a sibling is NOT
  // considered circular — we only flag a back-edge to an object already on the
  // path. This avoids emitting the literal string "[Circular]" for legitimately
  // shared sub-objects (e.g. two model entries referencing the same capabilities
  // array).
  const ancestors = new WeakSet<object>();
  const sort = (v: unknown): unknown => {
    if (v === null || typeof v !== "object") return v;
    if (Array.isArray(v)) {
      if (ancestors.has(v)) return "[Circular]";
      ancestors.add(v);
      const out = v.map(sort);
      ancestors.delete(v);
      return out;
    }
    if (ancestors.has(v as object)) return "[Circular]";
    ancestors.add(v as object);
    const obj = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      // Skip internal bookkeeping fields (prefixed with __).
      if (key.startsWith("__")) continue;
      out[key] = sort(obj[key]);
    }
    ancestors.delete(v as object);
    return out;
  };
  const text = JSON.stringify(sort(value), null, indent);
  return trailingNewline ? `${text}\n` : text;
}

let atomicCounter = 0;
function randomSuffix(): string {
  // 6-byte random suffix in base36. crypto is available in Node 18+;
  // we avoid requiring the async API for a sync writer.
  return Math.floor(Math.random() * 0xffffffff).toString(36);
}

function atomicWriteFile(target: string, content: string): void {
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });
  // The temp filename must be unique even across concurrent writes in the
  // same process (e.g. Promise.all([writeProfileAtomic(a), writeProfileAtomic(b)]))
  // — using only process.pid lets two writes in the same process clobber each
  // other's temp file. Include a counter + a random suffix to make the path
  // distinct per call.
  const tmp = path.join(
    dir,
    `.${path.basename(target)}.${process.pid}.${atomicCounter++}.${randomSuffix()}.tmp`,
  );
  let fd: number | undefined;
  try {
    fd = fs.openSync(tmp, "w", 0o600);
    fs.writeFileSync(fd, content, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, target);
  } catch (err) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    throw err;
  }
  // If a legacy .jsonc with the same base name is being replaced by .json,
  // remove it AFTER the rename succeeded. Removing it before would violate
  // the atomic-write contract: a failure in openSync/writeSync/fsync/rename
  // would otherwise leave the base name with no config file on disk.
  if (target.endsWith(".json")) {
    const legacy = target.replace(/\.json$/, ".jsonc");
    if (legacy !== target) {
      try { fs.rmSync(legacy, { force: true }); } catch { /* ignore */ }
    }
  }
}

function providerRelativePath(provider: LappProvider): { providerPath: string; modelsPath: string | null } {
  const dirName = provider.config.__dirName ?? provider.config.id;
  return {
    providerPath: path.join("providers", dirName, "provider.json"),
    modelsPath:
      provider.models && provider.models.models.length > 0
        ? path.join("providers", dirName, "models.json")
        : null,
  };
}

/**
 * Validate (if not skipped) and atomically write all profile files.
 * Throws on validation failure or write error; on write error only the temp
 * file for the failing file is removed (already-written files stay).
 *
 * If `options.before` is provided, files marked for `delete` in the plan
 * (removed providers' provider.json / models.json) are unlinked AFTER the
 * writes succeed. Deletes are best-effort: a failed unlink does not roll
 * back already-written files, but it also does not throw.
 */
export async function writeProfileAtomic(
  profile: LappProfile,
  options: WriteOptions = {},
): Promise<void> {
  if (!options.skipValidate) {
    const result = validateProfile(profile);
    if (!result.valid) {
      const msgs = result.diagnostics
        .filter((d) => d.level === "ERROR")
        .map((d) => `${d.location ? `${d.location}: ` : ""}${d.message}`)
        .join("\n");
      throw new Error(`refusing to write invalid profile:\n${msgs}`);
    }
  }

  const indent = options.indent ?? 2;
  const trailingNewline = options.trailingNewline ?? true;
  const root = profile.rootDir;

  // Provider files.
  for (const provider of profile.providers) {
    const { providerPath, modelsPath } = providerRelativePath(provider);
    const configCopy = { ...provider.config };
    // Strip internal fields from written JSON (also handled in stableStringify).
    for (const key of Object.keys(configCopy)) {
      if (key.startsWith("__")) delete (configCopy as Record<string, unknown>)[key];
    }
    atomicWriteFile(path.join(root, providerPath), stableStringify(configCopy, indent, trailingNewline));

    if (modelsPath && provider.models) {
      atomicWriteFile(path.join(root, modelsPath), stableStringify(provider.models, indent, trailingNewline));
    }
  }

  // global.json
  if (profile.global) {
    atomicWriteFile(path.join(root, "global.json"), stableStringify(profile.global, indent, trailingNewline));
  }

  // manifest.json
  if (profile.manifest) {
    atomicWriteFile(path.join(root, "manifest.json"), stableStringify(profile.manifest, indent, trailingNewline));
  }

  // Removes: only run after all writes succeed, so a write failure doesn't
  // strand the on-disk state. Best-effort: a failed unlink is logged via the
  // thrown error (rethrow as Error for visibility), but we still report the
  // primary write success.
  if (options.before) {
    const plan = planChanges(options.before, profile);
    for (const change of plan.changes) {
      if (change.kind !== "delete") continue;
      // Unlink both .json and any legacy .jsonc with the same base name.
      const candidates = [change.path];
      if (change.path.endsWith(".json")) {
        candidates.push(change.path.replace(/\.json$/, ".jsonc"));
      }
      for (const p of candidates) {
        try {
          fs.rmSync(p, { force: true });
        } catch {
          /* best-effort: a write-failure here is acceptable */
        }
      }
      // Remove the now-empty provider directory (best-effort).
      const dir = path.dirname(change.path);
      if (dir.includes(`${path.sep}providers${path.sep}`)) {
        try {
          const remaining = fs.readdirSync(dir);
          if (remaining.length === 0) fs.rmdirSync(dir);
        } catch {
          /* ignore */
        }
      }
    }
  }
}