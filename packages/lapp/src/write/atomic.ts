import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { LappProfile } from "../types.js";
import { ProfileValidationError } from "../types.js";
import { validateProfile } from "../validate/index.js";
import { profileRoot } from "../profile-location.js";

export interface WriteOptions {
  path?: string;
  indent?: number;
  trailingNewline?: boolean;
  before?: LappProfile | null;
}

function sorted(value: unknown, ancestors = new WeakSet<object>()): unknown {
  if (value === null || typeof value !== "object") return value;
  if (ancestors.has(value)) throw new TypeError("profile contains a circular value");
  ancestors.add(value);
  const result = Array.isArray(value)
    ? value.map((entry) => sorted(entry, ancestors))
    : Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, entry]) => [key, sorted(entry, ancestors)]),
      );
  ancestors.delete(value);
  return result;
}

function stringify(value: unknown, indent: number, trailingNewline: boolean): string {
  const text = JSON.stringify(sorted(value), null, indent);
  return trailingNewline ? `${text}\n` : text;
}

function assertContained(root: string, target: string): string {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  const relative = path.relative(resolvedRoot, resolvedTarget);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`profile path escapes root: ${target}`);
  }
  let current = resolvedRoot;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      throw error;
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`profile path contains a symbolic link or junction: ${current}`);
    }
    if (current !== resolvedTarget && !stat.isDirectory()) {
      throw new Error(`profile path component is not a directory: ${current}`);
    }
  }
  return resolvedTarget;
}

function atomicWrite(root: string, target: string, value: unknown, content: string): void {
  let safeTarget = assertContained(root, target);
  let current: string | undefined;
  try {
    current = fs.readFileSync(safeTarget, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (current !== undefined) {
    try {
      if (stringify(JSON.parse(current), 0, false) === stringify(value, 0, false)) return;
    } catch {
      // Invalid on-disk JSON is replaced by the validated in-memory value.
    }
  }
  const dir = path.dirname(safeTarget);
  fs.mkdirSync(dir, { recursive: true });
  safeTarget = assertContained(root, safeTarget);
  const temporary = path.join(dir, `.${path.basename(safeTarget)}.${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(descriptor, content, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, assertContained(root, safeTarget));
  } catch (error) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch { /* preserve the primary error */ }
    }
    try { fs.rmSync(temporary, { force: true }); } catch { /* preserve the primary error */ }
    throw error;
  }
}

function profileFiles(profile: LappProfile, root: string): Map<string, unknown> {
  const files = new Map<string, unknown>();
  for (const provider of profile.providers) {
    const dir = path.join(root, "providers", provider.config.id);
    files.set(path.join(dir, "provider.json"), provider.config);
    files.set(path.join(dir, "models.json"), provider.models);
  }
  if (profile.global) files.set(path.join(root, "global.json"), profile.global);
  return files;
}

function removeFile(root: string, target: string): void {
  const safeTarget = assertContained(root, target);
  fs.rmSync(safeTarget, { force: true });
  const dir = path.dirname(safeTarget);
  if (path.basename(path.dirname(dir)) !== "providers") return;
  if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
}

interface FileSnapshot {
  target: string;
  content?: Buffer;
}

function snapshotFile(root: string, target: string): FileSnapshot {
  const safeTarget = assertContained(root, target);
  try {
    return { target: safeTarget, content: fs.readFileSync(safeTarget) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { target: safeTarget };
    throw error;
  }
}

function restoreSnapshot(root: string, snapshot: FileSnapshot): void {
  if (snapshot.content === undefined) {
    removeFile(root, snapshot.target);
    return;
  }
  let safeTarget = assertContained(root, snapshot.target);
  const dir = path.dirname(safeTarget);
  fs.mkdirSync(dir, { recursive: true });
  safeTarget = assertContained(root, safeTarget);
  const temporary = path.join(dir, `.${path.basename(safeTarget)}.${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(descriptor, snapshot.content);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, assertContained(root, safeTarget));
  } catch (error) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch { /* preserve the rollback error */ }
    }
    try { fs.rmSync(temporary, { force: true }); } catch { /* preserve the rollback error */ }
    throw error;
  }
}

export async function writeProfileAtomic(
  profile: LappProfile,
  options: WriteOptions = {},
): Promise<void> {
  const result = validateProfile(profile);
  if (!result.valid) throw new ProfileValidationError(result.diagnostics, "refusing to write invalid profile");
  const root = profileRoot(profile, options.path);
  const indent = options.indent ?? 2;
  const trailingNewline = options.trailingNewline ?? true;
  const nextFiles = profileFiles(profile, root);
  const beforeFiles = options.before ? profileFiles(options.before, root) : new Map<string, unknown>();
  const touched = new Set([...nextFiles.keys(), ...beforeFiles.keys()]);
  const snapshots = [...touched].map((target) => snapshotFile(root, target));
  try {
    for (const [target, value] of nextFiles) {
      atomicWrite(root, target, value, stringify(value, indent, trailingNewline));
    }
    for (const target of beforeFiles.keys()) {
      if (!nextFiles.has(target)) removeFile(root, target);
    }
  } catch (error) {
    let rollbackFailed = false;
    for (const snapshot of snapshots.reverse()) {
      try {
        restoreSnapshot(root, snapshot);
      } catch {
        rollbackFailed = true;
      }
    }
    if (rollbackFailed) {
      const failure = new Error("profile update failed and rollback could not restore the previous files");
      failure.name = "ProfileWriteRollbackError";
      throw failure;
    }
    throw error;
  }
}
