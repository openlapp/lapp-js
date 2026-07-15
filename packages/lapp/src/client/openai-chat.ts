/**
 * OpenAI Chat Completions adapter.
 *
 * POSTs `{baseUrl}/chat/completions` with the resolved profile auth. The base URL is used
 * verbatim — the SDK never auto-appends `/v1` (per spec URL Handling). Many
 * OpenAI-compatible providers already include `/v1` in their `baseUrl`.
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
import { assertSafeExtra, isRecord, parseToolArguments } from "./adapter.js";
import { parseSse } from "./sse.js";
import { appendUrlPath, buildAuthHeaders } from "./http.js";

function parseToolCalls(toolCalls: unknown): ParsedToolCall[] | undefined {
  if (!Array.isArray(toolCalls)) return undefined;
  const out: ParsedToolCall[] = [];
  for (const tc of toolCalls) {
    if (
      !isRecord(tc)
      || tc.type !== "function"
      || typeof tc.id !== "string"
      || !isRecord(tc.function)
      || typeof tc.function.name !== "string"
      || typeof tc.function.arguments !== "string"
    ) {
      throw new Error("invalid openai-chat-completions response");
    }
    const rawArgs = tc.function.arguments;
    const parsed = parseToolArguments(rawArgs);
    out.push({
      id: String(tc.id ?? ""),
      name: String(tc.function.name ?? ""),
      ...parsed,
    });
  }
  return out.length ? out : undefined;
}

export const openaiChatCompletionsAdapter: ProtocolAdapter = {
  protocol: "openai-chat-completions",

  buildRequest(input: ChatInput, ctx: AdapterContext): AdapterRequest {
    assertSafeExtra(input.extra);
    const body: Record<string, unknown> = {
      model: ctx.model,
      messages: input.messages.map((m) => {
        if (m.role === "tool") {
          return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
        }
        if (m.role === "assistant" && m.toolCalls?.length) {
          return {
            role: "assistant",
            content: m.content,
            tool_calls: m.toolCalls.map((tc) => ({
              id: tc.id,
              type: "function",
              function: { name: tc.name, arguments: tc.arguments },
            })),
          };
        }
        return { role: m.role, content: m.content };
      }),
      ...(typeof input.temperature === "number" ? { temperature: input.temperature } : {}),
      ...(typeof input.maxTokens === "number" ? { max_tokens: input.maxTokens } : {}),
      ...(input.tools?.length ? {
        tools: input.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } })),
        ...(input.toolChoice !== undefined ? { tool_choice: input.toolChoice } : {}),
      } : {}),
      ...(input.stream ? { stream: true } : {}),
      ...(input.extra ?? {}),
    };
    return {
      url: appendUrlPath(ctx.baseUrl, "/chat/completions"),
      method: "POST",
      headers: buildAuthHeaders(ctx),
      body,
      stream: input.stream,
    };
  },

  parseResponse(raw: unknown, ctx: AdapterContext): LappResponse {
    if (!isRecord(raw) || !Array.isArray(raw.choices) || raw.choices.length === 0) {
      throw new Error("invalid openai-chat-completions response");
    }
    const firstChoice = raw.choices[0];
    if (!isRecord(firstChoice) || !isRecord(firstChoice.message)) {
      throw new Error("invalid openai-chat-completions response");
    }
    const message = firstChoice.message;
    if (!(typeof message.content === "string" || message.content === null || Array.isArray(message.tool_calls))) {
      throw new Error("invalid openai-chat-completions response");
    }
    if (raw.model !== undefined && typeof raw.model !== "string") {
      throw new Error("invalid openai-chat-completions response");
    }
    if (firstChoice.finish_reason !== undefined
      && firstChoice.finish_reason !== null
      && typeof firstChoice.finish_reason !== "string") {
      throw new Error("invalid openai-chat-completions response");
    }
    if (raw.usage !== undefined && (
      !isRecord(raw.usage)
      || [raw.usage.prompt_tokens, raw.usage.completion_tokens, raw.usage.total_tokens]
        .some((value) => value !== undefined && typeof value !== "number")
    )) {
      throw new Error("invalid openai-chat-completions response");
    }
    const r = raw as {
      choices?: Array<{
        message?: { content?: string; tool_calls?: unknown };
        finish_reason?: string;
      }>;
      model?: string;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };
    const choice = r.choices?.[0];
    const text = choice?.message?.content ?? "";
    return {
      text,
      provider: ctx.providerId,
      model: r.model ?? ctx.model,
      protocol: ctx.protocol,
      finishReason: choice?.finish_reason,
      toolCalls: parseToolCalls(choice?.message?.tool_calls),
      usage: r.usage
        ? {
            inputTokens: r.usage.prompt_tokens,
            outputTokens: r.usage.completion_tokens,
            totalTokens: r.usage.total_tokens,
          }
        : undefined,
      raw,
    };
  },

  async *parseStream(body: ReadableStream<Uint8Array>, ctx: AdapterContext): AsyncIterable<LappStreamEventUnion> {
    const toolCallAcc: Record<number, { id: string; name: string; args: string }> = {};

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
        choices?: Array<{
          delta?: {
            content?: string;
            tool_calls?: Array<{
              index?: number;
              id?: string;
              function?: { name?: string; arguments?: string };
            }>;
          };
          finish_reason?: string;
        }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
      };

      const delta = chunk.choices?.[0]?.delta;
      if (delta?.content) {
        yield { kind: "delta", text: delta.content };
      }

      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          if (!toolCallAcc[idx]) {
            toolCallAcc[idx] = { id: tc.id ?? "", name: tc.function?.name ?? "", args: "" };
          }
          if (tc.function?.arguments) {
            toolCallAcc[idx].args += tc.function.arguments;
          }
        }
      }

      const finish = chunk.choices?.[0]?.finish_reason;
      if (finish) {
        for (const idx of Object.keys(toolCallAcc).map(Number).sort((a, b) => a - b)) {
          const tc = toolCallAcc[idx]!;
          yield { kind: "tool-call", id: tc.id, name: tc.name, arguments: tc.args };
        }
        // Mark flushed so the post-loop truncated-stream flush does not re-emit
        // the same tool calls on a normal completion.
        flushed = true;
        yield { kind: "finish", reason: finish };
      }

      if (chunk.usage) {
        yield {
          kind: "usage",
          inputTokens: chunk.usage.prompt_tokens,
          outputTokens: chunk.usage.completion_tokens,
          totalTokens: chunk.usage.total_tokens,
        };
      }
    }

    // In case the provider never sent a finish_reason (truncated stream),
    // flush accumulated tool calls. Gated by `flushed` so a normal completion
    // (which already flushed inside the loop) does not re-emit duplicates.
    if (!flushed) {
      for (const idx of Object.keys(toolCallAcc).map(Number).sort((a, b) => a - b)) {
        const tc = toolCallAcc[idx]!;
        yield { kind: "tool-call", id: tc.id, name: tc.name, arguments: tc.args };
      }
    }
  },
};
