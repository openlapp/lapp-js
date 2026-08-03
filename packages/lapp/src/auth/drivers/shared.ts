import type { AdapterContext, ChatInput, LappStreamEventUnion } from "../../client/adapter.js";
import { openaiChatCompletionsAdapter } from "../../client/openai-chat.js";
import { openaiResponsesAdapter } from "../../client/openai-responses.js";
import { AuthError, type AuthEnvelopeV1 } from "../../types.js";
import type { AuthDriverContext } from "../driver.js";

export function configString(context: AuthDriverContext, key: string, fallback?: string): string {
  const value = context.config[key];
  if (typeof value === "string" && value.trim()) return value.trim();
  if (fallback !== undefined) return fallback;
  throw new AuthError("AUTH_DRIVER_NOT_SUPPORTED", `auth driver configuration is missing: ${key}`);
}

export function credentialString(envelope: AuthEnvelopeV1, key: string): string | undefined {
  const value = envelope.credentials[key];
  return typeof value === "string" && value ? value : undefined;
}

export function expiresAt(expiresIn: unknown, fallbackSeconds: number): string {
  const seconds = typeof expiresIn === "number" && Number.isFinite(expiresIn) && expiresIn > 0
    ? expiresIn
    : fallbackSeconds;
  return new Date(Date.now() + seconds * 1_000).toISOString();
}

export function jwtPayload(token: string): Record<string, unknown> | undefined {
  try {
    const part = token.split(".")[1];
    if (!part) return undefined;
    const normalized = part.replaceAll("-", "+").replaceAll("_", "/");
    const value: unknown = JSON.parse(Buffer.from(normalized, "base64").toString("utf8"));
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

export async function responseJson(response: Response, operation: "login" | "refresh"): Promise<Record<string, unknown>> {
  if (!response.ok) {
    throw new AuthError(
      operation === "login" ? "AUTH_LOGIN_FAILED" : "AUTH_REFRESH_FAILED",
      `auth ${operation} endpoint returned HTTP ${response.status}`,
      response.status,
    );
  }
  let value: unknown;
  try { value = await response.json(); } catch { /* mapped below */ }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AuthError(
      operation === "login" ? "AUTH_LOGIN_FAILED" : "AUTH_REFRESH_FAILED",
      `auth ${operation} endpoint returned invalid JSON`,
    );
  }
  return value as Record<string, unknown>;
}

export async function formPost(
  fetchImpl: typeof fetch,
  url: string,
  values: Record<string, string>,
  operation: "login" | "refresh",
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(values),
    redirect: "error",
    signal,
  });
  return responseJson(response, operation);
}

export async function* streamResponses(
  context: AuthDriverContext,
  envelope: AuthEnvelopeV1,
  input: ChatInput,
  options: {
    baseUrl: string;
    headers?: Record<string, string>;
    transformBody?: (body: Record<string, unknown>) => Record<string, unknown>;
  },
): AsyncIterable<LappStreamEventUnion> {
  input.signal?.throwIfAborted();
  const adapterContext: AdapterContext = {
    providerId: context.source.config.id,
    protocol: context.protocol,
    baseUrl: options.baseUrl,
    auth: {
      type: "bearer",
      secret: credentialString(envelope, "accessToken")
        ?? (() => { throw new AuthError("AUTH_LOGIN_REQUIRED", "auth access token is missing"); })(),
    },
    requestHeaders: options.headers,
    model: context.modelId,
  };
  const request = openaiResponsesAdapter.buildRequest({ ...input, stream: true }, adapterContext);
  const body = options.transformBody
    ? options.transformBody(request.body as Record<string, unknown>)
    : request.body;
  let response: Response;
  try {
    response = await context.fetchImpl(request.url, {
      method: request.method,
      headers: { ...request.headers, accept: "text/event-stream" },
      body: JSON.stringify(body),
      redirect: "error",
      signal: input.signal,
    });
  } catch (error) {
    if (error instanceof AuthError) throw error;
    if (input.signal?.aborted) throw error;
    throw new AuthError("AUTH_HTTP_ERROR", "auth upstream request failed");
  }
  if (!response.ok) {
    try { await response.body?.cancel(); } catch { /* ignore */ }
    throw new AuthError(
      "AUTH_HTTP_ERROR",
      `auth upstream returned HTTP ${response.status}`,
      response.status,
    );
  }
  if (!response.body || !openaiResponsesAdapter.parseStream) {
    throw new AuthError("AUTH_HTTP_ERROR", "auth upstream returned an empty stream");
  }
  for await (const event of openaiResponsesAdapter.parseStream(response.body, adapterContext)) {
    yield event.kind === "error"
      ? { kind: "error", message: "auth upstream stream failed" }
      : event;
  }
}

/**
 * Send an OpenAI Chat Completions-compatible Auth request directly. This is
 * intentionally separate from `streamResponses`: an Auth driver must select
 * the upstream wire protocol it actually speaks rather than translating a
 * Responses request at the edge.
 */
export async function* streamChatCompletions(
  context: AuthDriverContext,
  envelope: AuthEnvelopeV1,
  input: ChatInput,
  options: {
    baseUrl: string;
    headers?: Record<string, string>;
  },
): AsyncIterable<LappStreamEventUnion> {
  input.signal?.throwIfAborted();
  const adapterContext: AdapterContext = {
    providerId: context.source.config.id,
    protocol: "openai-chat-completions",
    baseUrl: options.baseUrl,
    auth: {
      type: "bearer",
      secret: credentialString(envelope, "accessToken")
        ?? (() => { throw new AuthError("AUTH_LOGIN_REQUIRED", "auth access token is missing"); })(),
    },
    requestHeaders: options.headers,
    model: context.modelId,
  };
  const request = openaiChatCompletionsAdapter.buildRequest({ ...input, stream: true }, adapterContext);
  let response: Response;
  try {
    response = await context.fetchImpl(request.url, {
      method: request.method,
      headers: { ...request.headers, accept: "text/event-stream" },
      body: JSON.stringify(request.body),
      redirect: "error",
      signal: input.signal,
    });
  } catch (error) {
    if (error instanceof AuthError) throw error;
    if (input.signal?.aborted) throw error;
    throw new AuthError("AUTH_HTTP_ERROR", "auth upstream request failed");
  }
  if (!response.ok) {
    try { await response.body?.cancel(); } catch { /* ignore */ }
    throw new AuthError(
      "AUTH_HTTP_ERROR",
      `auth upstream returned HTTP ${response.status}`,
      response.status,
    );
  }
  if (!response.body || !openaiChatCompletionsAdapter.parseStream) {
    throw new AuthError("AUTH_HTTP_ERROR", "auth upstream returned an empty stream");
  }
  for await (const event of openaiChatCompletionsAdapter.parseStream(response.body, adapterContext)) {
    yield event.kind === "error"
      ? { kind: "error", message: "auth upstream stream failed" }
      : event;
  }
}
