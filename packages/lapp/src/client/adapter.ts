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
  /** Optional tool name for tool messages (used by Anthropic). */
  name?: string;
  /** Assistant-emitted tool calls. */
  toolCalls?: Array<{ id: string; name: string; arguments: string }>;
}

export interface ToolDefinition {
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
}

export interface ParsedToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  /** If the arguments string could not be parsed as JSON. */
  parseError?: string;
  /** Raw arguments string, preserved when parsing fails. */
  argumentsRaw?: string;
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
  /** Tool definitions for provider-native function calling. */
  tools?: ToolDefinition[];
  /** Provider-native tool choice override. */
  toolChoice?: unknown;
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
  /** Assistant-emitted tool calls. */
  toolCalls?: ParsedToolCall[];
  raw: unknown;
}

export interface LappStreamEvent {
  kind: "delta" | "tool-call" | "usage" | "finish" | "error";
}

export interface DeltaStreamEvent extends LappStreamEvent {
  kind: "delta";
  text: string;
}

export interface ToolCallStreamEvent extends LappStreamEvent {
  kind: "tool-call";
  id: string;
  name: string;
  arguments: string;
}

export interface UsageStreamEvent extends LappStreamEvent {
  kind: "usage";
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface FinishStreamEvent extends LappStreamEvent {
  kind: "finish";
  reason: string;
}

export interface ErrorStreamEvent extends LappStreamEvent {
  kind: "error";
  message: string;
}

export type LappStreamEventUnion =
  | DeltaStreamEvent
  | ToolCallStreamEvent
  | UsageStreamEvent
  | FinishStreamEvent
  | ErrorStreamEvent;

export interface AdapterRequest {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  body: unknown;
  stream?: boolean;
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
  parseStream?(body: ReadableStream<Uint8Array>, ctx: AdapterContext): AsyncIterable<LappStreamEventUnion>;
}
