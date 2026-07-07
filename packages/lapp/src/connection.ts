/**
 * Profile query helpers.
 *
 * Lightweight convenience APIs that work over an in-memory `LappProfile`
 * (use `loadProfile` to read one from disk first). These do not touch the
 * network or the filesystem — pure functions over already-loaded data.
 *
 * For requests / streaming / tool calls, use `createLappClient`.
 */

import type { LappProfile, LinkMap } from "./types.js";
import { getProviderProtocols, getPrimaryProtocolId, getProtocolBaseUrl } from "./protocols.js";

/** A flattened model entry combining provider-level + model-level fields. */
export interface FlatModelEntry {
  providerId: string;
  providerName?: string;
  providerEnabled: boolean;
  modelId: string;
  modelName?: string;
  modelEnabled: boolean;
  /** Negotiated protocol id for the provider (first entry in `protocols`). */
  protocol: string;
  /** Final baseUrl after applying any protocol-level override. */
  baseUrl: string;
  type?: string;
  capabilities?: string[];
  inputModalities?: string[];
  outputModalities?: string[];
  aliases?: string[];
  contextWindow?: number;
  maxOutputTokens?: number;
  links?: LinkMap;
}

export interface ListModelsOptions {
  /** Restrict to a single provider id (exact match). */
  providerId?: string;
  /** Include providers with `enabled: false` (default `false`). */
  includeDisabled?: boolean;
  /** Include models with `enabled: false` (default `false`). */
  includeDisabledModels?: boolean;
}

/**
 * Flatten a profile into a list of `{ providerId, modelId, ... }` records,
 * one per model. Providers with no `models.json` produce no entries (callers
 * can detect them via `inspectProfile`).
 *
 * Pure in-memory walk — no disk I/O, no network. Order matches the on-disk
 * sort order of providers (alphabetical by directory name) and the
 * declarative order of `models.json`.
 */
export function listModels(
  profile: LappProfile,
  options: ListModelsOptions = {},
): FlatModelEntry[] {
  const includeDisabled = options.includeDisabled ?? false;
  const includeDisabledModels = options.includeDisabledModels ?? false;
  const providerFilter = options.providerId;

  const out: FlatModelEntry[] = [];
  for (const p of profile.providers) {
    if (providerFilter !== undefined && p.config.id !== providerFilter) continue;
    const providerEnabled = p.config.enabled !== false;
    if (!providerEnabled && !includeDisabled) continue;

    const protocol = getPrimaryProtocolId(p.config);
    // Reuse the resolved protocol entry (not a fresh `{ id }`) so the
    // protocol-level baseUrl / requestHeaders / capabilities override the
    // provider-level values.
    const protocolEntry = getProviderProtocols(p.config)[0] ?? { id: protocol };
    const baseUrl = getProtocolBaseUrl(p.config, protocolEntry);
    const modelList = p.models?.models ?? [];
    for (const m of modelList) {
      const modelEnabled = m.enabled !== false;
      if (!modelEnabled && !includeDisabledModels) continue;
      out.push({
        providerId: p.config.id,
        ...(p.config.name !== undefined ? { providerName: p.config.name } : {}),
        providerEnabled,
        modelId: m.id,
        ...(m.name !== undefined ? { modelName: m.name } : {}),
        modelEnabled,
        protocol,
        baseUrl,
        ...(m.type !== undefined ? { type: m.type } : {}),
        ...(Array.isArray(m.capabilities) ? { capabilities: m.capabilities } : {}),
        ...(Array.isArray(m.inputModalities) ? { inputModalities: m.inputModalities } : {}),
        ...(Array.isArray(m.outputModalities) ? { outputModalities: m.outputModalities } : {}),
        ...(Array.isArray(m.aliases) ? { aliases: m.aliases } : {}),
        ...(typeof m.contextWindow === "number" ? { contextWindow: m.contextWindow } : {}),
        ...(typeof m.maxOutputTokens === "number" ? { maxOutputTokens: m.maxOutputTokens } : {}),
        ...(m.links !== undefined ? { links: m.links } : {}),
      });
    }
  }
  return out;
}
