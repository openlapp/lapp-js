/**
 * Protocol adapter interface.
 *
 * Each adapter knows how to (a) build a provider-native HTTP request from a
 * normalized `ChatInput`, and (b) parse a provider-native response into the
 * unified `LappResponse` shape (preserving `raw`).
 */

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** Optional tool call id for tool messages. */
  toolCallId?: string;
}

export interface ChatInput {
  messages: ChatMessage[];
  /** Model override; falls back to the client's resolved model. */
  model?: string;
  temperature?: number;
  maxTokens?: number;
  /** Provider-native extra fields merged into the request body. */
  extra?: Record<string, unknown>;
  /** Whether to request streaming (adapters may reject; v1 focuses on non-stream). */
  stream?: boolean;
}

export interface LappResponse {
  text: string;
  provider: string;
  model: string;
  protocol: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
  finishReason?: string;
  raw: unknown;
}

export interface AdapterRequest {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  body: unknown;
}

export interface AdapterContext {
  providerId: string;
  protocol: string;
  baseUrl: string;
  /** Resolved secret value (already resolved by the client). */
  secret: string;
  /** Auth type (default bearer). */
  authType?: string;
  /** Custom auth header name. */
  authHeader?: string;
  /** Custom auth query param name. */
  authQueryParam?: string;
  /** Non-secret static request headers from the profile. */
  requestHeaders?: Record<string, string>;
  /** Resolved model id (real invocation name). */
  model: string;
}

export interface ProtocolAdapter {
  readonly protocol: string;
  buildRequest(input: ChatInput, ctx: AdapterContext): AdapterRequest;
  parseResponse(raw: unknown, ctx: AdapterContext): LappResponse;
}