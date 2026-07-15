import { listModels } from "../connection.js";
import {
  assertCredentialRequestOrigin,
  createCredentialResolver,
  credentialBindingForProvider,
  parseSecretRef,
  resolveAuthConfig,
} from "../secret/index.js";
import {
  ModelRefreshError,
  ProfileValidationError,
  TargetResolutionError,
  type Diagnostic,
  type CredentialResolver,
  type CredentialBinding,
  type CredentialVault,
  type LappProfile,
  type ModelDescriptor,
  type ModelEntry,
  type ProviderConfig,
  type ResolvedAuth,
} from "../types.js";
import { isLoopbackHostname, isValidModelId } from "../validate/constants.js";
import { validateProfile } from "../validate/index.js";
import { copyProfileRoot } from "../profile-location.js";
import { redactErrorText } from "../redact.js";

export interface RefreshModelsOptions {
  env?: Record<string, string | undefined>;
  vault?: CredentialVault;
  resolver?: CredentialResolver;
  fetch?: typeof fetch;
  signal?: AbortSignal;
}

export interface RefreshModelsResult {
  nextProfile: LappProfile;
  added: ModelDescriptor[];
  diagnostics: Diagnostic[];
}

interface RemoteModel {
  id: string;
  name?: string;
}

function sensitiveValues(auth: ResolvedAuth): string[] {
  return auth.type === "none" ? [] : [auth.secret];
}

function containsSensitiveValue(value: string | undefined, sensitive: readonly string[]): boolean {
  if (value === undefined) return false;
  return sensitive.some((secret) => {
    if (!secret) return false;
    const encoded = new Set([secret]);
    try { encoded.add(encodeURIComponent(secret)); } catch { /* literal remains protected */ }
    try {
      encoded.add(new URLSearchParams({ value: secret }).toString().slice("value=".length));
    } catch { /* literal remains protected */ }
    return [...encoded].some((candidate) => candidate.length > 0 && value.includes(candidate));
  });
}

function discoveryUrl(config: ProviderConfig): URL {
  if (!config.modelDiscovery) {
    throw new ModelRefreshError(
      `model discovery is not configured for provider "${config.id}"`,
      "DISCOVERY_NOT_CONFIGURED",
    );
  }
  let base: URL;
  let discovery: URL;
  try {
    base = new URL(config.baseUrl);
    discovery = new URL(config.modelDiscovery.url);
  } catch {
    throw new ModelRefreshError("provider discovery URL is invalid", "DISCOVERY_NOT_CONFIGURED");
  }
  if (base.origin !== discovery.origin) {
    throw new ModelRefreshError("model discovery URL must match provider origin", "DISCOVERY_NOT_CONFIGURED");
  }
  if (discovery.username || discovery.password || discovery.hash) {
    throw new ModelRefreshError("model discovery URL contains forbidden components", "DISCOVERY_NOT_CONFIGURED");
  }
  if (discovery.protocol !== "https:" && !(discovery.protocol === "http:" && isLoopbackHostname(discovery.hostname))) {
    throw new ModelRefreshError("remote model discovery requires HTTPS", "DISCOVERY_NOT_CONFIGURED");
  }
  return discovery;
}

function requestParts(
  config: ProviderConfig,
  auth: ResolvedAuth,
  cursor?: string,
): { url: string; headers: Record<string, string> } {
  const url = discoveryUrl(config);
  if (cursor !== undefined) url.searchParams.set("after_id", cursor);
  const blockedHeader = auth.type === "bearer"
    ? "authorization"
    : auth.type === "header"
      ? auth.name.toLowerCase()
      : undefined;
  const headers = Object.fromEntries(
    Object.entries(config.requestHeaders ?? {})
      .filter(([name]) => name.toLowerCase() !== blockedHeader),
  );
  if (auth.type === "bearer") headers.Authorization = `Bearer ${auth.secret}`;
  else if (auth.type === "header") headers[auth.name] = auth.secret;
  else if (auth.type === "query") url.searchParams.set(auth.name, auth.secret);
  return { url: url.toString(), headers };
}

function parseModels(payload: unknown, protocol: "openai-models" | "anthropic-models"): {
  models: RemoteModel[];
  hasMore: boolean;
  cursor?: string;
} {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new ModelRefreshError("model discovery response must be an object", "INVALID_RESPONSE");
  }
  const object = payload as Record<string, unknown>;
  if (!Array.isArray(object.data)) {
    throw new ModelRefreshError("model discovery response is missing data[]", "INVALID_RESPONSE");
  }
  const seen = new Set<string>();
  const models = object.data.map((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new ModelRefreshError("model discovery data contains a non-object", "INVALID_RESPONSE");
    }
    const entry = raw as Record<string, unknown>;
    if (typeof entry.id !== "string" || !isValidModelId(entry.id)) {
      throw new ModelRefreshError("model discovery entry has an invalid id", "INVALID_RESPONSE");
    }
    if (seen.has(entry.id)) {
      throw new ModelRefreshError(`model discovery returned duplicate id "${entry.id}"`, "INVALID_RESPONSE");
    }
    seen.add(entry.id);
    const name = protocol === "anthropic-models" ? entry.display_name : entry.name;
    if (name !== undefined && (typeof name !== "string" || !isValidModelId(name))) {
      throw new ModelRefreshError(`model "${entry.id}" has an invalid display name`, "INVALID_RESPONSE");
    }
    return { id: entry.id, ...(typeof name === "string" && name ? { name } : {}) };
  });
  if (protocol === "openai-models") return { models, hasMore: false };
  if (object.has_more !== undefined && typeof object.has_more !== "boolean") {
    throw new ModelRefreshError("Anthropic has_more must be boolean", "INVALID_RESPONSE");
  }
  const hasMore = object.has_more === true;
  const cursor = typeof object.last_id === "string" ? object.last_id : undefined;
  if (hasMore && !cursor) {
    throw new ModelRefreshError("Anthropic pagination is missing last_id", "PAGINATION_ERROR");
  }
  return { models, hasMore, ...(cursor ? { cursor } : {}) };
}

async function fetchPage(
  config: ProviderConfig,
  auth: ResolvedAuth,
  expectedBinding: CredentialBinding | undefined,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
  cursor?: string,
): Promise<{ models: RemoteModel[]; hasMore: boolean; cursor?: string }> {
  const request = requestParts(config, auth, cursor);
  if (expectedBinding) assertCredentialRequestOrigin(expectedBinding, request.url);
  let response: Response;
  try {
    signal?.throwIfAborted();
    response = await fetchImpl(request.url, {
      method: "GET",
      headers: request.headers,
      redirect: "error",
      signal,
    });
  } catch {
    throw new ModelRefreshError("model discovery request failed", "HTTP_ERROR");
  }
  if (!response.ok) {
    throw new ModelRefreshError(
      `provider "${config.id}" returned HTTP ${response.status}`,
      "HTTP_ERROR",
    );
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new ModelRefreshError("model discovery returned invalid JSON", "INVALID_RESPONSE");
  }
  return parseModels(payload, config.modelDiscovery!.protocol);
}

async function fetchAllModels(
  config: ProviderConfig,
  auth: ResolvedAuth,
  expectedBinding: CredentialBinding | undefined,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<RemoteModel[]> {
  const result: RemoteModel[] = [];
  const sensitive = sensitiveValues(auth);
  const ids = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 100; page++) {
    const current = await fetchPage(config, auth, expectedBinding, fetchImpl, signal, cursor);
    if (
      current.models.some((model) =>
        containsSensitiveValue(model.id, sensitive) || containsSensitiveValue(model.name, sensitive))
      || containsSensitiveValue(current.cursor, sensitive)
    ) {
      throw new ModelRefreshError(
        "model discovery response contains credential data",
        "INVALID_RESPONSE",
      );
    }
    for (const model of current.models) {
      if (ids.has(model.id)) {
        throw new ModelRefreshError(`duplicate model id across pages: "${model.id}"`, "PAGINATION_ERROR");
      }
      ids.add(model.id);
      result.push(model);
    }
    if (!current.hasMore) return result;
    if (!current.cursor || cursors.has(current.cursor)) {
      throw new ModelRefreshError("model discovery pagination did not advance", "PAGINATION_ERROR");
    }
    cursors.add(current.cursor);
    cursor = current.cursor;
  }
  throw new ModelRefreshError("model discovery exceeded 100 pages", "PAGINATION_ERROR");
}

export async function refreshModels(
  profile: LappProfile,
  providerId: string,
  options: RefreshModelsOptions = {},
): Promise<RefreshModelsResult> {
  const validation = validateProfile(profile);
  if (!validation.valid) {
    const detail = validation.diagnostics.find((entry) => entry.level === "ERROR")?.message;
    throw new ProfileValidationError(
      validation.diagnostics,
      `cannot refresh models from an invalid profile${detail ? `: ${detail}` : ""}`,
    );
  }
  const providerIndex = profile.providers.findIndex((entry) => entry.config.id === providerId);
  if (providerIndex < 0) {
    throw new TargetResolutionError(`provider not found: ${providerId}`, "PROVIDER_NOT_FOUND");
  }
  const stableProfile = copyProfileRoot(profile, structuredClone(profile));
  const provider = stableProfile.providers[providerIndex]!;
  if (provider.config.enabled === false) {
    throw new TargetResolutionError(`provider is disabled: ${providerId}`, "PROVIDER_DISABLED");
  }
  discoveryUrl(provider.config);
  const expectedBinding = credentialBindingForProvider(provider.config);
  const resolverBinding = expectedBinding ? structuredClone(expectedBinding) : undefined;
  const resolver = options.resolver ?? createCredentialResolver({
    ...(options.env ? { env: options.env } : {}),
    ...(options.vault ? { vault: options.vault } : {}),
  });
  const auth = await resolveAuthConfig(provider.config.auth, resolverBinding, { resolver });
  let fetched: RemoteModel[];
  try {
    fetched = await fetchAllModels(
      provider.config,
      auth,
      expectedBinding,
      options.fetch ?? globalThis.fetch,
      options.signal,
    );
  } catch (error) {
    if (error instanceof ModelRefreshError) {
      const redacted = redactErrorText(error.message, sensitiveValues(auth));
      if (redacted !== error.message) {
        throw new ModelRefreshError(
          "model discovery response contains credential data",
          "INVALID_RESPONSE",
        );
      }
      throw new ModelRefreshError(redacted, error.code);
    }
    throw error;
  }
  const existing = provider.models.models;
  const existingById = new Map(existing.map((model) => [model.id, model]));
  const identities = new Set(existing.flatMap((model) => [model.id, ...(model.aliases ?? [])]));
  const conflicting = fetched.find((model) => !existingById.has(model.id) && identities.has(model.id));
  if (conflicting) {
    throw new ModelRefreshError(
      `remote model id conflicts with a local model id or alias: "${conflicting.id}"`,
      "INVALID_RESPONSE",
    );
  }
  const remoteById = new Map(fetched.map((model) => [model.id, model]));
  const additions: ModelEntry[] = fetched
    .filter((model) => !existingById.has(model.id))
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((model) => ({ id: model.id, ...(model.name ? { name: model.name } : {}) }));
  const fillsName = existing.some((model) => !model.name && remoteById.get(model.id)?.name);
  const diagnostics: Diagnostic[] = [];
  if (provider.config.auth.type !== "none" && parseSecretRef(provider.config.auth.secret).plaintext) {
    diagnostics.push({
      level: "WARN",
      location: `providers/${providerId}/provider.json#auth.secret`,
      message: "auth.secret is plaintext",
    });
  }
  if (additions.length === 0 && !fillsName) return { nextProfile: profile, added: [], diagnostics };

  const nextProfile = stableProfile;
  const nextProvider = nextProfile.providers[providerIndex]!;
  const nextModels = nextProvider.models.models.map((model) => {
    const remoteName = remoteById.get(model.id)?.name;
    return !model.name && remoteName ? { ...model, name: remoteName } : model;
  });
  nextProvider.models = {
    ...(nextProvider.models.extensions ? { extensions: nextProvider.models.extensions } : {}),
    schemaVersion: "1.0",
    models: [...nextModels, ...additions],
  };
  const addedIds = new Set(additions.map((model) => model.id));
  const added = listModels(nextProfile, { providerId, includeDisabled: true })
    .filter((model) => addedIds.has(model.modelId));
  return { nextProfile, added, diagnostics };
}
