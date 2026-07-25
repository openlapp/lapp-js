import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseIJson, type IJsonFindingCode } from "../json/ijson.js";

export const LAPP_STATE_HOME_ENV = "LAPP_STATE_HOME";
export const WRITER_LOCK_RELATIVE_PATH = path.join("locks", "writer-v1.lock");
export const WRITER_LOCK_OWNER_FILE = "owner.json";

const MAX_SAFE_INTEGER = 9_007_199_254_740_991;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RFC3339_UTC = /^(?!0000)([0-9]{4})-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\.[0-9]+)?Z$/;

export interface WriterLockOwner {
  version: 1;
  token: string;
  pid: number;
  createdAt: string;
}

export interface WriterLockOptions {
  /** Explicit state home. Takes precedence over `LAPP_STATE_HOME`. */
  stateHome?: string;
  /** Maximum acquisition wait. Defaults to 5 seconds. */
  timeoutMs?: number;
  /** Delay between acquisition attempts. Defaults to 25 milliseconds. */
  retryDelayMs?: number;
  /** Environment override for tests and embedding. */
  env?: NodeJS.ProcessEnv;
  /** Platform override for tests. */
  platform?: NodeJS.Platform;
  /** Home-directory override for tests. */
  homeDir?: string;
}

export interface WriterLockInspection {
  locked: boolean;
  lockDirectory: string;
  ownerFile: string;
  owner?: WriterLockOwner;
  ownerValid: boolean;
}

export type WriterLockOwnerValidationCode =
  | IJsonFindingCode
  | "SCHEMA_WRITER_LOCK"
  | "WRITER_LOCK_TIMESTAMP_INVALID";

export type WriterLockOwnerValidation =
  | { ok: true; owner: WriterLockOwner }
  | { ok: false; code: WriterLockOwnerValidationCode };

export class ProfileLockedError extends Error {
  override name = "ProfileLockedError";
  readonly code = "PROFILE_LOCKED" as const;

  constructor(readonly owner?: WriterLockOwner) {
    super("timed out waiting for the current-user LAPP writer lock");
  }
}

export class ProfileLockInvalidError extends Error {
  override name = "ProfileLockInvalidError";
  readonly code = "PROFILE_LOCK_INVALID" as const;

  constructor(message = "the current-user LAPP writer lock is invalid") {
    super(message);
  }
}

function nonEmpty(value: string | undefined): string | undefined {
  return value?.trim() ? value : undefined;
}

/** Resolve state shared by all LAPP roots for the current operating-system user. */
export function resolveLappStateHome(
  explicit?: string,
  options: Pick<WriterLockOptions, "env" | "platform" | "homeDir"> = {},
): string {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const configured = nonEmpty(explicit) ?? nonEmpty(env[LAPP_STATE_HOME_ENV]);
  if (configured) return path.resolve(configured);

  const home = nonEmpty(options.homeDir) ?? nonEmpty(env.HOME) ?? os.homedir();
  if (platform === "win32") {
    const localAppData = nonEmpty(env.LOCALAPPDATA);
    if (!localAppData) {
      throw new Error("LOCALAPPDATA is required when LAPP_STATE_HOME is not set on Windows");
    }
    return path.resolve(localAppData, "OpenLAPP");
  }
  if (platform === "darwin") {
    return path.resolve(home, "Library", "Application Support", "OpenLAPP");
  }
  const xdgStateHome = nonEmpty(env.XDG_STATE_HOME);
  return xdgStateHome
    ? path.resolve(xdgStateHome, "openlapp")
    : path.resolve(home, ".local", "state", "openlapp");
}

export function writerLockPaths(options: WriterLockOptions = {}): {
  stateHome: string;
  lockDirectory: string;
  ownerFile: string;
} {
  const stateHome = resolveLappStateHome(options.stateHome, options);
  const lockDirectory = path.join(stateHome, WRITER_LOCK_RELATIVE_PATH);
  return {
    stateHome,
    lockDirectory,
    ownerFile: path.join(lockDirectory, WRITER_LOCK_OWNER_FILE),
  };
}

function hasWriterLockSchema(value: unknown): value is WriterLockOwner {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const owner = value as Record<string, unknown>;
  if (Object.keys(owner).sort().join("\0") !== "createdAt\0pid\0token\0version") return false;
  return owner.version === 1
    && typeof owner.token === "string"
    && UUID.test(owner.token)
    && typeof owner.pid === "number"
    && Number.isSafeInteger(owner.pid)
    && owner.pid >= 0
    && owner.pid <= MAX_SAFE_INTEGER
    && typeof owner.createdAt === "string"
    && RFC3339_UTC.test(owner.createdAt);
}

function isValidUtcTimestamp(value: string): boolean {
  const match = RFC3339_UTC.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= days[month - 1]!;
}

/** Validate raw owner bytes with the exact canonical conformance identity. */
export function validateWriterLockOwner(bytes: Uint8Array): WriterLockOwnerValidation {
  const parsed = parseIJson(bytes);
  if (!parsed.ok) {
    return { ok: false, code: parsed.findings[0]?.code ?? "INVALID_JSON" };
  }
  if (!hasWriterLockSchema(parsed.value)) {
    return { ok: false, code: "SCHEMA_WRITER_LOCK" };
  }
  if (!isValidUtcTimestamp(parsed.value.createdAt)) {
    return { ok: false, code: "WRITER_LOCK_TIMESTAMP_INVALID" };
  }
  return { ok: true, owner: parsed.value };
}

function readOwner(ownerFile: string): WriterLockOwner | undefined {
  try {
    const stat = fs.lstatSync(ownerFile);
    if (!stat.isFile() || stat.isSymbolicLink()) return undefined;
    const parsed = validateWriterLockOwner(fs.readFileSync(ownerFile));
    return parsed.ok ? parsed.owner : undefined;
  } catch {
    return undefined;
  }
}

function safeLockDirectory(lockDirectory: string): boolean {
  try {
    const stat = fs.lstatSync(lockDirectory);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

export function inspectWriterLock(options: WriterLockOptions = {}): WriterLockInspection {
  const { lockDirectory, ownerFile } = writerLockPaths(options);
  let locked = false;
  try {
    fs.lstatSync(lockDirectory);
    locked = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const owner = locked && safeLockDirectory(lockDirectory) ? readOwner(ownerFile) : undefined;
  return {
    locked,
    lockDirectory,
    ownerFile,
    ...(owner ? { owner } : {}),
    ownerValid: Boolean(owner),
  };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function cleanupFailedAcquisition(lockDirectory: string, token: string): void {
  const failedDirectory = `${lockDirectory}.failed-${token}`;
  try {
    fs.renameSync(lockDirectory, failedDirectory);
  } catch {
    throw new ProfileLockInvalidError("failed writer-lock acquisition could not be renamed safely");
  }
  try {
    const entries = fs.readdirSync(failedDirectory);
    if (entries.length === 0) {
      fs.rmdirSync(failedDirectory);
      return;
    }
    const movedOwnerFile = path.join(failedDirectory, WRITER_LOCK_OWNER_FILE);
    if (entries.length !== 1 || entries[0] !== WRITER_LOCK_OWNER_FILE
      || readOwner(movedOwnerFile)?.token !== token) {
      throw new ProfileLockInvalidError("failed writer-lock acquisition no longer has provable ownership");
    }
    fs.rmSync(movedOwnerFile, { force: false });
    fs.rmdirSync(failedDirectory);
  } catch {
    try {
      fs.renameSync(failedDirectory, lockDirectory);
    } catch {
      // Preserve the owner-specific path when the canonical lock cannot be restored.
    }
    throw new ProfileLockInvalidError("failed writer-lock acquisition could not be cleaned up safely");
  }
}

function removeExactOwnedLock(directory: string, token: string): void {
  const entries = fs.readdirSync(directory);
  const ownerFile = path.join(directory, WRITER_LOCK_OWNER_FILE);
  if (entries.length !== 1 || entries[0] !== WRITER_LOCK_OWNER_FILE
    || readOwner(ownerFile)?.token !== token) {
    throw new ProfileLockInvalidError("writer lock directory contains unexpected or invalid entries");
  }
  fs.rmSync(ownerFile, { force: false });
  fs.rmdirSync(directory);
}

function removeOwnedLock(lockDirectory: string, ownerFile: string, token: string): void {
  if (!safeLockDirectory(lockDirectory) || readOwner(ownerFile)?.token !== token) {
    throw new ProfileLockInvalidError("writer lock ownership changed before release");
  }
  const releasedDirectory = `${lockDirectory}.released-${token}`;
  try {
    fs.renameSync(lockDirectory, releasedDirectory);
  } catch {
    throw new ProfileLockInvalidError("writer lock could not be renamed safely for release");
  }
  if (readOwner(path.join(releasedDirectory, WRITER_LOCK_OWNER_FILE))?.token !== token) {
    try {
      fs.renameSync(releasedDirectory, lockDirectory);
    } catch {
      // Preserve the renamed directory for explicit repair if ownership changed.
    }
    throw new ProfileLockInvalidError("writer lock ownership changed during release");
  }
  try {
    removeExactOwnedLock(releasedDirectory, token);
  } catch {
    try {
      fs.renameSync(releasedDirectory, lockDirectory);
    } catch {
      // Preserve whichever ownership-safe path remains for explicit recovery.
    }
    throw new ProfileLockInvalidError("writer lock could not be removed safely after release");
  }
}

/**
 * Serialize every official Profile + Vault writer for the current OS user.
 * Locks are never stolen using age, PID liveness, or a heartbeat.
 */
export async function withWriterLock<T>(
  work: () => Promise<T>,
  options: WriterLockOptions = {},
): Promise<T> {
  const { stateHome, lockDirectory, ownerFile } = writerLockPaths(options);
  const timeoutMs = options.timeoutMs ?? 5_000;
  const retryDelayMs = options.retryDelayMs ?? 25;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || !Number.isFinite(retryDelayMs) || retryDelayMs <= 0) {
    throw new TypeError("invalid writer lock timing options");
  }

  fs.mkdirSync(path.join(stateHome, "locks"), { recursive: true });
  const owner: WriterLockOwner = {
    version: 1,
    token: randomUUID(),
    pid: process.pid,
    createdAt: new Date().toISOString(),
  };
  const started = Date.now();
  while (true) {
    try {
      fs.mkdirSync(lockDirectory);
      let ownerDescriptor: number | undefined;
      try {
        ownerDescriptor = fs.openSync(ownerFile, "wx", 0o600);
        fs.writeFileSync(ownerDescriptor, JSON.stringify(owner), "utf8");
        fs.fsyncSync(ownerDescriptor);
        fs.closeSync(ownerDescriptor);
        ownerDescriptor = undefined;
      } catch {
        if (ownerDescriptor !== undefined) {
          try { fs.closeSync(ownerDescriptor); } catch { /* preserve the primary error */ }
        }
        cleanupFailedAcquisition(lockDirectory, owner.token);
        throw new ProfileLockInvalidError("writer lock owner record could not be created and flushed");
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() - started >= timeoutMs) {
        throw new ProfileLockedError(inspectWriterLock(options).owner);
      }
      await delay(retryDelayMs);
    }
  }

  try {
    return await work();
  } finally {
    removeOwnedLock(lockDirectory, ownerFile, owner.token);
  }
}

/**
 * Remove a lock only after an operator supplied the exact observed owner token.
 * This function never infers staleness from age, heartbeat, or PID liveness.
 */
export function repairWriterLock(
  expectedToken: string,
  options: WriterLockOptions = {},
): WriterLockOwner {
  if (!UUID.test(expectedToken)) {
    throw new ProfileLockInvalidError("an exact lowercase UUID owner token is required");
  }
  const { lockDirectory, ownerFile } = writerLockPaths(options);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(lockDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ProfileLockInvalidError("the writer lock does not exist");
    }
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new ProfileLockInvalidError("the writer lock path is not a safe directory");
  }
  const observed = readOwner(ownerFile);
  if (!observed) {
    throw new ProfileLockInvalidError("the writer lock owner record is invalid");
  }
  if (observed.token !== expectedToken) {
    throw new ProfileLockInvalidError("the writer lock owner changed; inspect it again");
  }

  const repairedDirectory = `${lockDirectory}.repaired-${randomUUID()}`;
  try {
    fs.renameSync(lockDirectory, repairedDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ProfileLockInvalidError("the writer lock changed during repair");
    }
    throw new ProfileLockInvalidError("the writer lock could not be renamed safely for repair");
  }
  const movedOwner = readOwner(path.join(repairedDirectory, WRITER_LOCK_OWNER_FILE));
  if (movedOwner?.token !== expectedToken) {
    try {
      fs.renameSync(repairedDirectory, lockDirectory);
    } catch {
      // Preserve the renamed directory; never delete ownership we did not verify.
    }
    throw new ProfileLockInvalidError("the writer lock owner changed during repair");
  }
  try {
    removeExactOwnedLock(repairedDirectory, expectedToken);
  } catch {
    try {
      fs.renameSync(repairedDirectory, lockDirectory);
    } catch {
      // Preserve whichever ownership-safe path remains for explicit recovery.
    }
    throw new ProfileLockInvalidError("the writer lock could not be removed safely during repair");
  }
  return observed;
}
