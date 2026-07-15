import path from "node:path";
import type { LappProfile } from "./types.js";

const profileRoots = new WeakMap<LappProfile, string>();

export function attachProfileRoot(profile: LappProfile, root: string): LappProfile {
  profileRoots.set(profile, path.resolve(root));
  return profile;
}

export function copyProfileRoot(source: LappProfile, target: LappProfile): LappProfile {
  const root = profileRoots.get(source);
  if (root) profileRoots.set(target, root);
  return target;
}

export function profileRoot(profile: LappProfile, explicit?: string): string {
  const root = explicit ? path.resolve(explicit) : profileRoots.get(profile);
  if (!root) {
    throw new Error("profile has no associated path; pass a path when creating or writing it");
  }
  return root;
}
