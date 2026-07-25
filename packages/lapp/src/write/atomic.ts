import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { LappProfile } from "../types.js";
import { ProfileValidationError } from "../types.js";
import { validateProfile } from "../validate/index.js";
import { profileRoot } from "../profile-location.js";
import { parseIJson } from "../json/ijson.js";

export interface WriteOptions {
  path?: string;
  indent?: number;
  trailingNewline?: boolean;
  before?: LappProfile | null;
}

/** The attempted profile write failed and rollback could not restore every file. */
export class ProfileUpdatePartialFailureError extends Error {
  override name = "ProfileUpdatePartialFailureError";
  readonly code = "PROFILE_UPDATE_PARTIAL_FAILURE" as const;

  constructor(message = "profile update failed and rollback could not restore the previous files") {
    super(message);
  }
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

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
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
      if (isMissing(error)) break;
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

function relativeManagedPath(root: string, target: string): string {
  const safeTarget = assertContained(root, target);
  return path.relative(path.resolve(root), safeTarget).split(path.sep).join("/");
}

function compareManagedPaths(root: string, left: string, right: string): number {
  return Buffer.compare(
    Buffer.from(relativeManagedPath(root, left), "utf8"),
    Buffer.from(relativeManagedPath(root, right), "utf8"),
  );
}

function unsupportedDirectoryFlush(error: unknown): boolean {
  if (process.platform !== "win32") return false;
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EACCES"
    || code === "EISDIR"
    || code === "EINVAL"
    || code === "ENOTSUP"
    || code === "EPERM";
}

/** Flush a directory entry update where the current platform exposes that operation. */
function flushDirectory(directory: string): void {
  let descriptor: number;
  try {
    descriptor = fs.openSync(directory, "r");
  } catch (error) {
    if (unsupportedDirectoryFlush(error)) return;
    throw error;
  }
  try {
    fs.fsyncSync(descriptor);
  } catch (error) {
    try { fs.closeSync(descriptor); } catch { /* preserve the flush error */ }
    if (unsupportedDirectoryFlush(error)) return;
    throw error;
  }
  fs.closeSync(descriptor);
}

function flushParent(target: string): void {
  flushDirectory(path.dirname(target));
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

interface FileSnapshot {
  target: string;
  content?: Buffer;
}

function snapshotFile(root: string, target: string): FileSnapshot {
  const safeTarget = assertContained(root, target);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(safeTarget);
  } catch (error) {
    if (isMissing(error)) return { target: safeTarget };
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`managed profile path is not a regular file: ${safeTarget}`);
  }
  return { target: safeTarget, content: fs.readFileSync(safeTarget) };
}

function snapshotMatchesValue(snapshot: FileSnapshot, value: unknown): boolean {
  if (snapshot.content === undefined) return false;
  const parsed = parseIJson(snapshot.content);
  return parsed.ok && stringify(parsed.value, 0, false) === stringify(value, 0, false);
}

function assertSnapshotUnchanged(root: string, snapshot: FileSnapshot): void {
  const safeTarget = assertContained(root, snapshot.target);
  if (snapshot.content === undefined) {
    try {
      fs.lstatSync(safeTarget);
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
    throw new Error(`managed profile path appeared before commit: ${safeTarget}`);
  }
  const current = fs.readFileSync(safeTarget);
  if (!current.equals(snapshot.content)) {
    throw new Error(`managed profile path changed before commit: ${safeTarget}`);
  }
}

interface PlannedWrite {
  kind: "write";
  target: string;
  content: Buffer;
  before: FileSnapshot;
}

interface PlannedDelete {
  kind: "delete";
  target: string;
  before: FileSnapshot & { content: Buffer };
}

type PlannedFileAction = PlannedWrite | PlannedDelete;

type JournalEntry =
  | { kind: "temporary"; target: string }
  | { kind: "mkdir"; target: string }
  | { kind: "replace"; target: string; before: FileSnapshot; committed: Buffer }
  | { kind: "delete"; target: string; before: Buffer }
  | { kind: "rmdir"; target: string };

function directoryExists(root: string, directory: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolvedDirectory = path.resolve(directory);
  if (resolvedDirectory !== resolvedRoot) assertContained(root, resolvedDirectory);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(resolvedDirectory);
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
  if (resolvedDirectory === resolvedRoot && stat.isSymbolicLink()) {
    if (fs.statSync(resolvedDirectory).isDirectory()) return true;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`profile directory is not a safe directory: ${resolvedDirectory}`);
  }
  return true;
}

function requiredDirectories(root: string, writes: readonly PlannedWrite[]): string[] {
  const resolvedRoot = path.resolve(root);
  // `providers/` is the only required structural entry in an otherwise empty
  // Profile. Keep it present even when the profile has zero providers and no
  // JSON files to write, so a successful write is immediately loadable.
  const directories = new Set<string>([
    resolvedRoot,
    path.join(resolvedRoot, "providers"),
  ]);
  for (const write of writes) {
    let directory = path.dirname(write.target);
    while (true) {
      directories.add(directory);
      if (path.resolve(directory) === resolvedRoot) break;
      const parent = path.dirname(directory);
      if (parent === directory) throw new Error(`profile path escapes root: ${write.target}`);
      directory = parent;
    }
  }
  return [...directories].sort((left, right) => {
    if (path.resolve(left) === resolvedRoot) return path.resolve(right) === resolvedRoot ? 0 : -1;
    if (path.resolve(right) === resolvedRoot) return 1;
    return compareManagedPaths(root, left, right);
  });
}

function removedProviderDirectories(
  before: LappProfile | null | undefined,
  next: LappProfile,
  root: string,
): string[] {
  if (!before) return [];
  const retained = new Set(next.providers.map((provider) => provider.config.id));
  return before.providers
    .filter((provider) => !retained.has(provider.config.id))
    .map((provider) => path.join(root, "providers", provider.config.id))
    .sort((left, right) => compareManagedPaths(root, left, right));
}

const MANAGED_PROVIDER_FILE_NAMES = new Set(["provider.json", "models.json"]);

function assertProviderDirectoryHasOnlyManagedFiles(root: string, directory: string): void {
  const safeDirectory = assertContained(root, directory);
  const entries = fs.readdirSync(safeDirectory);
  if (entries.some((entry) => !MANAGED_PROVIDER_FILE_NAMES.has(entry))) {
    throw new Error(`provider directory contains unmanaged content and cannot be removed: ${safeDirectory}`);
  }
}

function writePlannedFile(
  root: string,
  action: PlannedWrite,
  journal: JournalEntry[],
): void {
  assertSnapshotUnchanged(root, action.before);
  const directory = path.dirname(action.target);
  const temporary = assertContained(
    root,
    path.join(directory, `.${path.basename(action.target)}.${randomUUID()}.tmp`),
  );
  let descriptor: number | undefined;
  descriptor = fs.openSync(temporary, "wx", 0o600);
  journal.push({ kind: "temporary", target: temporary });
  try {
    fs.writeFileSync(descriptor, action.content);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
  } catch (error) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch { /* preserve the primary error */ }
    }
    throw error;
  }
  fs.renameSync(temporary, assertContained(root, action.target));
  journal[journal.length - 1] = {
    kind: "replace",
    target: action.target,
    before: action.before,
    committed: action.content,
  };
  flushDirectory(directory);
}

function deletePlannedFile(root: string, action: PlannedDelete, journal: JournalEntry[]): void {
  assertSnapshotUnchanged(root, action.before);
  fs.unlinkSync(assertContained(root, action.target));
  journal.push({ kind: "delete", target: action.target, before: action.before.content });
  flushParent(action.target);
}

function removeTemporary(root: string, target: string): void {
  const safeTarget = assertContained(root, target);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(safeTarget);
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`temporary profile path changed before cleanup: ${safeTarget}`);
  }
  fs.unlinkSync(safeTarget);
  flushParent(safeTarget);
}

function writeExactBytes(root: string, target: string, content: Buffer): void {
  const safeTarget = assertContained(root, target);
  const directory = path.dirname(safeTarget);
  const temporary = assertContained(
    root,
    path.join(directory, `.${path.basename(safeTarget)}.${randomUUID()}.rollback.tmp`),
  );
  let descriptor: number | undefined;
  let temporaryCreated = false;
  try {
    descriptor = fs.openSync(temporary, "wx", 0o600);
    temporaryCreated = true;
    fs.writeFileSync(descriptor, content);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, assertContained(root, safeTarget));
    temporaryCreated = false;
    flushDirectory(directory);
  } catch (error) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch { /* preserve the rollback error */ }
    }
    if (temporaryCreated) {
      try {
        removeTemporary(root, temporary);
      } catch {
        throw new ProfileUpdatePartialFailureError();
      }
    }
    throw error;
  }
}

function assertCommittedBytes(root: string, target: string, committed: Buffer): void {
  const current = fs.readFileSync(assertContained(root, target));
  if (!current.equals(committed)) {
    throw new Error(`managed profile path changed before rollback: ${target}`);
  }
}

function restoreReplacement(root: string, entry: Extract<JournalEntry, { kind: "replace" }>): void {
  assertCommittedBytes(root, entry.target, entry.committed);
  if (entry.before.content !== undefined) {
    writeExactBytes(root, entry.target, entry.before.content);
    return;
  }
  fs.unlinkSync(assertContained(root, entry.target));
  flushParent(entry.target);
}

function restoreDeletion(root: string, target: string, before: Buffer): void {
  const safeTarget = assertContained(root, target);
  try {
    const stat = fs.lstatSync(safeTarget);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`managed profile path changed before rollback: ${safeTarget}`);
    }
    if (fs.readFileSync(safeTarget).equals(before)) return;
    throw new Error(`managed profile path changed before rollback: ${safeTarget}`);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  writeExactBytes(root, safeTarget, before);
}

function rollback(root: string, journal: readonly JournalEntry[]): boolean {
  let failed = false;
  for (const entry of [...journal].reverse()) {
    try {
      if (entry.kind === "temporary") {
        removeTemporary(root, entry.target);
      } else if (entry.kind === "replace") {
        restoreReplacement(root, entry);
      } else if (entry.kind === "delete") {
        restoreDeletion(root, entry.target, entry.before);
      } else if (entry.kind === "rmdir") {
        fs.mkdirSync(entry.target);
        flushParent(entry.target);
      } else {
        const resolvedRoot = path.resolve(root);
        const target = path.resolve(entry.target);
        if (target !== resolvedRoot) assertContained(root, target);
        let stat: fs.Stats;
        try {
          stat = fs.lstatSync(target);
        } catch (error) {
          if (isMissing(error)) continue;
          throw error;
        }
        if (!stat.isDirectory() || stat.isSymbolicLink() || fs.readdirSync(target).length !== 0) {
          throw new Error(`created profile directory could not be removed safely: ${target}`);
        }
        fs.rmdirSync(target);
        flushParent(target);
      }
    } catch {
      failed = true;
    }
  }
  return failed;
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
  const targets = [...new Set([...nextFiles.keys(), ...beforeFiles.keys()])]
    .sort((left, right) => compareManagedPaths(root, left, right));
  const actions: PlannedFileAction[] = [];

  // Complete all target inspection and exact-byte snapshots before the first side effect.
  for (const target of targets) {
    const before = snapshotFile(root, target);
    if (nextFiles.has(target)) {
      const value = nextFiles.get(target);
      if (!snapshotMatchesValue(before, value)) {
        actions.push({
          kind: "write",
          target: before.target,
          before,
          content: Buffer.from(stringify(value, indent, trailingNewline), "utf8"),
        });
      }
    } else if (before.content !== undefined) {
      actions.push({
        kind: "delete",
        target: before.target,
        before: { ...before, content: before.content },
      });
    }
  }

  const writes = actions.filter((action): action is PlannedWrite => action.kind === "write");
  const directoriesToCreate = requiredDirectories(root, writes)
    .filter((directory) => !directoryExists(root, directory));
  const directoriesToRemove = removedProviderDirectories(options.before, profile, root)
    .filter((directory) => directoryExists(root, directory));

  // Refuse the entire proposal before its first side effect when deleting a
  // provider would strand content that LAPP does not manage. A second check in
  // the commit phase below detects content introduced after this preflight.
  for (const directory of directoriesToRemove) {
    assertProviderDirectoryHasOnlyManagedFiles(root, directory);
  }
  const journal: JournalEntry[] = [];

  try {
    for (const directory of directoriesToCreate) {
      fs.mkdirSync(directory);
      journal.push({ kind: "mkdir", target: directory });
      flushParent(directory);
    }
    for (const action of actions) {
      if (action.kind === "write") writePlannedFile(root, action, journal);
      else deletePlannedFile(root, action, journal);
    }
    for (const directory of directoriesToRemove) {
      const safeDirectory = assertContained(root, directory);
      if (fs.readdirSync(safeDirectory).length !== 0) {
        throw new Error(`provider directory became non-empty during removal: ${safeDirectory}`);
      }
      fs.rmdirSync(safeDirectory);
      journal.push({ kind: "rmdir", target: safeDirectory });
      flushParent(safeDirectory);
    }
  } catch (error) {
    if (rollback(root, journal)) {
      throw new ProfileUpdatePartialFailureError();
    }
    throw error;
  }
}
