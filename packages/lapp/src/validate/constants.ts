import { isIP } from "node:net";

export const CORE_PROTOCOLS = new Set([
  "openai-chat-completions",
  "openai-responses",
  "anthropic-messages",
]);

export const SENSITIVE_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "api-key",
]);

export function isSensitiveHeaderName(name: string): boolean {
  const lower = name.toLowerCase();
  if (SENSITIVE_HEADERS.has(lower)) return true;
  const normalized = lower.replace(/[^a-z0-9]/g, "");
  return normalized.endsWith("apikey")
    || normalized.endsWith("token")
    || normalized.endsWith("secret")
    || normalized.endsWith("credential");
}

export function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === "::1") return true;
  return isIP(host) === 4 && host.startsWith("127.");
}

export const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

export function isValidProviderId(id: string): boolean {
  return PROVIDER_ID_PATTERN.test(id) && !WINDOWS_RESERVED.test(id) && !id.endsWith(".");
}

export function isValidModelId(id: string): boolean {
  return id.trim().length > 0 && !/[\u0000-\u001f\u007f]/.test(id);
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
