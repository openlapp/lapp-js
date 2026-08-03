import { computeProfileRevision } from "../manager/revision.js";
import {
  inspectWriterLock,
  type WriterLockOptions,
} from "./lock.js";

export interface StableReadOptions {
  /** Complete read attempts before failing. Defaults to and may not exceed 3. */
  attempts?: number;
  /** Skip lock checks only when the caller already owns the writer lock. */
  lockHeld?: boolean;
  /** Current-user writer lock location overrides. */
  lock?: WriterLockOptions;
}

export class ProfileReadUnstableError extends Error {
  override name = "ProfileReadUnstableError";
  readonly code = "PROFILE_READ_UNSTABLE" as const;

  constructor() {
    super("profile changed repeatedly while it was being read");
  }
}

/** Accept a multi-file read only when no writer intervened and both revisions match. */
export function readStable<T>(
  rootDir: string,
  read: () => T,
  options: StableReadOptions = {},
  computeRevision: (rootDir: string) => string = computeProfileRevision,
): { value: T; revision: string } {
  const attempts = options.attempts ?? 3;
  if (!Number.isSafeInteger(attempts) || attempts <= 0 || attempts > 3) {
    throw new TypeError("stable read attempts must be an integer from 1 through 3");
  }
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (!options.lockHeld) {
      const initialLock = inspectWriterLock(options.lock);
      if (initialLock.locked) continue;
    }
    const before = computeRevision(rootDir);
    try {
      const value = read();
      const after = computeRevision(rootDir);
      const writerAppeared = !options.lockHeld && inspectWriterLock(options.lock).locked;
      if (before === after && !writerAppeared) return { value, revision: after };
    } catch (error) {
      const unchanged = before === computeRevision(rootDir);
      const writerAppeared = !options.lockHeld && inspectWriterLock(options.lock).locked;
      if (unchanged && !writerAppeared) throw error;
    }
  }
  throw new ProfileReadUnstableError();
}
