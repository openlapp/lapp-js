import type { ResolvedAuth } from "../types.js";

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
  /** Cancels the provider request. */
  signal?: AbortSignal;
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
  /** Fully resolved authentication returned by `resolveConnection`. */
  auth: ResolvedAuth;
  /** Non-secret static request headers from the profile. */
  requestHeaders?: Record<string, string>;
  /** Resolved model id (real invocation name). */
  model: string;
}

const RESERVED_EXTRA_FIELDS = new Set([
  "model",
  "messages",
  "input",
  "instructions",
  "stream",
  "tools",
  "tool_choice",
  "auth",
  "authentication",
  "authorization",
  "api_key",
  "apikey",
  "x-api-key",
]);

/** Reject fields that would bypass target, conversation, tool, or auth resolution. */
export function assertSafeExtra(extra: Record<string, unknown> | undefined): void {
  for (const key of Object.keys(extra ?? {})) {
    if (RESERVED_EXTRA_FIELDS.has(key.toLowerCase())) {
      throw new Error(`extra field is reserved: ${key}`);
    }
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parse provider-emitted tool arguments without treating primitives as objects. */
export function parseToolArguments(raw: string): Pick<ParsedToolCall, "arguments" | "parseError" | "argumentsRaw"> {
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {
        arguments: {},
        parseError: "invalid JSON object in tool call arguments",
        argumentsRaw: raw,
      };
    }
    return { arguments: parsed as Record<string, unknown> };
  } catch {
    return {
      arguments: {},
      parseError: "invalid JSON in tool call arguments",
      argumentsRaw: raw,
    };
  }
}

export interface ProtocolAdapter {
  readonly protocol: string;
  buildRequest(input: ChatInput, ctx: AdapterContext): AdapterRequest;
  parseResponse(raw: unknown, ctx: AdapterContext): LappResponse;
  parseStream?(body: ReadableStream<Uint8Array>, ctx: AdapterContext): AsyncIterable<LappStreamEventUnion>;
}
