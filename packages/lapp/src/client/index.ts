/**
 * Client SDK entrypoint.
 *
 * `createLappClient({ provider, model })` resolves a target (provider + model)
 * from a profile, picks the protocol adapter, and exposes `chat` / `rawChat` /
 * `testConnection`. Requests go directly to the provider API; this is a client,
 * not a gateway.
 */

import { resolveSecret } from "../secret/index.js";
import {
  TargetResolutionError,
  UnsupportedProtocolError,
  type LappProfile,
  type LappProvider,
} from "../types.js";
import type { AdapterContext, ChatInput, LappResponse, ProtocolAdapter } from "./adapter.js";
import { openaiChatCompletionsAdapter } from "./openai-chat.js";
import { openaiResponsesAdapter } from "./openai-responses.js";
import { anthropicMessagesAdapter } from "./anthropic-messages.js";

export type { ChatInput, ChatMessage, LappResponse, ProtocolAdapter, AdapterRequest } from "./adapter.js";

const ADAPTERS: Record<string, ProtocolAdapter> = {
  "openai-chat-completions": openaiChatCompletionsAdapter,
  "openai-responses": openaiResponsesAdapter,
  "anthropic-messages": anthropicMessagesAdapter,
};

// Common secret shapes that may appear in echoed provider error bodies. This
// is a defense-in-depth layer alongside the SDK's scheme-aware `redactSecret`:
// the error text we embed in Error.message is untrusted (provider-controlled).
const SECRET_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{8,}\b/g,
  /\bsk-ant-[A-Za-z0-9_-]{8,}\b/g,
  /\bsk-or-[A-Za-z0-9_-]{8,}\b/g,
  /\bgho_[A-Za-z0-9]{8,}\b/g,
  /\bghp_[A-Za-z0-9]{8,}\b/g,
  /\bxai-[A-Za-z0-9]{8,}\b/g,
  /\bAIza[0-9A-Za-z_-]{8,}\b/g,
  /Bearer\s+[A-Za-z0-9._-]{8,}/g,
];

function redactErrorText(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) out = out.replace(re, "<redacted>");
  return out;
}

export interface CreateClientOptions {
  /** Profile to read provider/model config from. */
  profile: LappProfile;
  /** Provider id. Required unless a global default exists. */
  provider?: string;
  /** Real model id or alias. Falls back to global default. */
  model?: string;
  /** Resolve secrets from `process.env` (required to actually call a provider). */
  resolveSecrets?: boolean;
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
  testConnection(): Promise<TestConnectionResult>;
  readonly providerId: string;
  readonly model: string;
  readonly protocol: string;
}

function resolveModelId(provider: LappProvider, requested: string | undefined): string {
  if (!requested) {
    // Fall back to first enabled model.
    const first = provider.models?.models.find((m) => m.enabled !== false);
    if (first) return first.id;
    throw new TargetResolutionError(
      `no model specified and provider "${provider.config.id}" has no enabled models`,
    );
  }
  // Direct match on id.
  if (provider.models?.models.some((m) => m.id === requested)) return requested;
  // Alias match.
  const byAlias = provider.models?.models.find((m) => Array.isArray(m.aliases) && m.aliases.includes(requested));
  if (byAlias) return byAlias.id;
  // Allow the requested string to pass through as a model id even if not
  // listed (providers accept arbitrary model ids at call time).
  return requested;
}

/**
 * Create a LAPP client bound to a specific provider/model.
 */
export function createLappClient(options: CreateClientOptions): LappClient {
  const { profile, provider, model, env, fetchImpl } = options;
  const resolveSecrets = options.resolveSecrets ?? false;

  let providerId = provider;
  let modelId = model;

  if (!providerId || !modelId) {
    // If the caller supplied provider but not model, take both provider and
    // model from the global default — a foreign model id paired with a
    // caller-supplied provider would be sent to the wrong provider's API.
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
    // Prefer the first ENABLED provider; a disabled one would just throw on
    // the enabled-check below and surface a confusing 'provider is disabled'
    // error when the caller did not name a provider at all.
    const firstEnabled = profile.providers.find((p) => p.config.enabled !== false);
    if (!firstEnabled) {
      // Every provider is disabled. Falling through to providers[0] would
      // surface a misleading "provider is disabled" error for a provider the
      // caller never named; say so plainly instead.
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

  const protocol = lappProvider.config.protocol;
  const adapterMaybe = ADAPTERS[protocol];
  if (!adapterMaybe) {
    throw new UnsupportedProtocolError(protocol);
  }
  const adapter: ProtocolAdapter = adapterMaybe;

  const resolvedModel = resolveModelId(lappProvider, modelId);

  const buildContext = (): AdapterContext => {
    const secretResult = resolveSecret(lappProvider.config.auth?.secret, {
      resolve: resolveSecrets,
      env,
    });
    if (!secretResult.ok) {
      // Fail fast: do not substitute a placeholder. Sending a literal
      // "<unresolved>" (or, with authQueryParam, appending it as a query
      // credential) would silently transmit a bogus value to the provider.
      // Callers that want build-only behavior should set resolveSecrets:true
      // and supply the env, or call resolveSecret themselves first.
      throw secretResult.error;
    }
    return {
      providerId: lappProvider.config.id,
      protocol,
      baseUrl: lappProvider.config.baseUrl,
      secret: secretResult.value,
      authType: lappProvider.config.auth?.type,
      authHeader: lappProvider.config.auth?.header,
      authQueryParam: lappProvider.config.auth?.queryParam,
      requestHeaders: lappProvider.config.requestHeaders,
      model: resolvedModel,
    };
  };

  const doFetch = fetchImpl ?? globalThis.fetch;

  async function send(input: ChatInput): Promise<{ raw: unknown; ctx: AdapterContext; req: ReturnType<ProtocolAdapter["buildRequest"]> }> {
    const ctx = buildContext();
    const req = adapter.buildRequest(input, ctx);
    let headers = req.headers;
    let url = req.url;
    if (ctx.authQueryParam) {
      // When the secret is delivered via a query parameter, suppress any
      // header that carries the same secret so the credential is not
      // transmitted twice — once in the URL and once in a header (which
      // would land in different access logs). The strip set covers both
      // the user-configured authHeader and the adapter's default header
      // name (x-api-key for anthropic, Authorization for openai), plus
      // the case-insensitive variant, so an anthropic provider with
      // authQueryParam set and no authHeader doesn't double-leak the
      // secret in both the query string and the x-api-key header.
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
      headers = stripped;
      // Also URL-encode the param name — a value like "api key" or
      // "a&b" would otherwise produce a malformed URL.
      const sep = url.includes("?") ? "&" : "?";
      url = `${url}${sep}${encodeURIComponent(ctx.authQueryParam)}=${encodeURIComponent(ctx.secret)}`;
    }
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
      // Redact the response body before embedding it in the error message: a
      // provider that echoes the request or includes a stack trace could leak
      // the resolved secret. redactSecret is the canonical scheme-aware
      // redaction; SECRET_PATTERNS here catch unprefixed key shapes that may
      // appear in error bodies.
      const err = new Error(`provider ${ctx.providerId} returned ${resp.status}: ${redactErrorText(text)}`);
      (err as Error & { status?: number }).status = resp.status;
      (err as Error & { raw?: unknown }).raw = raw;
      throw err;
    }
    return { raw, ctx, req };
  }

  return {
    providerId: lappProvider.config.id,
    model: resolvedModel,
    protocol,

    async chat(input: ChatInput): Promise<LappResponse> {
      const { raw, ctx } = await send(input);
      return adapter.parseResponse(raw, ctx);
    },

    async rawChat(input: ChatInput): Promise<unknown> {
      const { raw } = await send(input);
      return raw;
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
          model: resolvedModel,
          protocol,
          message: (err as Error).message,
        };
      }
    },
  };
}

export { UnsupportedProtocolError, TargetResolutionError } from "../types.js";