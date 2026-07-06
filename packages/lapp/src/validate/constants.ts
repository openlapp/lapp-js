/** Constants shared across the SDK. */

export const CORE_PROTOCOLS = new Set([
  "openai-chat-completions",
  "openai-responses",
  "anthropic-messages",
]);

export const SECRET_SCHEMES = new Set(["env", "keychain", "file"]);

export const SENSITIVE_HEADERS = new Set([
  "authorization",
  "cookie",
  "x-api-key",
  "proxy-authorization",
]);

export const MODEL_REF_KEYS = [
  "defaultModel",
  "defaultEmbeddingModel",
  "defaultImageModel",
  "defaultTextToSpeechModel",
  "defaultVideoModel",
] as const;

/** Type guard for "is a JSON object" (not null, not array, not primitive). */
export function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}