import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { AuthError } from "../types.js";
import { resolveLappStateHome, type WriterLockOptions } from "../writer/lock.js";
import { isValidProviderId } from "../validate/constants.js";

export const AUTH_LOCK_RELATIVE_DIRECTORY = path.join("locks", "auth-v1");
const OWNER_FILE = "owner.json";

export interface AuthIdLockOptions extends WriterLockOptions {}

export function authIdLockPaths(authId: string, options: AuthIdLockOptions = {}): {
  stateHome: string;
  lockDirectory: string;
  ownerFile: string;
} {
  if (!isValidProviderId(authId)) throw new TypeError("invalid auth id");
  const stateHome = resolveLappStateHome(options.stateHome, options);
  const lockDirectory = path.join(stateHome, AUTH_LOCK_RELATIVE_DIRECTORY, `${authId}.lock`);
  return { stateHome, lockDirectory, ownerFile: path.join(lockDirectory, OWNER_FILE) };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** Serialize refresh-token rotation for one Auth source across SDK processes. */
export async function withAuthIdLock<T>(
  authId: string,
  work: () => Promise<T>,
  options: AuthIdLockOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const retryDelayMs = options.retryDelayMs ?? 25;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || !Number.isFinite(retryDelayMs) || retryDelayMs <= 0) {
    throw new TypeError("invalid auth lock timing options");
  }
  const { lockDirectory, ownerFile } = authIdLockPaths(authId, options);
  fs.mkdirSync(path.dirname(lockDirectory), { recursive: true });
  const token = randomUUID();
  const started = Date.now();
  while (true) {
    try {
      fs.mkdirSync(lockDirectory);
      try {
        const descriptor = fs.openSync(ownerFile, "wx", 0o600);
        try {
          fs.writeFileSync(descriptor, JSON.stringify({
            version: 1,
            authId,
            token,
            pid: process.pid,
            createdAt: new Date().toISOString(),
          }), "utf8");
          fs.fsyncSync(descriptor);
        } finally {
          fs.closeSync(descriptor);
        }
      } catch {
        try { fs.rmSync(ownerFile, { force: true }); } catch { /* best effort */ }
        try { fs.rmdirSync(lockDirectory); } catch { /* preserve invalid lock for inspection */ }
        throw new AuthError("AUTH_LOCK_INVALID", "auth lock owner record could not be created");
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() - started >= timeoutMs) {
        throw new AuthError("AUTH_LOCKED", `timed out waiting for auth lock: ${authId}`);
      }
      await delay(retryDelayMs);
    }
  }

  try {
    return await work();
  } finally {
    try {
      const raw = JSON.parse(fs.readFileSync(ownerFile, "utf8")) as { token?: unknown; authId?: unknown };
      const entries = fs.readdirSync(lockDirectory);
      if (raw.token !== token || raw.authId !== authId || entries.length !== 1 || entries[0] !== OWNER_FILE) {
        throw new Error("ownership changed");
      }
      fs.unlinkSync(ownerFile);
      fs.rmdirSync(lockDirectory);
    } catch {
      throw new AuthError("AUTH_LOCK_INVALID", "auth lock ownership changed before release");
    }
  }
}
