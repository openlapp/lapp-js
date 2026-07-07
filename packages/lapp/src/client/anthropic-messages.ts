/**
 * Anthropic Messages adapter.
 *
 * POSTs `{baseUrl}/v1/messages` with `x-api-key` + `anthropic-version` headers.
 * Maps system messages to the top-level `system` field, user/assistant/tool
 * messages to the `messages` array.
 */

import type {
  AdapterContext,
  AdapterRequest,
  ChatInput,
  LappResponse,
  LappStreamEventUnion,
  ParsedToolCall,
  ProtocolAdapter,
} from "./adapter.js";
import { parseSse } from "./sse.js";
import { buildAuthHeadersWith } from "./http.js";

function joinUrl(base: string, suffix: string): string {
  const trimmed = base.replace(/\/+$/, "");
  const lastSeg = trimmed.split("/").pop() ?? "";
  let normalizedSuffix = suffix;
  if (lastSeg === "v1" && suffix.startsWith("/v1")) {
    normalizedSuffix = suffix.replace(/^\/v1/, "");
  }
  return `${trimmed}${normalizedSuffix.startsWith("/") ? normalizedSuffix : `/${normalizedSuffix}`}`;
}

function buildHeaders(ctx: AdapterContext): Record<string, string> {
  // Anthropic adds `anthropic-version` and has a slightly different auth
  // header convention (default `x-api-key`, strip a stray "Bearer " prefix
  // when a custom header is used). Delegate the auth-strip + content-type
  // work to the shared helper, then override the auth key.
  const headers = buildAuthHeadersWith(ctx, { "anthropic-version": "2023-06-01" });
  if (!ctx.secret) return headers;
  const header = (ctx.authHeader ?? "x-api-key").toLowerCase();
  if (header === "authorization") {
    headers["Authorization"] = ctx.secret.startsWith("Bearer ")
      ? ctx.secret
      : `Bearer ${ctx.secret}`;
  } else {
    // Strip a stray "Bearer " prefix — secrets may come pre-prefixed from a
    // shared secret source (e.g. env var meant for Authorization).
    headers[ctx.authHeader ?? "x-api-key"] = ctx.secret.startsWith("Bearer ")
      ? ctx.secret.slice("Bearer ".length)
      : ctx.secret;
  }
  return headers;
}

function buildMessages(messages: ChatInput["messages"]): Array<{ role: string; content: unknown }> {
  return messages
    .filter((m) => m.role !== "system")
    .map((m) => {
      if (m.role === "tool") {
        if (!m.toolCallId) {
          throw new Error("tool messages require toolCallId for anthropic-messages");
        }
        return {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: m.toolCallId, content: m.content }],
        };
      }
      if (m.role === "assistant" && m.toolCalls?.length) {
        // Anthropic allows a single assistant message to hold mixed text and
        // tool_use blocks. Emit a text block first (when present) so the
        // model's prior reasoning survives into the next request; the tool
        // argument JSON is parsed defensively because cross-provider tool
        // history may carry an unparseable string.
        const blocks: Array<{ type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }> = [];
        if (typeof m.content === "string" && m.content.length > 0) {
          blocks.push({ type: "text", text: m.content });
        }
        for (const tc of m.toolCalls) {
          let input: Record<string, unknown> = {};
          try {
            input = tc.arguments ? (JSON.parse(tc.arguments) as Record<string, unknown>) : {};
          } catch {
            input = {};
          }
          blocks.push({ type: "tool_use", id: tc.id, name: tc.name, input });
        }
        return { role: "assistant", content: blocks };
      }
      return { role: m.role, content: m.content };
    });
}

function parseToolCalls(content: unknown): ParsedToolCall[] | undefined {
  if (!Array.isArray(content)) return undefined;
  const out: ParsedToolCall[] = [];
  for (const c of content) {
    if (c.type !== "tool_use") continue;
    let args: Record<string, unknown> = {};
    let parseError: string | undefined;
    // `c.input` is expected to be an object per Anthropic's schema. Defensive
    // check for a non-object value (string, number, array) that could come
    // from cross-provider history or a misbehaving proxy.
    if (typeof c.input === "object" && c.input !== null && !Array.isArray(c.input)) {
      args = c.input as Record<string, unknown>;
    } else if (c.input != null) {
      parseError = "invalid tool_use input (expected object)";
    }
    out.push({
      id: String(c.id ?? ""),
      name: String(c.name ?? ""),
      arguments: args,
      ...(parseError ? { parseError } : {}),
    });
  }
  return out.length ? out : undefined;
}

export const anthropicMessagesAdapter: ProtocolAdapter = {
  protocol: "anthropic-messages",

  buildRequest(input: ChatInput, ctx: AdapterContext): AdapterRequest {
    const systemMessages = input.messages.filter((m) => m.role === "system");
    const body: Record<string, unknown> = {
      model: input.model ?? ctx.model,
      messages: buildMessages(input.messages),
      ...(systemMessages.length > 0
        ? { system: systemMessages.map((m) => m.content).join("\n\n") }
        : {}),
      ...(typeof input.maxTokens === "number" ? { max_tokens: input.maxTokens } : {}),
      ...(typeof input.temperature === "number" ? { temperature: input.temperature } : {}),
      ...(input.tools?.length ? {
        tools: input.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })),
        ...(input.toolChoice !== undefined ? { tool_choice: input.toolChoice } : {}),
      } : {}),
      ...(input.stream ? { stream: true } : {}),
      ...(input.extra ?? {}),
    };
    return {
      url: joinUrl(ctx.baseUrl, "/v1/messages"),
      method: "POST",
      headers: buildHeaders(ctx),
      body,
      stream: input.stream,
    };
  },

  parseResponse(raw: unknown, ctx: AdapterContext): LappResponse {
    const r = raw as {
      content?: Array<{ type?: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }>;
      model?: string;
      stop_reason?: string;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    const text = (r.content ?? [])
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("");
    return {
      text,
      provider: ctx.providerId,
      model: r.model ?? ctx.model,
      protocol: ctx.protocol,
      finishReason: r.stop_reason,
      toolCalls: parseToolCalls(r.content),
      usage: r.usage
        ? {
            inputTokens: r.usage.input_tokens,
            outputTokens: r.usage.output_tokens,
            totalTokens:
              (r.usage.input_tokens ?? 0) + (r.usage.output_tokens ?? 0) || undefined,
          }
        : undefined,
      raw,
    };
  },

  async *parseStream(body: ReadableStream<Uint8Array>, ctx: AdapterContext): AsyncIterable<LappStreamEventUnion> {
    const textAcc: Record<number, { type: string; text: string }> = {};
    const toolAcc: Record<number, { type: string; id: string; name: string; input: string }> = {};
    let inputTokens: number | undefined;
    let flushed = false;

    for await (const ev of parseSse(body)) {
      if (ev.data === "[DONE]") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(ev.data);
      } catch {
        yield { kind: "error", message: `invalid JSON in stream: ${ev.data}` };
        continue;
      }
      const chunk = parsed as {
        type?: string;
        index?: number;
        content_block?: { type?: string; text?: string; id?: string; name?: string };
        delta?: { type?: string; text?: string; partial_json?: string };
        message?: { usage?: { input_tokens?: number; output_tokens?: number } };
        usage?: { output_tokens?: number };
      };

      if (chunk.type === "content_block_start" && typeof chunk.index === "number") {
        const cb = chunk.content_block;
        if (cb?.type === "text") {
          textAcc[chunk.index] = { type: "text", text: cb.text ?? "" };
        } else if (cb?.type === "tool_use") {
          toolAcc[chunk.index] = { type: "tool_use", id: cb.id ?? "", name: cb.name ?? "", input: "" };
        }
      }

      if (chunk.type === "content_block_delta" && typeof chunk.index === "number") {
        const delta = chunk.delta;
        if (delta?.type === "text_delta" && typeof delta.text === "string") {
          yield { kind: "delta", text: delta.text };
          if (textAcc[chunk.index]) textAcc[chunk.index]!.text += delta.text;
        }
        if (delta?.type === "input_json_delta" && typeof delta.partial_json === "string") {
          if (toolAcc[chunk.index]) toolAcc[chunk.index]!.input += delta.partial_json;
        }
      }

      // Anthropic splits usage across two events: `message_start` carries
      // `message.usage.input_tokens` (and the first `output_tokens`), and
      // `message_delta` carries a fresh `usage.output_tokens`. Capture the
      // input tokens from message_start so the yielded `usage` event has the
      // full accounting — without this, streaming Anthropic always reports
      // inputTokens=undefined, asymmetric with parseResponse.
      if (chunk.type === "message_start") {
        const startUsage = chunk.message?.usage;
        if (startUsage) {
          if (typeof startUsage.input_tokens === "number") {
            inputTokens = startUsage.input_tokens;
          }
        }
      }

      if (chunk.type === "message_delta") {
        if (chunk.usage) {
          yield {
            kind: "usage",
            inputTokens,
            outputTokens: chunk.usage.output_tokens ?? chunk.message?.usage?.output_tokens,
          };
        }
      }

      if (chunk.type === "message_stop") {
        for (const tc of Object.values(toolAcc)) {
          yield { kind: "tool-call", id: tc.id, name: tc.name, arguments: tc.input };
        }
        // Mark flushed so the post-loop truncated-stream flush does not
        // re-emit the same tool calls on a normal completion.
        flushed = true;
        yield { kind: "finish", reason: "stop" };
      }
    }

    // In case the provider never sent a message_stop (truncated stream),
    // flush any accumulated tool calls so downstream consumers don't
    // silently lose them. Gated by `flushed` so a normal completion
    // (which already flushed inside the loop) does not re-emit duplicates.
    if (!flushed && Object.keys(toolAcc).length > 0) {
      for (const tc of Object.values(toolAcc)) {
        yield { kind: "tool-call", id: tc.id, name: tc.name, arguments: tc.input };
      }
    }
  },
};
