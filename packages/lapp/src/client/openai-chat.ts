/**
 * OpenAI Chat Completions adapter.
 *
 * POSTs `{baseUrl}/chat/completions` with a bearer token. The base URL is used
 * verbatim — the SDK never auto-appends `/v1` (per spec URL Handling). Many
 * OpenAI-compatible providers already include `/v1` in their `baseUrl`.
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
    // Bearer auth always uses `Bearer <secret>` regardless of the header name.
    headers[headerName] = `Bearer ${ctx.secret}`;
  } else if (authType === "custom-header") {
    headers[headerName] = ctx.secret;
  } else {
    // Unknown auth type — fall back to bearer to match the common case.
    headers[headerName] = `Bearer ${ctx.secret}`;
  }
  return headers;
}

export const openaiChatCompletionsAdapter: ProtocolAdapter = {
  protocol: "openai-chat-completions",

  buildRequest(input: ChatInput, ctx: AdapterContext): AdapterRequest {
    if (input.stream) {
      // v1 uses the non-streaming chat completions endpoint. Silently
      // forwarding stream:true would return an SSE body parseResponse can't
      // parse, yielding an empty LappResponse with no error. Reject so the
      // caller gets a clear failure (ChatInput.stream notes adapters may
      // reject).
      throw new Error(
        "openai-chat-completions: streaming is not supported in v1 (non-streaming endpoint only)",
      );
    }
    const body: Record<string, unknown> = {
      model: input.model ?? ctx.model,
      messages: input.messages.map((m) => {
        if (m.role === "tool") {
          // ChatMessage has no field to carry the assistant's emitted
          // tool_call, so a multi-turn tool loop (assistant tool_call →
          // tool result) cannot be reconstructed: the tool message below
          // would reference a tool_call_id never sent. The openai-responses
          // adapter rejects tool messages for the same reason; we do the
          // same here so the contract is consistent across protocols and
          // the caller gets a clear error instead of an upstream 400.
          throw new Error(
            "openai-chat-completions: tool messages are not supported in v1 (ChatMessage cannot represent assistant tool_calls required for multi-turn tool use)",
          );
        }
        return { role: m.role, content: m.content };
      }),
      ...(typeof input.temperature === "number" ? { temperature: input.temperature } : {}),
      ...(typeof input.maxTokens === "number" ? { max_tokens: input.maxTokens } : {}),
      ...(input.extra ?? {}),
    };
    return {
      url: joinUrl(ctx.baseUrl, "/chat/completions"),
      method: "POST",
      headers: buildHeaders(ctx),
      body,
    };
  },

  parseResponse(raw: unknown, ctx: AdapterContext): LappResponse {
    const r = raw as {
      choices?: Array<{ message?: { content?: string }, finish_reason?: string }>;
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
};