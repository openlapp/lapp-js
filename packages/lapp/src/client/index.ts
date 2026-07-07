/**
 * LAPP SDK client entrypoint.
 *
 * `createLappClient({ provider, model })` resolves a target (provider + model)
 * from a profile, picks a protocol adapter, and exposes `chat` / `rawChat` /
 * `testConnection` / `stream`. Requests go directly to the provider API; this is
 * a client, not a gateway.
 */

import { resolveSecret } from "../secret/index.js";
import {
  TargetResolutionError,
  UnsupportedProtocolError,
  type LappProfile,
  type LappProvider,
  type ModelEntry,
} from "../types.js";
import type {
  AdapterContext,
  ChatInput,
  ChatMessage,
  LappResponse,
  LappStreamEventUnion,
  ProtocolAdapter,
  ToolDefinition,
} from "./adapter.js";
import { openaiChatCompletionsAdapter } from "./openai-chat.js";
import { openaiResponsesAdapter } from "./openai-responses.js";
import { anthropicMessagesAdapter } from "./anthropic-messages.js";
import { getPrimaryProtocol, getProtocolBaseUrl, mergeProtocolRequestHeaders } from "../protocols.js";
import { redactErrorText, redactRawObject } from "../redact.js";

export type {
  ChatInput,
  ChatMessage,
  LappResponse,
  LappStreamEventUnion,
  ProtocolAdapter,
  AdapterRequest,
  ToolDefinition,
  ParsedToolCall,
} from "./adapter.js";

const ADAPTERS: Record<string, ProtocolAdapter> = {
  "openai-chat-completions": openaiChatCompletionsAdapter,
  "openai-responses": openaiResponsesAdapter,
  "anthropic-messages": anthropicMessagesAdapter,
};

// Re-export the canonical redaction helpers (defined in `../redact.ts`) so
// existing SDK consumers that import them from this module keep working.
export { redactErrorText, redactRawObject } from "../redact.js";

export interface CreateClientOptions {
  /** Profile to read provider/model config from. */
  profile: LappProfile;
  /** Provider id. Required unless a global default exists. */
  provider?: string;
  /** Real model id or alias. Falls back to global default. */
  model?: string;
  /** Resolve secrets from `process.env` (required to actually call a provider). */
  resolveSecrets?: boolean;
  /** Allow providers with no auth config (for local/self-hosted models). */
  allowUnauthenticated?: boolean;
  /** Custom env source (for tests). */
  env?: Record<string, string | undefined>;
  /**
   * Custom fetch implementation (for tests / non-Node runtimes).
   * Default uses global `fetch`.
   */
  fetchImpl?: typeof fetch;
}

export interface TestConnectionResult {
  ok: boolean;
  provider: string;
  model: string;
  protocol: string;
  message?: string;
}

export interface LappClient {
  chat(input: ChatInput): Promise<LappResponse>;
  rawChat(input: ChatInput): Promise<unknown>;
  stream(input: ChatInput): AsyncIterable<LappStreamEventUnion>;
  executeWithTools(
    input: ChatInput,
    tools: ToolDefinition[],
    handlers: Record<string, ToolHandler>,
    options?: ExecuteWithToolsOptions,
  ): Promise<ExecuteWithToolsResult>;
  testConnection(): Promise<TestConnectionResult>;
  readonly providerId: string;
  readonly model: string;
  readonly protocol: string;
}

/**
 * Handler map for `executeWithTools`. Each key matches a tool's `name`; the
 * value receives the parsed arguments and returns either a string (the tool
 * result) or a `Promise<string>`. Throw to surface a tool execution error to
 * the model; the loop catches and converts it to a tool result of
 * `error: <message>`.
 */
export type ToolHandler = (args: Record<string, unknown>) => string | Promise<string>;

export interface ExecuteWithToolsOptions {
  /** Max number of model turns (assistant responses) before giving up. */
  maxTurns?: number;
  /** Provider-native tool choice override forwarded as-is. */
  toolChoice?: unknown;
  /** AbortSignal to cancel mid-loop. */
  signal?: AbortSignal;
}

export interface ExecuteWithToolsResult {
  text: string;
  /** Number of model turns used (>=1, <=maxTurns). */
  turns: number;
  /** Conversation including any tool messages that were appended. */
  messages: import("./adapter.js").ChatMessage[];
}

interface ResolvedTarget {
  provider: LappProvider;
  modelId: string;
  modelEntry?: ModelEntry;
}

function resolveTarget(options: CreateClientOptions): ResolvedTarget {
  const { profile, provider, model } = options;
  let providerId = provider;
  let modelId = model;

  if (!providerId || !modelId) {
    const def = profile.global?.defaultModel;
    if (def && (def.providerId === providerId || !providerId)) {
      if (!providerId) providerId = def.providerId;
      if (!modelId) modelId = def.model;
    }
  }

  if (!providerId) {
    if (profile.providers.length === 0) {
      throw new TargetResolutionError("no providers available in profile");
    }
    const firstEnabled = profile.providers.find((p) => p.config.enabled !== false);
    if (!firstEnabled) {
      throw new TargetResolutionError("no enabled provider available in profile");
    }
    providerId = firstEnabled.config.id;
  }

  const lappProvider = profile.providers.find((p) => p.config.id === providerId);
  if (!lappProvider) {
    throw new TargetResolutionError(`provider not found: ${providerId}`);
  }
  if (lappProvider.config.enabled === false) {
    throw new TargetResolutionError(`provider is disabled: ${providerId}`);
  }

  const protocol = getPrimaryProtocol(lappProvider.config).id;
  if (!ADAPTERS[protocol]) {
    throw new UnsupportedProtocolError(protocol);
  }

  const resolved = resolveModelId(lappProvider, modelId);
  return { provider: lappProvider, modelId: resolved.modelId, modelEntry: resolved.modelEntry };
}

function resolveModelId(
  provider: LappProvider,
  requested: string | undefined,
): { modelId: string; modelEntry?: ModelEntry } {
  if (!requested) {
    const first = provider.models?.models.find((m) => m.enabled !== false);
    if (first) return { modelId: first.id, modelEntry: first };
    throw new TargetResolutionError(
      `no model specified and provider "${provider.config.id}" has no enabled models`,
    );
  }
  const byId = provider.models?.models.find((m) => m.id === requested);
  if (byId) return { modelId: requested, modelEntry: byId };
  const byAlias = provider.models?.models.find(
    (m) => Array.isArray(m.aliases) && m.aliases.includes(requested),
  );
  if (byAlias) return { modelId: byAlias.id, modelEntry: byAlias };
  return { modelId: requested };
}

export class StreamingUnsupportedError extends Error {
  override name = "StreamingUnsupportedError";
  constructor(modelId: string) {
    super(`streaming is not supported by model "${modelId}"`);
    this.name = "StreamingUnsupportedError";
  }
}

export function createLappClient(options: CreateClientOptions): LappClient {
  const { profile, env, fetchImpl, allowUnauthenticated } = options;
  const resolveSecrets = options.resolveSecrets ?? false;
  const target = resolveTarget(options);
  const lappProvider = target.provider;
  const protocolEntry = getPrimaryProtocol(lappProvider.config);
  const protocol = protocolEntry.id;
  const adapter = ADAPTERS[protocol]!;

  /**
   * When the secret is delivered via a query parameter, strip auth-carrying
   * headers and append the secret to the URL so the credential is not
   * transmitted twice — once in the URL and once in a header (which would
   * land in different access logs).
   */
  function applyAuthQueryParam(
    headers: Record<string, string>,
    url: string,
    ctx: AdapterContext,
  ): { headers: Record<string, string>; url: string } {
    if (!ctx.authQueryParam || !ctx.secret) return { headers, url };
    const stripKeys = new Set<string>([
      (ctx.authHeader ?? "authorization").toLowerCase(),
      "authorization",
      "x-api-key",
    ]);
    const stripped: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) {
      if (stripKeys.has(k.toLowerCase())) continue;
      stripped[k] = v;
    }
    const sep = url.includes("?") ? "&" : "?";
    return {
      headers: stripped,
      url: `${url}${sep}${encodeURIComponent(ctx.authQueryParam)}=${encodeURIComponent(ctx.secret)}`,
    };
  }

  const buildContext = (): AdapterContext => {
    const secretResult = resolveSecret(lappProvider.config.auth?.secret, {
      resolve: resolveSecrets,
      env,
    });
    if (!secretResult.ok) {
      if (allowUnauthenticated && secretResult.reason === "unset") {
        // continue with empty secret for local/unauthenticated providers
      } else {
        throw secretResult.error;
      }
    }
    return {
      providerId: lappProvider.config.id,
      protocol,
      baseUrl: getProtocolBaseUrl(lappProvider.config, protocolEntry),
      secret: secretResult.ok ? secretResult.value : "",
      authType: lappProvider.config.auth?.type,
      authHeader: lappProvider.config.auth?.header,
      authQueryParam: lappProvider.config.auth?.queryParam,
      requestHeaders: mergeProtocolRequestHeaders(lappProvider.config, protocolEntry),
      model: target.modelId,
    };
  };

  const doFetch = fetchImpl ?? globalThis.fetch;

  async function send(input: ChatInput): Promise<{ raw: unknown; ctx: AdapterContext; req: ReturnType<ProtocolAdapter["buildRequest"]> }> {
    const ctx = buildContext();
    const req = adapter.buildRequest(input, ctx);
    const { headers, url } = applyAuthQueryParam(req.headers, req.url, ctx);
    const resp = await doFetch(url, {
      method: req.method,
      headers,
      body: JSON.stringify(req.body),
    });
    const text = await resp.text();
    let raw: unknown;
    try {
      raw = text ? JSON.parse(text) : {};
    } catch {
      raw = { _rawText: text };
    }
    if (!resp.ok) {
      const err = new Error(`provider ${ctx.providerId} returned ${resp.status}: ${redactErrorText(text)}`);
      (err as Error & { status?: number }).status = resp.status;
      // Scrub `err.raw` so callers can log/inspect it without leaking
      // credentials echoed in the response body. The redacted copy is
      // structurally identical to the parsed body — only string leaves
      // matching `SECRET_PATTERNS` are replaced with `<redacted>`.
      (err as Error & { raw?: unknown }).raw = redactRawObject(raw);
      throw err;
    }
    return { raw, ctx, req };
  }

  async function* stream(input: ChatInput): AsyncIterable<LappStreamEventUnion> {
    if (!adapter.parseStream) {
      throw new StreamingUnsupportedError(target.modelId);
    }
    const ctx = buildContext();
    const req = adapter.buildRequest({ ...input, stream: true }, ctx);
    const { headers, url } = applyAuthQueryParam(req.headers, req.url, ctx);
    const resp = await doFetch(url, {
      method: req.method,
      headers,
      body: JSON.stringify(req.body),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`provider ${ctx.providerId} returned ${resp.status}: ${redactErrorText(text)}`);
    }

    if (!resp.body) {
      throw new Error(`provider ${ctx.providerId} returned an empty stream body`);
    }

    yield* adapter.parseStream(resp.body, ctx);
  }

  return {
    providerId: lappProvider.config.id,
    model: target.modelId,
    protocol,

    async chat(input: ChatInput): Promise<LappResponse> {
      if (input.stream) {
        // chat() is the non-streaming path; callers wanting deltas should use
        // stream(). Refusing stream:true here keeps chat() a Promise<LappResponse>
        // and prevents accidental body.stream: true leaks from being parsed as a
        // JSON response.
        throw new Error(
          `chat() does not support stream: true; use client.stream() to receive streaming deltas`,
        );
      }
      const { raw, ctx } = await send(input);
      return adapter.parseResponse(raw, ctx);
    },

    async rawChat(input: ChatInput): Promise<unknown> {
      if (input.stream) {
        throw new Error(
          `rawChat() does not support stream: true; use client.stream() to receive streaming deltas`,
        );
      }
      const { raw } = await send(input);
      return raw;
    },

    stream,

    async executeWithTools(
      input: ChatInput,
      tools: ToolDefinition[],
      handlers: Record<string, ToolHandler>,
      options: ExecuteWithToolsOptions = {},
    ): Promise<ExecuteWithToolsResult> {
      const maxTurns = options.maxTurns ?? 8;
      const messages: ChatMessage[] = [...input.messages];
      let turns = 0;
      let lastText = "";
      while (turns < maxTurns) {
        if (options.signal?.aborted) {
          throw new Error("executeWithTools: aborted");
        }
        turns++;
        const { stream: _stream, ...rest } = input;
        const resp = await this.chat({
          ...rest,
          messages,
          tools,
          ...(options.toolChoice !== undefined ? { toolChoice: options.toolChoice } : {}),
        });
        lastText = resp.text;
        const calls = resp.toolCalls ?? [];
        if (calls.length === 0) {
          // Final answer — no more tool calls.
          return { text: lastText, turns, messages };
        }
        // Echo the assistant turn with its tool calls so subsequent requests
        // preserve the model's chosen tool ids + names.
        messages.push({
          role: "assistant",
          content: resp.text,
          toolCalls: calls.map((c) => ({
            id: c.id,
            name: c.name,
            arguments: c.argumentsRaw ?? JSON.stringify(c.arguments),
          })),
        });
        for (const call of calls) {
          const handler = handlers[call.name];
          let result: string;
          if (!handler) {
            result = `error: no handler registered for tool "${call.name}"`;
          } else {
            try {
              result = await handler(call.arguments);
            } catch (err) {
              result = `error: ${(err as Error).message ?? String(err)}`;
            }
          }
          messages.push({
            role: "tool",
            content: result,
            toolCallId: call.id,
            ...(call.name ? { name: call.name } : {}),
          });
        }
      }
      throw new Error(`executeWithTools: exceeded maxTurns (${maxTurns}) without a final answer`);
    },

    async testConnection(): Promise<TestConnectionResult> {
      try {
        const { ctx } = await send({
          messages: [{ role: "user", content: "ping" }],
          maxTokens: 1,
        });
        return { ok: true, provider: ctx.providerId, model: ctx.model, protocol: ctx.protocol };
      } catch (err) {
        return {
          ok: false,
          provider: lappProvider.config.id,
          model: target.modelId,
          protocol,
          message: (err as Error).message,
        };
      }
    },
  };
}

export { UnsupportedProtocolError, TargetResolutionError } from "../types.js";
