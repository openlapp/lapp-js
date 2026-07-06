/**
 * Profile mutation APIs (pure / immutable).
 *
 * These return new `LappProfile` objects; they do not touch disk. The CLI
 * writes via `writeProfileAtomic`. Inputs are validated by the caller (or by
 * `writeProfileAtomic` before touching disk).
 *
 * Inputs are intentionally generic objects so the CLI can pass through flags
 * without importing the full config types.
 */

import type {
  LappProfile,
  LappProvider,
  ModelEntry,
  ModelsConfig,
  ProviderConfig,
} from "../types.js";
import { MODEL_REF_KEYS } from "../validate/constants.js";
import { UnsupportedProtocolError } from "../types.js";

export interface CreateProfileInput {
  rootDir: string;
  manifest?: boolean;
  global?: boolean;
}

export interface ProviderInput {
  id: string;
  protocol: string;
  baseUrl: string;
  name?: string;
  enabled?: boolean;
  auth?: ProviderConfig["auth"];
  requestHeaders?: Record<string, string>;
  links?: ProviderConfig["links"];
  /** Optional initial models list. */
  models?: ModelEntry[];
}

export interface ModelInput {
  providerId: string;
  id: string;
  name?: string;
  aliases?: string[];
  type?: string;
  source?: "provider" | "manual";
  capabilities?: string[];
  inputModalities?: string[];
  outputModalities?: string[];
  contextWindow?: number;
  maxOutputTokens?: number;
  enabled?: boolean;
  protocol?: string;
}

export interface ModelTarget {
  providerId: string;
  /** Real model ID or alias. */
  model: string;
}

function clone(profile: LappProfile): LappProfile {
  return {
    rootDir: profile.rootDir,
    manifest: profile.manifest ? structuredClone(profile.manifest) : undefined,
    global: profile.global ? structuredClone(profile.global) : undefined,
    providers: profile.providers.map((p) => ({
      dir: p.dir,
      config: structuredClone(p.config) as ProviderConfig,
      models: p.models ? structuredClone(p.models) : null,
    })),
    diagnostics: profile.diagnostics.map((d) => ({ ...d })),
  };
}

function providerDirName(id: string): string {
  // Provider id should match directory; sanitize minimally by forbidding path
  // separators and Windows device-reserved names (CON, PRN, AUX, NUL, COM1-9,
  // LPT1-9) which would either fail to write or write to the device on
  // Windows. The validator warns when id !== dirName; we keep them equal.
  const safe = id.replace(/[\\/:]+/g, "-");
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(safe)) {
    return `${safe}-profile`;
  }
  return safe;
}

/**
 * Create an empty profile structure. Does NOT write to disk; pair with
 * `writeProfileAtomic`.
 */
export function createProfile(input: CreateProfileInput): LappProfile {
  return {
    rootDir: input.rootDir,
    manifest: input.manifest ? { schemaVersion: "1.0" } : undefined,
    global: input.global ? { schemaVersion: "1.0" } : undefined,
    providers: [],
    diagnostics: [],
  };
}

/** Insert or update a provider (by id). Returns a new profile. */
export function upsertProvider(profile: LappProfile, input: ProviderInput): LappProfile {
  const next = clone(profile);
  const dirName = providerDirName(input.id);
  const dir = `${next.rootDir}/providers/${dirName}`.replace(/\\/g, "/");
  const idx = next.providers.findIndex((p) => p.config.id === input.id);
  const existing = idx >= 0 ? next.providers[idx]! : null;
  // On update, start from the existing config and overlay only the fields the
  // caller actually supplied, so fields like name/auth/requestHeaders/links
  // survive a `lapp provider set` that only changes baseUrl. On create, build
  // a fresh config from input (with the same field semantics).
  const config: ProviderConfig = {
    ...(existing?.config ?? {}),
    schemaVersion: "1.0",
    id: input.id,
    protocol: input.protocol,
    baseUrl: input.baseUrl,
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
    ...(input.auth !== undefined ? { auth: input.auth } : {}),
    ...(input.requestHeaders !== undefined ? { requestHeaders: input.requestHeaders } : {}),
    ...(input.links !== undefined ? { links: input.links } : {}),
    __dirName: dirName,
  };

  const models: ModelsConfig | null = input.models && input.models.length > 0
    ? { schemaVersion: "1.0", models: input.models }
    : null;

  if (idx >= 0) {
    next.providers[idx] = { config, models: models ?? next.providers[idx]!.models, dir };
  } else {
    next.providers.push({ config, models, dir });
  }
  return next;
}

/** Remove a provider by id. No-op if not found. */
export function removeProvider(profile: LappProfile, providerId: string): LappProfile {
  const next = clone(profile);
  next.providers = next.providers.filter((p) => p.config.id !== providerId);
  if (next.global) {
    for (const key of MODEL_REF_KEYS) {
      const ref = next.global[key];
      if (ref && ref.providerId === providerId) {
        delete next.global[key];
      }
    }
  }
  return next;
}

/** Insert or update a model under a provider (by id). Returns a new profile. */
export function upsertModel(profile: LappProfile, input: ModelInput): LappProfile {
  const next = clone(profile);
  const provider = next.providers.find((p) => p.config.id === input.providerId);
  if (!provider) {
    throw new Error(`provider not found: ${input.providerId}`);
  }
  const models: ModelsConfig = provider.models ?? { schemaVersion: "1.0", models: [] };
  const idx = models.models.findIndex((m) => m.id === input.id);
  const existingEntry = idx >= 0 ? models.models[idx]! : null;
  // On update, start from the existing entry and overlay only the fields the
  // caller supplied, so fields like aliases/capabilities/modalities/protocol
  // survive a `lapp model set` that only changes --type.
  const entry: ModelEntry = {
    ...(existingEntry ?? {}),
    id: input.id,
    source: input.source ?? existingEntry?.source ?? "manual",
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.aliases !== undefined ? { aliases: input.aliases } : {}),
    ...(input.type !== undefined ? { type: input.type } : {}),
    ...(input.capabilities !== undefined ? { capabilities: input.capabilities } : {}),
    ...(input.inputModalities !== undefined ? { inputModalities: input.inputModalities } : {}),
    ...(input.outputModalities !== undefined ? { outputModalities: input.outputModalities } : {}),
    ...(typeof input.contextWindow === "number" ? { contextWindow: input.contextWindow } : {}),
    ...(typeof input.maxOutputTokens === "number" ? { maxOutputTokens: input.maxOutputTokens } : {}),
    ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
    ...(input.protocol !== undefined ? { protocol: input.protocol } : {}),
  };
  if (idx >= 0) {
    models.models[idx] = entry;
  } else {
    models.models.push(entry);
  }
  provider.models = models;
  return next;
}

/** Remove a model by id or alias. No-op if not found. */
export function removeModel(profile: LappProfile, target: ModelTarget): LappProfile {
  const next = clone(profile);
  const provider = next.providers.find((p) => p.config.id === target.providerId);
  if (!provider || !provider.models) return next;
  const removedIds = new Set<string>();
  for (const m of provider.models.models) {
    if (m.id === target.model) removedIds.add(m.id);
    if (Array.isArray(m.aliases) && m.aliases.includes(target.model)) removedIds.add(m.id);
  }
  provider.models.models = provider.models.models.filter((m) => !removedIds.has(m.id));
  // If the removed model was referenced by any global default, clear it so the
  // next client call doesn't silently fall back to a non-existent model. A
  // global default can reference a model by id OR by alias, so check both —
  // a default set via `model: "fast"` (alias) must be cleared when "fast" is
  // removed, even though removedIds holds real ids.
  if (removedIds.size > 0 && next.global) {
    for (const key of MODEL_REF_KEYS) {
      const ref = next.global[key];
      if (!ref || ref.providerId !== target.providerId) continue;
      if (typeof ref.model !== "string") continue;
      if (removedIds.has(ref.model)) {
        delete next.global[key];
        continue;
      }
      // Default references the model by an alias: clear it too.
      const stillResolvable = next.providers
        .find((p) => p.config.id === target.providerId)
        ?.models?.models.some((m) => Array.isArray(m.aliases) && m.aliases.includes(ref.model!));
      if (!stillResolvable) delete next.global[key];
    }
  }
  return next;
}

/** Set a global default model reference. */
export function setDefaultModel(profile: LappProfile, target: ModelTarget): LappProfile {
  const next = clone(profile);
  if (!next.global) next.global = { schemaVersion: "1.0" };
  next.global.defaultModel = { providerId: target.providerId, model: target.model };
  return next;
}

/** Predicate: is the protocol supported by the v1 client SDK? */
export function isSupportedProtocol(protocol: string): boolean {
  return (
    protocol === "openai-chat-completions" ||
    protocol === "openai-responses" ||
    protocol === "anthropic-messages"
  );
}

export { UnsupportedProtocolError } from "../types.js";
