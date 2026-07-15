import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { ChangePlan, LappProfile } from "./types.js";
import { isValidProviderId } from "./validate/constants.js";
import { profileRoot } from "./profile-location.js";

function files(profile: LappProfile): Map<string, unknown> {
  const result = new Map<string, unknown>();
  const root = profileRoot(profile);
  for (const provider of profile.providers) {
    if (!isValidProviderId(provider.config.id)) {
      throw new Error(`invalid provider id: ${provider.config.id}`);
    }
    const dir = path.resolve(root, "providers", provider.config.id);
    result.set(path.join(dir, "provider.json"), provider.config);
    result.set(path.join(dir, "models.json"), provider.models);
  }
  if (profile.global) result.set(path.resolve(root, "global.json"), profile.global);
  return result;
}

function fileMatches(target: string, value: unknown): boolean {
  try {
    return isDeepStrictEqual(JSON.parse(fs.readFileSync(target, "utf8")), value);
  } catch {
    return false;
  }
}

export function planChanges(before: LappProfile | null, after: LappProfile): ChangePlan {
  const previous = before ? files(before) : new Map<string, unknown>();
  const next = files(after);
  const changes: ChangePlan["changes"] = [];
  for (const [target, value] of next) {
    if (!fileMatches(target, value)) {
      changes.push({ kind: fs.existsSync(target) ? "modify" : "create", path: target });
    }
  }
  for (const target of previous.keys()) {
    if (!next.has(target) && fs.existsSync(target)) changes.push({ kind: "delete", path: target });
  }
  return { changes };
}
