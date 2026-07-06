/**
 * Anthropic Messages adapter.
 *
 * POSTs `{baseUrl}/v1/messages` with `x-api-key` + `anthropic-version` headers.
 * Maps system messages to the top-level `system` field, user/assistant/tool
 * messages to the `messages` array.
 */

import type { AdapterContext, AdapterRequest, ChatInput, LappResponse, ProtocolAdapter } from "./adapter.js";

function joinUrl(base: string, suffix: string): string {
  // Anthropic's API path is /v1/messages. We always include /v1 — but if the
  // user's baseUrl already ends in /v1, we drop the duplicate /v1 from the
  // suffix to avoid /v1/v1/messages. The user's baseUrl controls whether
  // /v1 is in the base or in the path; both are documented valid forms.
  const trimmed = base.replace(/\/+$/, "");
  // Only dedup when the base's ONLY trailing path component is "v1", so an
  // Anthropic-compatible gateway mounted at "/openai/v1" still gets the /v1
  // segment of the suffix appended. Without this check, base
  // "https://gateway/openai/v1" + suffix "/v1/messages" became
  // "https://gateway/openai/messages" (404).
  const lastSeg = trimmed.split("/").pop() ?? "";
  let normalizedSuffix = suffix;
  if (lastSeg === "v1" && suffix.startsWith("/v1")) {
    normalizedSuffix = suffix.replace(/^\/v1/, "");
  }
  return `${trimmed}${normalizedSuffix.startsWith("/") ? normalizedSuffix : `/${normalizedSuffix}`}`;
}

function buildHeaders(ctx: AdapterContext): Record<string, string> {
  // Strip auth-carrying keys from requestHeaders before spreading so a
  // user-supplied header with a different case (e.g. "X-Api-Key" vs the
  // adapter's default "x-api-key") does NOT produce two distinct
  // headers in the final object — JS object keys are case-sensitive, so
  // requestHeaders["X-Api-Key"] and headers["x-api-key"] would otherwise
  // both be sent. Case-insensitive match is the right rule.
  const authStrip = new Set(["authorization", "x-api-key"]);
  const cleanRequestHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(ctx.requestHeaders ?? {})) {
    if (authStrip.has(k.toLowerCase())) continue;
    cleanRequestHeaders[k] = v;
  }
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "anthropic-version": "2023-06-01",
    ...cleanRequestHeaders,
  };
  const header = (ctx.authHeader ?? "x-api-key").toLowerCase();
  if (header === "authorization") {
    headers["Authorization"] = ctx.secret.startsWith("Bearer ")
      ? ctx.secret
      : `Bearer ${ctx.secret}`;
  } else {
    headers[ctx.authHeader ?? "x-api-key"] = ctx.secret;
  }
  return headers;
}

export const anthropicMessagesAdapter: ProtocolAdapter = {
  protocol: "anthropic-messages",

  buildRequest(input: ChatInput, ctx: AdapterContext): AdapterRequest {
    const systemMessages = input.messages.filter((m) => m.role === "system");
    // Tool messages from the caller are tool results. The Anthropic API
    // requires these to be sent as `role: "user"` with a content block of
    // type `tool_result` that references the original tool_use_id. The
    // ChatMessage type advertises `role: "tool"` and `toolCallId` for
    // exactly this purpose — without the conversion, Anthropic returns 400.
    const convoMessages = input.messages
      .filter((m) => m.role !== "system")
      .flatMap((m): Array<{ role: string; content: unknown }> => {
        if (m.role === "tool") {
          if (!m.toolCallId) {
            throw new Error("tool messages require toolCallId for anthropic-messages");
          }
          return [{
            role: "user",
            content: [{ type: "tool_result", tool_use_id: m.toolCallId, content: m.content }],
          }];
        }
        return [{ role: m.role, content: m.content }];
      });
    const body: Record<string, unknown> = {
      model: input.model ?? ctx.model,
      messages: convoMessages,
      ...(systemMessages.length > 0
        ? { system: systemMessages.map((m) => m.content).join("\n\n") }
        : {}),
      ...(typeof input.maxTokens === "number" ? { max_tokens: input.maxTokens } : {}),
      ...(typeof input.temperature === "number" ? { temperature: input.temperature } : {}),
      ...(input.extra ?? {}),
    };
    return {
      url: joinUrl(ctx.baseUrl, "/v1/messages"),
      method: "POST",
      headers: buildHeaders(ctx),
      body,
    };
  },

  parseResponse(raw: unknown, ctx: AdapterContext): LappResponse {
    const r = raw as {
      content?: Array<{ type?: string; text?: string }>;
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
};