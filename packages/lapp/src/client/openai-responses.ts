/**
 * OpenAI Responses API adapter.
 *
 * Maps a simple chat input to the Responses API input shape and POSTs
 * `{baseUrl}/responses`. The Responses API uses an `input` field (string or
 * array of input items) rather than `messages`.
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
import { buildAuthHeaders } from "./http.js";

function joinUrl(base: string, suffix: string): string {
  return `${base.replace(/\/+$/, "")}${suffix}`;
}

function buildInputItems(messages: ChatInput["messages"]): Array<Record<string, unknown>> {
  return messages.flatMap((m): Array<Record<string, unknown>> => {
    if (m.role === "system") {
      // System messages are handled separately as instructions.
      return [];
    }
    if (m.role === "tool") {
      if (!m.toolCallId) throw new Error("tool messages require toolCallId for openai-responses");
      return [{
        type: "function_call_output",
        call_id: m.toolCallId,
        output: m.content,
      }];
    }
    if (m.role === "assistant" && m.toolCalls?.length) {
      return [{
        role: "assistant",
        content: m.content,
        tool_calls: m.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: tc.arguments },
        })),
      }];
    }
    return [{ role: m.role, content: m.content }];
  });
}

function parseToolCalls(toolCalls: unknown): ParsedToolCall[] | undefined {
  if (!Array.isArray(toolCalls)) return undefined;
  const out: ParsedToolCall[] = [];
  for (const tc of toolCalls) {
    const rawArgs = typeof tc.function?.arguments === "string" ? tc.function.arguments : "";
    let args: Record<string, unknown> = {};
    let parseError: string | undefined;
    try {
      args = rawArgs ? (JSON.parse(rawArgs) as Record<string, unknown>) : {};
    } catch {
      parseError = "invalid JSON in tool_call arguments";
    }
    out.push({
      id: String(tc.id ?? ""),
      name: String(tc.function?.name ?? ""),
      arguments: args,
      ...(parseError ? { parseError, argumentsRaw: rawArgs } : {}),
    });
  }
  return out.length ? out : undefined;
}

export const openaiResponsesAdapter: ProtocolAdapter = {
  protocol: "openai-responses",

  buildRequest(input: ChatInput, ctx: AdapterContext): AdapterRequest {
    const systemMessages = input.messages.filter((m) => m.role === "system");
    const body: Record<string, unknown> = {
      model: input.model ?? ctx.model,
      input: buildInputItems(input.messages),
      ...(systemMessages.length > 0
        ? { instructions: systemMessages.map((m) => m.content).join("\n\n") }
        : {}),
      ...(typeof input.temperature === "number" ? { temperature: input.temperature } : {}),
      ...(typeof input.maxTokens === "number" ? { max_output_tokens: input.maxTokens } : {}),
      ...(input.tools?.length ? {
        tools: input.tools.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.parameters })),
        ...(input.toolChoice !== undefined ? { tool_choice: input.toolChoice } : {}),
      } : {}),
      ...(input.stream ? { stream: true } : {}),
      ...(input.extra ?? {}),
    };
    return {
      url: joinUrl(ctx.baseUrl, "/responses"),
      method: "POST",
      headers: buildAuthHeaders(ctx),
      body,
      stream: input.stream,
    };
  },

  parseResponse(raw: unknown, ctx: AdapterContext): LappResponse {
    const r = raw as {
      output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }>; call_id?: string; name?: string; arguments?: string }>;
      output_text?: string;
      model?: string;
      status?: string;
      usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
    };
    let text = r.output_text ?? "";
    if (!text && Array.isArray(r.output)) {
      text = r.output
        .flatMap((o) => o.content ?? [])
        .filter((c) => c.type === "output_text" || c.type === "message_output_text")
        .map((c) => c.text ?? "")
        .join("");
    }
    const toolCalls: ParsedToolCall[] | undefined = parseToolCalls(
      r.output?.filter((o) => o.type === "function_call").map((o) => ({
        id: o.call_id ?? "",
        type: "function",
        function: { name: o.name ?? "", arguments: o.arguments ?? "" },
      })),
    );
    return {
      text,
      provider: ctx.providerId,
      model: r.model ?? ctx.model,
      protocol: ctx.protocol,
      finishReason: r.status,
      toolCalls,
      usage: r.usage
        ? {
            inputTokens: r.usage.input_tokens,
            outputTokens: r.usage.output_tokens,
            totalTokens: r.usage.total_tokens,
          }
        : undefined,
      raw,
    };
  },

  async *parseStream(body: ReadableStream<Uint8Array>, ctx: AdapterContext): AsyncIterable<LappStreamEventUnion> {
    const toolCallAcc: Record<string, { id: string; name: string; args: string }> = {};
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
        delta?: string;
        item?: { type?: string; call_id?: string; name?: string; arguments?: string };
        response?: { status?: string; usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number } };
      };

      if (chunk.type === "response.output_text.delta" && typeof chunk.delta === "string") {
        yield { kind: "delta", text: chunk.delta };
      }

      if (chunk.type === "response.output_item.added" && chunk.item?.type === "function_call") {
        // Responses-API: deltas correlate via top-level `item_id`, which equals
        // `item.id` (the function_call output item id, e.g. "fc_123"), NOT
        // `item.call_id` ("call_123"). Key the accumulator by `item.id` so
        // the subsequent `function_call_arguments.delta` lookup hits.
        const id = (chunk.item as { id?: string }).id ?? chunk.item.call_id ?? "";
        toolCallAcc[id] = { id, name: chunk.item.name ?? "", args: chunk.item.arguments ?? "" };
      }

      if (chunk.type === "response.function_call_arguments.delta") {
        // The Responses API correlates delta events via the top-level  field,
        // not `chunk.item.call_id` (which is only present on -output-item.added).
        const id = (chunk as unknown as { item_id?: string }).item_id ?? "";
        if (toolCallAcc[id] && typeof chunk.delta === "string") {
          toolCallAcc[id].args += chunk.delta;
        }
      }

      if (chunk.type === "response.completed" && chunk.response) {
        for (const tc of Object.values(toolCallAcc)) {
          yield { kind: "tool-call", id: tc.id, name: tc.name, arguments: tc.args };
        }
        // Mark flushed so the post-loop truncated-stream flush does not
        // re-emit the same tool calls on a normal completion.
        flushed = true;
        if (chunk.response.usage) {
          yield {
            kind: "usage",
            inputTokens: chunk.response.usage.input_tokens,
            outputTokens: chunk.response.usage.output_tokens,
            totalTokens: chunk.response.usage.total_tokens,
          };
        }
        yield { kind: "finish", reason: chunk.response.status ?? "completed" };
      }
    }

    // In case the provider never sent response.completed (truncated stream),
    // flush any accumulated tool calls. Gated by `flushed` so a normal
    // completion (which already flushed inside the loop) does not re-emit.
    if (!flushed && Object.keys(toolCallAcc).length > 0) {
      for (const tc of Object.values(toolCallAcc)) {
        yield { kind: "tool-call", id: tc.id, name: tc.name, arguments: tc.args };
      }
    }
  },
};
