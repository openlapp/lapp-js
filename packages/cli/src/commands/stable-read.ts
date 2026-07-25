import { readStable as readStableProfile } from "@openlapp/lapp";

/** CLI adapter over the SDK's normative multi-file stable-read primitive. */
export function readStable<T>(rootDir: string, read: () => T): { value: T; revision: string } {
  return readStableProfile(rootDir, read);
}
