import type { ProviderConfig, ResolvedProtocolEntry } from "./types.js";

export function normalizeProtocolEntry(entry: unknown): ResolvedProtocolEntry | null {
  if (typeof entry === "string") {
    const id = entry.trim();
    return id ? { id } : null;
  }
  if (entry && typeof entry === "object" && !Array.isArray(entry)) {
    const obj = entry as Record<string, unknown>;
    if (typeof obj.id !== "string" || obj.id.trim() === "") return null;
    // Strip the known fields from the spread so invalid shapes (non-string
    // baseUrl, array requestHeaders) are dropped rather than leaked through.
    const { id: _id, baseUrl: _baseUrl, requestHeaders: _requestHeaders, capabilities: _capabilities, ...rest } = obj;
    return {
      ...rest,
      id: obj.id.trim(),
      ...(typeof obj.baseUrl === "string" ? { baseUrl: obj.baseUrl } : {}),
      ...(obj.requestHeaders && typeof obj.requestHeaders === "object" && !Array.isArray(obj.requestHeaders)
        ? { requestHeaders: obj.requestHeaders as Record<string, string> }
        : {}),
      ...(Array.isArray(obj.capabilities)
        ? { capabilities: obj.capabilities.filter((v): v is string => typeof v === "string") }
        : {}),
    };
  }
  return null;
}

export function getProviderProtocols(config: ProviderConfig): ResolvedProtocolEntry[] {
  if (Array.isArray(config.protocols)) {
    return config.protocols
      .map((entry) => normalizeProtocolEntry(entry))
      .filter((entry): entry is ResolvedProtocolEntry => entry !== null);
  }
  return typeof config.protocol === "string" && config.protocol.trim()
    ? [{ id: config.protocol }]
    : [];
}

export function getPrimaryProtocol(config: ProviderConfig): ResolvedProtocolEntry {
  const [first] = getProviderProtocols(config);
  if (first) return first;
  return { id: config.protocol };
}

export function getPrimaryProtocolId(config: ProviderConfig): string {
  return getPrimaryProtocol(config).id;
}

export function getProtocolBaseUrl(config: ProviderConfig, protocol: ResolvedProtocolEntry): string {
  return protocol.baseUrl ?? config.baseUrl;
}

export function mergeProtocolRequestHeaders(
  config: ProviderConfig,
  protocol: ResolvedProtocolEntry,
): Record<string, string> | undefined {
  if (!config.requestHeaders && !protocol.requestHeaders) return undefined;
  return {
    ...(config.requestHeaders ?? {}),
    ...(protocol.requestHeaders ?? {}),
  };
}
