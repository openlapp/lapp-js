/**
 * LAPP SDK client entrypoint.
 *
 * `createLappClient({ provider, model })` resolves a target (provider + model)
 * from a profile, picks a protocol adapter, and exposes `chat` / `rawChat` /
 * `testConnection` / `stream`. Requests go directly to the provider API; this is
 * a client, not a gateway.
 */

import { Ajv2020 } from "ajv/dist/2020.js";
import { selectConnection } from "../connection.js";
import {
  CredentialError,
  TargetResolutionError,
  type CredentialResolver,
  type CredentialVault,
  type LappProfile,
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
import { redactErrorText, redactRawObject } from "../redact.js";
import { applyQueryAuth } from "./http.js";
import {
  assertCredentialRequestOrigin,
  createCredentialResolver,
  resolveAuthConfig,
} from "../secret/index.js";

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
  /** Provider id. Must be supplied together with `model`. */
  provider?: string;
  /** Real model id or alias. Must be supplied together with `provider`. */
  model?: string;
  /** Named global default used when provider/model are omitted. Defaults to `chat`. */
  default?: string;
  /** Custom env source (for tests). */
  env?: Record<string, string | undefined>;
  /** Optional Vault implementation, primarily for tests and embedding. */
  vault?: CredentialVault;
  /** Fully custom credential resolver. Takes precedence over env/vault. */
  resolver?: CredentialResolver;
  /**
   * Scrub the credential resolved for each request from successful response
   * objects and stream events. The CLI enables this so stdout cannot echo a
   * Vault credential. SDK callers may leave it disabled to preserve upstream
   * response bytes exactly.
   */
  redactSuccessfulSecrets?: boolean;
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
  /** Stable credential/target error code when the test fails before a response. */
  code?: string;
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

export class StreamingUnsupportedError extends Error {
  override name = "StreamingUnsupportedError";
  constructor(modelId: string) {
    super(`streaming is not supported by model "${modelId}"`);
    this.name = "StreamingUnsupportedError";
  }
}

export function createLappClient(options: CreateClientOptions): LappClient {
  const { profile, env, fetchImpl } = options;
  const hasProvider = options.provider !== undefined;
  const hasModel = options.model !== undefined;
  if (hasProvider !== hasModel) {
    throw new TargetResolutionError("provider and model must be supplied together");
  }
  if (hasProvider && options.default !== undefined) {
    throw new TargetResolutionError("default cannot be combined with provider/model");
  }

  const selector = hasProvider
    ? { providerId: options.provider!, model: options.model! } as const
    : { default: options.default ?? "chat" } as const;
  const plan = selectConnection(profile, selector, {
    supportedProtocols: Object.keys(ADAPTERS),
  });
  const resolver = options.resolver ?? createCredentialResolver({
    ...(env ? { env } : {}),
    ...(options.vault ? { vault: options.vault } : {}),
  });
  const protocol = plan.protocol;
  const adapter = ADAPTERS[protocol]!;
  const doFetch = fetchImpl ?? globalThis.fetch;
  const redactSuccessfulSecrets = options.redactSuccessfulSecrets ?? false;

  async function requestContext(): Promise<{
    ctx: AdapterContext;
    sensitiveValues: string[];
  }> {
    // Resolve immediately before every provider operation. The client never
    // retains a plaintext credential, and a Vault rotation is visible on the
    // next request.
    const auth = await resolveAuthConfig(plan.auth, plan.credentialBinding, { resolver });
    const ctx: AdapterContext = {
      providerId: plan.providerId,
      protocol: plan.protocol,
      baseUrl: plan.baseUrl,
      auth,
      requestHeaders: plan.requestHeaders,
      model: plan.modelId,
    };
    return {
      ctx,
      sensitiveValues: ctx.auth.type === "none" ? [] : [ctx.auth.secret],
    };
  }

  function redactThrown(error: unknown, sensitiveValues: readonly string[]): Error {
    const source = error instanceof Error ? error : new Error(String(error));
    if (source instanceof CredentialError) {
      return new CredentialError(
        source.code,
        redactErrorText(source.message, sensitiveValues),
      );
    }
    const redacted = new Error(redactErrorText(source.message, sensitiveValues));
    redacted.name = source.name;
    if (typeof error === "object" && error !== null && "code" in error) {
      (redacted as Error & { code?: unknown }).code = (error as { code?: unknown }).code;
    }
    if (typeof error === "object" && error !== null && "status" in error) {
      (redacted as Error & { status?: unknown }).status = (error as { status?: unknown }).status;
    }
    if (typeof error === "object" && error !== null && "raw" in error) {
      (redacted as Error & { raw?: unknown }).raw = redactRawObject(
        (error as { raw?: unknown }).raw,
        sensitiveValues,
      );
    }
    return redacted;
  }

  async function fetchProvider(
    url: string,
    init: RequestInit,
    sensitiveValues: readonly string[],
  ): Promise<Response> {
    try {
      return await doFetch(url, init);
    } catch (error) {
      throw redactThrown(error, sensitiveValues);
    }
  }

  async function readResponseText(
    response: Response,
    sensitiveValues: readonly string[],
  ): Promise<string> {
    try {
      return await response.text();
    } catch (error) {
      throw redactThrown(error, sensitiveValues);
    }
  }

  function parseResponseText(text: string): unknown {
    try {
      return text ? JSON.parse(text) : {};
    } catch {
      return { _rawText: text };
    }
  }

  function providerHttpError(
    ctx: AdapterContext,
    response: Response,
    text: string,
    raw: unknown,
    sensitiveValues: readonly string[],
  ): Error {
    const error = new Error(
      `provider ${ctx.providerId} returned ${response.status}: ${redactErrorText(text, sensitiveValues)}`,
    );
    (error as Error & { status?: number }).status = response.status;
    (error as Error & { raw?: unknown }).raw = redactRawObject(raw, sensitiveValues);
    return error;
  }

  async function send(input: ChatInput): Promise<{
    raw: unknown;
    ctx: AdapterContext;
    sensitiveValues: string[];
  }> {
    input.signal?.throwIfAborted();
    const { ctx, sensitiveValues } = await requestContext();
    try {
      const req = adapter.buildRequest(input, ctx);
      if (plan.credentialBinding) {
        assertCredentialRequestOrigin(plan.credentialBinding, req.url);
      }
      const url = applyQueryAuth(ctx, req.url);
      const resp = await fetchProvider(url, {
        method: req.method,
        headers: req.headers,
        body: JSON.stringify(req.body),
        redirect: "error",
        signal: input.signal,
      }, sensitiveValues);
      const text = await readResponseText(resp, sensitiveValues);
      const raw = parseResponseText(text);
      if (!resp.ok) {
        throw providerHttpError(ctx, resp, text, raw, sensitiveValues);
      }
      return { raw, ctx, sensitiveValues };
    } catch (error) {
      throw redactThrown(error, sensitiveValues);
    }
  }

  async function* stream(input: ChatInput): AsyncIterable<LappStreamEventUnion> {
    if (!adapter.parseStream) {
      throw new StreamingUnsupportedError(plan.modelId);
    }
    input.signal?.throwIfAborted();
    const { ctx, sensitiveValues } = await requestContext();
    try {
      const req = adapter.buildRequest({ ...input, stream: true }, ctx);
      if (plan.credentialBinding) {
        assertCredentialRequestOrigin(plan.credentialBinding, req.url);
      }
      const url = applyQueryAuth(ctx, req.url);
      const resp = await fetchProvider(url, {
        method: req.method,
        headers: req.headers,
        body: JSON.stringify(req.body),
        redirect: "error",
        signal: input.signal,
      }, sensitiveValues);

      if (!resp.ok) {
        const text = await readResponseText(resp, sensitiveValues);
        throw providerHttpError(ctx, resp, text, parseResponseText(text), sensitiveValues);
      }

      if (!resp.body) {
        throw new Error(`provider ${ctx.providerId} returned an empty stream body`);
      }

      for await (const event of adapter.parseStream(resp.body, ctx)) {
        yield redactSuccessfulSecrets || event.kind === "error"
          ? redactRawObject(event, sensitiveValues) as LappStreamEventUnion
          : event;
      }
    } catch (error) {
      throw redactThrown(error, sensitiveValues);
    }
  }

  return {
    providerId: plan.providerId,
    model: plan.modelId,
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
      const { raw, ctx, sensitiveValues } = await send(input);
      try {
        const response = adapter.parseResponse(raw, ctx);
        return redactSuccessfulSecrets
          ? redactRawObject(response, sensitiveValues) as LappResponse
          : response;
      } catch (error) {
        throw redactThrown(error, sensitiveValues);
      }
    },

    async rawChat(input: ChatInput): Promise<unknown> {
      if (input.stream) {
        throw new Error(
          `rawChat() does not support stream: true; use client.stream() to receive streaming deltas`,
        );
      }
      const { raw, ctx, sensitiveValues } = await send(input);
      try {
        adapter.parseResponse(raw, ctx);
      } catch (error) {
        throw redactThrown(error, sensitiveValues);
      }
      return redactSuccessfulSecrets ? redactRawObject(raw, sensitiveValues) : raw;
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
      const ajv = new Ajv2020({ allErrors: true, strict: false });
      const validators = new Map(
        tools.map((tool) => [tool.name, ajv.compile(tool.parameters)] as const),
      );
      let turns = 0;
      let lastText = "";
      while (turns < maxTurns) {
        options.signal?.throwIfAborted();
        turns++;
        const { stream: _stream, ...rest } = input;
        const resp = await this.chat({
          ...rest,
          messages,
          tools,
          signal: options.signal ?? input.signal,
          ...(options.toolChoice !== undefined ? { toolChoice: options.toolChoice } : {}),
        });
        lastText = resp.text;
        const calls = resp.toolCalls ?? [];
        if (calls.length === 0) {
          // Final answer — no more tool calls.
          messages.push({ role: "assistant", content: lastText });
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
          const validator = validators.get(call.name);
          let result: string;
          if (call.parseError) {
            result = `error: invalid arguments for tool "${call.name}": ${call.parseError}`;
          } else if (!validator) {
            result = `error: unknown tool "${call.name}"`;
          } else if (!validator(call.arguments)) {
            const details = ajv.errorsText(validator.errors, { separator: "; " });
            result = `error: invalid arguments for tool "${call.name}": ${details}`;
          } else if (!handler) {
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
        const { raw, ctx, sensitiveValues } = await send({
          messages: [{ role: "user", content: "ping" }],
          maxTokens: 1,
        });
        try {
          adapter.parseResponse(raw, ctx);
        } catch (error) {
          throw redactThrown(error, sensitiveValues);
        }
        return { ok: true, provider: ctx.providerId, model: ctx.model, protocol: ctx.protocol };
      } catch (err) {
        const redacted = redactThrown(err, []);
        const code = "code" in redacted && typeof (redacted as Error & { code?: unknown }).code === "string"
          ? (redacted as Error & { code: string }).code
          : undefined;
        return {
          ok: false,
          provider: plan.providerId,
          model: plan.modelId,
          protocol,
          ...(code ? { code } : {}),
          message: redacted.message,
        };
      }
    },
  };
}

export { TargetResolutionError } from "../types.js";
