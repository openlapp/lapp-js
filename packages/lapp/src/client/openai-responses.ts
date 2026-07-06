/**
 * OpenAI Responses API adapter.
 *
 * Maps a simple chat input to the Responses API input shape and POSTs
 * `{baseUrl}/responses`. The Responses API uses an `input` field (string or
 * array of input items) rather than `messages`.
 */

import type { AdapterContext, AdapterRequest, ChatInput, LappResponse, ProtocolAdapter } from "./adapter.js";

function joinUrl(base: string, suffix: string): string {
  return `${base.replace(/\/+$/, "")}${suffix}`;
}

function buildHeaders(ctx: AdapterContext): Record<string, string> {
  // Strip auth-carrying keys from requestHeaders before spreading so a
  // user-supplied header with a different case (e.g. "authorization" vs
  // the adapter's default "Authorization") does NOT produce two distinct
  // headers — see anthropic-messages.buildHeaders for the full rationale.
  const authStrip = new Set(["authorization", "x-api-key"]);
  const cleanRequestHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(ctx.requestHeaders ?? {})) {
    if (authStrip.has(k.toLowerCase())) continue;
    cleanRequestHeaders[k] = v;
  }
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...cleanRequestHeaders,
  };
  const headerName = ctx.authHeader ?? "Authorization";
  const authType = ctx.authType ?? "bearer";
  if (authType === "bearer") {
    headers[headerName] = `Bearer ${ctx.secret}`;
  } else if (authType === "custom-header") {
    headers[headerName] = ctx.secret;
  } else {
    headers[headerName] = `Bearer ${ctx.secret}`;
  }
  return headers;
}

export const openaiResponsesAdapter: ProtocolAdapter = {
  protocol: "openai-responses",

  buildRequest(input: ChatInput, ctx: AdapterContext): AdapterRequest {
    if (input.stream) {
      // v1 targets the non-streaming Responses API; see openai-chat for the
      // rationale. Rejecting keeps the contract consistent across adapters.
      throw new Error(
        "openai-responses: streaming is not supported in v1 (non-streaming endpoint only)",
      );
    }
    // The Responses API uses top-level `instructions` for system content;
    // `input` items have no `role: "system"`. Each role maps to a different
    // content-block type — assistant uses `output_text`, tool results use
    // `function_call_output` with `call_id` and `output`. Sending a tool
    // result as `input_text` (or vice versa) gets the request rejected.
    //
    // The Responses API also rejects `role: "assistant"` items in `input`
    // (assistant turns belong in `output`, chained via previous_response_id);
    // we map them to `role: "developer"` with the same content so the
    // provider sees the conversation context verbatim. This loses the
    // strict role distinction but produces a valid, accepted request.
    const systemMessages = input.messages.filter((m) => m.role === "system");
    const convoMessages = input.messages.filter((m) => m.role !== "system");
    const inputItems = convoMessages.map((m) => {
      if (m.role === "tool") {
        // ChatMessage has no field to carry the assistant's emitted tool_call,
        // so a multi-turn tool loop (assistant tool_call → tool result) cannot
        // be reconstructed: the function_call_output below would reference a
        // call_id never sent. Reject explicitly so callers get a clear error
        // instead of an upstream 400.
        throw new Error(
          "openai-responses: tool messages are not supported in v1 (ChatMessage cannot represent assistant tool_calls required for multi-turn tool use)",
        );
      }
      if (m.role === "assistant") {
        return { role: "developer", content: [{ type: "input_text", text: m.content }] };
      }
      // user (and any other non-system role): input_text
      return { role: m.role, content: [{ type: "input_text", text: m.content }] };
    });
    const body: Record<string, unknown> = {
      model: input.model ?? ctx.model,
      input: inputItems,
      ...(systemMessages.length > 0
        ? { instructions: systemMessages.map((m) => m.content).join("\n\n") }
        : {}),
      ...(typeof input.temperature === "number" ? { temperature: input.temperature } : {}),
      ...(typeof input.maxTokens === "number" ? { max_output_tokens: input.maxTokens } : {}),
      ...(input.extra ?? {}),
    };
    return {
      url: joinUrl(ctx.baseUrl, "/responses"),
      method: "POST",
      headers: buildHeaders(ctx),
      body,
    };
  },

  parseResponse(raw: unknown, ctx: AdapterContext): LappResponse {
    const r = raw as {
      output?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
      output_text?: string;
      model?: string;
      status?: string;
      usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
    };
    // Prefer output_text if present; otherwise join text-type content blocks.
    let text = r.output_text ?? "";
    if (!text && Array.isArray(r.output)) {
      text = r.output
        .flatMap((o) => o.content ?? [])
        .filter((c) => c.type === "output_text" || c.type === "message_output_text")
        .map((c) => c.text ?? "")
        .join("");
    }
    return {
      text,
      provider: ctx.providerId,
      model: r.model ?? ctx.model,
      protocol: ctx.protocol,
      finishReason: r.status,
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
};