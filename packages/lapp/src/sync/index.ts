/**
 * Model sync public API.
 */

import { resolveSecret } from "../secret/index.js";
import {
  TargetResolutionError,
  UnsupportedProtocolError,
  type LappProfile,
  type LappProvider,
  type ModelEntry,
  type ModelsConfig,
} from "../types.js";
import { fetchAnthropicModels } from "./anthropic.js";
import { inferCapabilitiesFromProviderEntry } from "./capabilities.js";
import { diffModels } from "./diff.js";
import { fetchOpenAiCompatModels } from "./openai-compat.js";
import type { FetchedModelEntry, ModelSyncResult, SyncOptions } from "./types.js";
import { getPrimaryProtocolId } from "../protocols.js";

export { ModelSyncUnsupportedError } from "./types.js";

function resolveModelSyncProvider(
  profile: LappProfile,
  providerId: string,
): LappProvider {
  const p = profile.providers.find((x) => x.config.id === providerId);
  if (!p) throw new TargetResolutionError(`provider not found: ${providerId}`);
  if (p.config.enabled === false) {
    throw new TargetResolutionError(`provider is disabled: ${providerId}`);
  }
  return p;
}

function buildSyncContext(
  provider: LappProvider,
  options: SyncOptions,
): {
  providerId: string;
  protocol: string;
  baseUrl: string;
  secret: string;
  authType?: string;
  authHeader?: string;
  requestHeaders?: Record<string, string>;
} {
  const secretResult = resolveSecret(provider.config.auth?.secret, {
    resolve: options.resolveSecrets ?? false,
    env: options.env,
  });
  if (!secretResult.ok) {
    if (options.allowUnauthenticated && secretResult.reason === "unset") {
      // Continue with empty secret for local/self-hosted providers.
    } else {
      throw secretResult.error;
    }
  }
  return {
    providerId: provider.config.id,
    protocol: getPrimaryProtocolId(provider.config),
    baseUrl: provider.config.baseUrl,
    secret: secretResult.ok ? secretResult.value : "",
    authType: provider.config.auth?.type,
    authHeader: provider.config.auth?.header,
    requestHeaders: provider.config.requestHeaders,
  };
}

function fetchedToModelEntry(entry: FetchedModelEntry, protocol: string): ModelEntry {
  const inferred = inferCapabilitiesFromProviderEntry(entry, protocol);
  return {
    id: entry.id,
    source: "provider",
    name: entry.name,
    type: inferred.type,
    inputModalities: inferred.inputModalities,
    outputModalities: inferred.outputModalities,
    capabilities: inferred.capabilities,
  };
}

/**
 * Fetch the model list for a provider and return normalized ModelEntry objects.
 *
 * Throws on unsupported protocols or unresolved secrets.
 */
export async function fetchProviderModels(
  profile: LappProfile,
  providerId: string,
  options: SyncOptions = {},
): Promise<FetchedModelEntry[]> {
  const provider = resolveModelSyncProvider(profile, providerId);
  const protocol = getPrimaryProtocolId(provider.config);
  const ctx = buildSyncContext(provider, options);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const modelsUrl = provider.config.links?.models;

  if (protocol === "openai-chat-completions" || protocol === "openai-responses") {
    return fetchOpenAiCompatModels(ctx, fetchImpl, modelsUrl);
  }
  if (protocol === "anthropic-messages") {
    if (modelsUrl) {
      return fetchOpenAiCompatModels(ctx, fetchImpl, modelsUrl);
    }
    // `fetchAnthropicModels` always throws `ModelSyncUnsupportedError` —
    // we don't want a "fall through to UnsupportedProtocolError" path to
    // be reachable here, so we re-throw its result directly. Anthropic
    // has no public models-list API; callers must set `provider.links.models`.
    throw fetchAnthropicModels(providerId);
  }
  throw new UnsupportedProtocolError(protocol);
}

/**
 * Build a ModelSyncResult by diffing fetched models against the existing
 * models.json entries (if any).
 */
export function buildModelSyncResult(
  before: ModelsConfig | null,
  fetched: FetchedModelEntry[],
  protocol: string,
): ModelSyncResult {
  const fresh = fetched.map((e) => fetchedToModelEntry(e, protocol));
  const existing = before?.models ?? [];
  const { added, removed, updated } = diffModels(existing, fresh);
  return { models: fresh, added, removed, updated };
}

/**
 * Fetch + diff in one call.
 */
export async function syncProviderModels(
  profile: LappProfile,
  providerId: string,
  options: SyncOptions = {},
): Promise<ModelSyncResult> {
  const provider = resolveModelSyncProvider(profile, providerId);
  const fetched = await fetchProviderModels(profile, providerId, options);
  return buildModelSyncResult(provider.models, fetched, getPrimaryProtocolId(provider.config));
}

/**
 * Merge fetched models into an existing ModelsConfig, preserving user-curated
 * fields (aliases, enabled, links, metadata) on entries that already exist.
 */
export function applySyncedModels(
  before: ModelsConfig | null,
  result: ModelSyncResult,
): ModelsConfig {
  const existingById = new Map((before?.models ?? []).map((m) => [m.id, m]));
  const merged: ModelEntry[] = result.models.map((fresh) => {
    const existing = existingById.get(fresh.id);
    if (!existing) return fresh;
    return {
      ...fresh,
      // Preserve user-curated fields. `name` and `source` are provider-owned
      // by default, but if the user has set a display name or explicitly tagged
      // the entry as manual, keep those values — the provider's omission or
      // re-tagging should not wipe them.
      name: existing.name ?? fresh.name,
      source: existing.source === "manual" ? "manual" : fresh.source,
      aliases: existing.aliases,
      enabled: existing.enabled,
      links: existing.links,
      metadata: existing.metadata,
    };
  });

  // Preserve existing entries that are not in the fresh list. The caller
  // is responsible for filtering stale provider-sourced entries by source
  // (e.g. the CLI removes `source: "provider"` entries no longer in the
  // fetched set when `--remove-stale` is passed). Manual entries always
  // survive regardless of presence in the fetched list.
  for (const m of before?.models ?? []) {
    if (!merged.some((x) => x.id === m.id)) {
      merged.push(m);
    }
  }

  return {
    schemaVersion: "1.0",
    updatedAt: new Date().toISOString(),
    models: merged,
    // Internal marker so the writer knows this `updatedAt` came from a
    // sync flow (vs. an arbitrary manage edit) and should survive the
    // write. `__`-prefixed fields are stripped on write by `stableStringify`.
    __lappUpdatedAtSource: "sync",
  } as ModelsConfig & { __lappUpdatedAtSource?: "sync" | "manual" };
}
