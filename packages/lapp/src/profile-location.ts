import path from "node:path";
import type { LappProfile, LappProvider } from "./types.js";

const profileRoots = new WeakMap<LappProfile, string>();
const providerDirectories = new WeakMap<LappProvider, string>();

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

/** Preserve the actual source directory for canonical diagnostics. */
export function attachProviderDirectory(provider: LappProvider, directory: string): LappProvider {
  providerDirectories.set(provider, directory);
  return provider;
}

export function providerDirectory(provider: LappProvider): string {
  return providerDirectories.get(provider) ?? provider.config.id;
}
