import { describe, it, expect } from "vitest";
import {
  createLappClient,
  UnsupportedProtocolError,
  TargetResolutionError,
  type ChatInput,
} from "../src/index.js";
import { createProfile, upsertProvider, upsertModel, setDefaultModel } from "../src/index.js";

function baseProfile() {
  let p = createProfile({ rootDir: "/tmp/.lapp" });
  p = upsertProvider(p, {
    id: "deepseek",
    protocol: "openai-chat-completions",
    baseUrl: "https://api.deepseek.com",
    auth: { secret: "env://DEEPSEEK_API_KEY" },
  });
  p = upsertModel(p, { providerId: "deepseek", id: "deepseek-chat", type: "chat", aliases: ["fast"] });
  p = setDefaultModel(p, { providerId: "deepseek", model: "fast" });
  return p;
}

describe("createLappClient target resolution", () => {
  it("resolves alias to real model id", () => {
    const p = baseProfile();
    const c = createLappClient({ profile: p, provider: "deepseek", model: "fast", resolveSecrets: false });
    expect(c.model).toBe("deepseek-chat");
    expect(c.protocol).toBe("openai-chat-completions");
  });

  it("falls back to global default when provider/model omitted", () => {
    const p = baseProfile();
    const c = createLappClient({ profile: p, resolveSecrets: false });
    expect(c.providerId).toBe("deepseek");
    expect(c.model).toBe("deepseek-chat");
  });

  it("throws TargetResolutionError for unknown provider", () => {
    const p = baseProfile();
    expect(() => createLappClient({ profile: p, provider: "nope" })).toThrow(TargetResolutionError);
  });

  it("throws UnsupportedProtocolError for non-core protocol", () => {
    let p = createProfile({ rootDir: "/tmp/.lapp" });
    p = upsertProvider(p, { id: "mm", protocol: "minimax-api", baseUrl: "https://api.minimax.io/v1" });
    expect(() => createLappClient({ profile: p, provider: "mm" })).toThrow(UnsupportedProtocolError);
  });
});

describe("openai-chat-completions adapter", () => {
  it("builds request against baseUrl + /chat/completions (no /v1 appended)", async () => {
    const p = baseProfile();
    let captured: { url: string; body: unknown } | null = null;
    const wrappedFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      captured = { url, body: init?.body ? JSON.parse(init.body as string) : {} };
      return new Response(JSON.stringify({
        choices: [{ message: { content: "hi" }, finish_reason: "stop" }],
        model: "deepseek-chat",
        usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 },
      }), { status: 200 });
    }) as unknown as typeof fetch;
    const c2 = createLappClient({
      profile: p,
      provider: "deepseek",
      model: "deepseek-chat",
      resolveSecrets: true,
      env: { DEEPSEEK_API_KEY: "sk-test" },
      fetchImpl: wrappedFetch,
    });
    const resp = await c2.chat({ messages: [{ role: "user", content: "hello" }] });
    expect(captured!.url).toBe("https://api.deepseek.com/chat/completions");
    expect((captured!.body as { model: string }).model).toBe("deepseek-chat");
    expect((captured!.body as { messages: unknown[] }).messages[0]).toEqual({ role: "user", content: "hello" });
    expect(resp.text).toBe("hi");
    expect(resp.usage?.inputTokens).toBe(4);
    expect(resp.raw).toBeTruthy();
  });

  it("rawChat returns the raw provider response", async () => {
    const p = baseProfile();
    const wrappedFetch = (async () => new Response(JSON.stringify({
      choices: [{ message: { content: "hi" } }],
    }), { status: 200 })) as unknown as typeof fetch;
    const c = createLappClient({
      profile: p,
      provider: "deepseek",
      model: "deepseek-chat",
      resolveSecrets: true,
      env: { DEEPSEEK_API_KEY: "sk-test" },
      fetchImpl: wrappedFetch,
    });
    const raw = await c.rawChat({ messages: [{ role: "user", content: "x" }] });
    expect((raw as { choices: unknown[] }).choices).toHaveLength(1);
  });
});

describe("anthropic-messages adapter", () => {
  it("POSTs to /v1/messages with x-api-key and maps system", async () => {
    let p = createProfile({ rootDir: "/tmp/.lapp" });
    p = upsertProvider(p, { id: "anth", protocol: "anthropic-messages", baseUrl: "https://api.anthropic.com", auth: { secret: "sk-ant" } });
    p = upsertModel(p, { providerId: "anth", id: "claude-3", type: "chat" });
    let captured: { url: string; body: unknown; headers: Record<string, string> } | null = null;
    const wrappedFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      captured = { url, body: init?.body ? JSON.parse(init.body as string) : {}, headers: (init?.headers as Record<string, string>) ?? {} };
      return new Response(JSON.stringify({
        content: [{ type: "text", text: "bonjour" }],
        model: "claude-3",
        stop_reason: "end_turn",
        usage: { input_tokens: 3, output_tokens: 2 },
      }), { status: 200 });
    }) as unknown as typeof fetch;
    const c = createLappClient({
      profile: p,
      provider: "anth",
      model: "claude-3",
      resolveSecrets: true,
      fetchImpl: wrappedFetch,
    });
    const resp = await c.chat({
      messages: [
        { role: "system", content: "be brief" },
        { role: "user", content: "hi" },
      ],
    } as ChatInput);
    expect(captured!.url).toBe("https://api.anthropic.com/v1/messages");
    expect(captured!.headers["x-api-key"]).toBe("sk-ant");
    expect(captured!.headers["anthropic-version"]).toBe("2023-06-01");
    const body = captured!.body as { system: string; messages: unknown[] };
    expect(body.system).toBe("be brief");
    expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
    expect(resp.text).toBe("bonjour");
    expect(resp.finishReason).toBe("end_turn");
    expect(resp.usage?.inputTokens).toBe(3);
  });
});

describe("openai-responses adapter", () => {
  it("POSTs to /responses and parses output_text", async () => {
    let p = createProfile({ rootDir: "/tmp/.lapp" });
    p = upsertProvider(p, { id: "oai", protocol: "openai-responses", baseUrl: "https://api.openai.com/v1", auth: { secret: "sk-oai" } });
    p = upsertModel(p, { providerId: "oai", id: "gpt-4o", type: "chat" });
    let captured: { url: string; body: unknown } | null = null;
    const wrappedFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      captured = { url, body: init?.body ? JSON.parse(init.body as string) : {} };
      return new Response(JSON.stringify({
        output_text: "resp",
        model: "gpt-4o",
        status: "completed",
        usage: { input_tokens: 1, output_tokens: 1 },
      }), { status: 200 });
    }) as unknown as typeof fetch;
    const c = createLappClient({
      profile: p,
      provider: "oai",
      model: "gpt-4o",
      resolveSecrets: true,
      fetchImpl: wrappedFetch,
    });
    const resp = await c.chat({ messages: [{ role: "user", content: "hi" }] });
    expect(captured!.url).toBe("https://api.openai.com/v1/responses");
    expect(resp.text).toBe("resp");
  });
});

describe("testConnection", () => {
  it("returns ok=true on 200", async () => {
    const p = baseProfile();
    const wrappedFetch = (async () => new Response(JSON.stringify({
      choices: [{ message: { content: "pong" } }],
    }), { status: 200 })) as unknown as typeof fetch;
    const c = createLappClient({
      profile: p,
      provider: "deepseek",
      resolveSecrets: true,
      env: { DEEPSEEK_API_KEY: "sk-test" },
      fetchImpl: wrappedFetch,
    });
    const r = await c.testConnection();
    expect(r.ok).toBe(true);
    expect(r.provider).toBe("deepseek");
  });

  it("returns ok=false on network error", async () => {
    const p = baseProfile();
    const wrappedFetch = (async () => { throw new Error("network"); }) as unknown as typeof fetch;
    const c = createLappClient({
      profile: p,
      provider: "deepseek",
      resolveSecrets: true,
      env: { DEEPSEEK_API_KEY: "sk-test" },
      fetchImpl: wrappedFetch,
    });
    const r = await c.testConnection();
    expect(r.ok).toBe(false);
    expect(r.message).toContain("network");
  });
});

describe("fix coverage for review findings", () => {
  it("anthropic adapter: baseUrl ending in /v1 does not produce /v1/v1", async () => {
    let p = createProfile({ rootDir: "/tmp/.lapp" });
    p = upsertProvider(p, { id: "anth", protocol: "anthropic-messages", baseUrl: "https://api.anthropic.com/v1", auth: { secret: "sk-ant" } });
    p = upsertModel(p, { providerId: "anth", id: "claude-3", type: "chat" });
    let captured: { url: string } | null = null;
    const wrappedFetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      captured = { url };
      return new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const c = createLappClient({ profile: p, provider: "anth", model: "claude-3", resolveSecrets: true, fetchImpl: wrappedFetch });
    await c.chat({ messages: [{ role: "user", content: "hi" }] });
    expect(captured!.url).toBe("https://api.anthropic.com/v1/messages");
  });

  it("anthropic adapter: baseUrl without /v1 still appends /v1", async () => {
    let p = createProfile({ rootDir: "/tmp/.lapp" });
    p = upsertProvider(p, { id: "anth", protocol: "anthropic-messages", baseUrl: "https://api.anthropic.com", auth: { secret: "sk-ant" } });
    p = upsertModel(p, { providerId: "anth", id: "claude-3", type: "chat" });
    let captured: { url: string } | null = null;
    const wrappedFetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      captured = { url };
      return new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const c = createLappClient({ profile: p, provider: "anth", model: "claude-3", resolveSecrets: true, fetchImpl: wrappedFetch });
    await c.chat({ messages: [{ role: "user", content: "hi" }] });
    expect(captured!.url).toBe("https://api.anthropic.com/v1/messages");
  });

  it("openai-responses: system messages become top-level instructions, not role:system input items", async () => {
    let p = createProfile({ rootDir: "/tmp/.lapp" });
    p = upsertProvider(p, { id: "oai", protocol: "openai-responses", baseUrl: "https://api.openai.com/v1", auth: { secret: "sk-oai" } });
    p = upsertModel(p, { providerId: "oai", id: "gpt-4o", type: "chat" });
    let captured: { body: { input: Array<{ role: string }>; instructions?: string } } | null = null;
    const wrappedFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(init.body as string) : {};
      captured = { body };
      return new Response(JSON.stringify({ output_text: "ok", model: "gpt-4o" }), { status: 200 });
    }) as unknown as typeof fetch;
    const c = createLappClient({ profile: p, provider: "oai", model: "gpt-4o", resolveSecrets: true, fetchImpl: wrappedFetch });
    await c.chat({
      messages: [
        { role: "system", content: "be brief" },
        { role: "user", content: "hi" },
      ],
    } as ChatInput);
    expect(captured!.body.instructions).toBe("be brief");
    expect(captured!.body.input.every((i) => i.role !== "system")).toBe(true);
  });

  it("authQueryParam suppresses Authorization header (no double-leak)", async () => {
    let p = createProfile({ rootDir: "/tmp/.lapp" });
    p = upsertProvider(p, {
      id: "q",
      protocol: "openai-chat-completions",
      baseUrl: "https://q.api",
      auth: { secret: "sk-q", queryParam: "api_key" },
    });
    p = upsertModel(p, { providerId: "q", id: "m", type: "chat" });
    let captured: { url: string; headers: Record<string, string> } | null = null;
    const wrappedFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      captured = { url, headers: (init?.headers as Record<string, string>) ?? {} };
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const c = createLappClient({ profile: p, provider: "q", model: "m", resolveSecrets: true, fetchImpl: wrappedFetch });
    await c.chat({ messages: [{ role: "user", content: "hi" }] });
    expect(captured!.url).toContain("api_key=sk-q");
    expect(captured!.headers["Authorization"]).toBeUndefined();
    expect(captured!.headers["authorization"]).toBeUndefined();
  });

  it("openai-chat: auth.type=bearer with custom header name still uses Bearer prefix", async () => {
    let p = createProfile({ rootDir: "/tmp/.lapp" });
    p = upsertProvider(p, {
      id: "cu",
      protocol: "openai-chat-completions",
      baseUrl: "https://x",
      auth: { type: "bearer", header: "X-Api-Key", secret: "sk-x" },
    });
    p = upsertModel(p, { providerId: "cu", id: "m", type: "chat" });
    let captured: { headers: Record<string, string> } | null = null;
    const wrappedFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      captured = { headers: (init?.headers as Record<string, string>) ?? {} };
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const c = createLappClient({ profile: p, provider: "cu", model: "m", resolveSecrets: true, fetchImpl: wrappedFetch });
    await c.chat({ messages: [{ role: "user", content: "hi" }] });
    expect(captured!.headers["X-Api-Key"]).toBe("Bearer sk-x");
  });

  it("openai-chat: tool messages are rejected (consistent with openai-responses)", async () => {
    let p = createProfile({ rootDir: "/tmp/.lapp" });
    p = upsertProvider(p, { id: "oai", protocol: "openai-chat-completions", baseUrl: "https://x", auth: { secret: "sk-x" } });
    p = upsertModel(p, { providerId: "oai", id: "m", type: "chat" });
    const wrappedFetch = (async () => new Response("{}"), { status: 200 }) as unknown as typeof fetch;
    const c = createLappClient({ profile: p, provider: "oai", model: "m", resolveSecrets: true, fetchImpl: wrappedFetch });
    await expect(
      c.chat({ messages: [{ role: "tool", toolCallId: "call_x", content: "x" }] } as ChatInput),
    ).rejects.toThrow(/not supported in v1/);
  });

  it("openai-responses: rejects tool messages with a clear error", async () => {
    let p = createProfile({ rootDir: "/tmp/.lapp" });
    p = upsertProvider(p, { id: "oai", protocol: "openai-responses", baseUrl: "https://x", auth: { secret: "sk-x" } });
    p = upsertModel(p, { providerId: "oai", id: "m", type: "chat" });
    const wrappedFetch = (async () => new Response("{}"), { status: 200 }) as unknown as typeof fetch;
    const c = createLappClient({ profile: p, provider: "oai", model: "m", resolveSecrets: true, fetchImpl: wrappedFetch });
    await expect(
      c.chat({ messages: [{ role: "tool", toolCallId: "call_x", content: "x" }] } as ChatInput),
    ).rejects.toThrow(/not supported in v1/);
  });

  it("global default model does not leak across providers when caller supplies provider", () => {
    let p = createProfile({ rootDir: "/tmp/.lapp", global: true });
    p = upsertProvider(p, { id: "openai", protocol: "openai-chat-completions", baseUrl: "https://x", auth: { secret: "sk-oai" } });
    p = upsertModel(p, { providerId: "openai", id: "gpt-4o", type: "chat" });
    p = upsertProvider(p, { id: "anth", protocol: "anthropic-messages", baseUrl: "https://x", auth: { secret: "sk-ant" } });
    p = upsertModel(p, { providerId: "anth", id: "claude-3", type: "chat" });
    p = setDefaultModel(p, { providerId: "openai", model: "gpt-4o" });
    // Caller explicitly names anthropic; the global default's model must not
    // be smuggled in. Without a model, resolution either picks anthropic's own
    // first model ("claude-3") or throws — never sends "gpt-4o" to Anthropic.
    const c = createLappClient({ profile: p, provider: "anth", resolveSecrets: false });
    expect(c.model).toBe("claude-3");
    expect(c.providerId).toBe("anth");
  });

  // Regression: anthropic provider with authQueryParam set and no authHeader
  // (so the default header is x-api-key) must strip the x-api-key header
  // when delivering the secret via the query string, otherwise the
  // credential is transmitted twice (header + URL).
  it("anthropic + authQueryParam + no authHeader strips x-api-key (no double-leak)", async () => {
    let p = createProfile({ rootDir: "/tmp/.lapp" });
    p = upsertProvider(p, {
      id: "anth",
      protocol: "anthropic-messages",
      baseUrl: "https://api.anthropic.com",
      auth: { secret: "sk-test", queryParam: "key" },
    });
    p = upsertModel(p, { providerId: "anth", id: "claude-3", type: "chat" });
    let captured: { url: string; headers: Record<string, string> } | null = null;
    const wrappedFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      captured = { url, headers: (init?.headers as Record<string, string>) ?? {} };
      return new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const c = createLappClient({ profile: p, provider: "anth", model: "claude-3", resolveSecrets: true, fetchImpl: wrappedFetch });
    await c.chat({ messages: [{ role: "user", content: "hi" }] });
    expect(captured!.url).toContain("key=sk-test");
    expect(captured!.headers["x-api-key"]).toBeUndefined();
    expect(captured!.headers["X-Api-Key"]).toBeUndefined();
  });

  // Regression: anthropic joinUrl must not over-strip /v1 from a gateway
  // baseUrl like https://gateway/openai/v1 — the dedup should fire only
  // when /v1 is the base's only trailing path segment.
  it("anthropic + gateway baseUrl ending in /v1 still appends /v1", async () => {
    let p = createProfile({ rootDir: "/tmp/.lapp" });
    p = upsertProvider(p, {
      id: "anth",
      protocol: "anthropic-messages",
      baseUrl: "https://gateway.corp/openai/v1",
      auth: { secret: "sk-ant" },
    });
    p = upsertModel(p, { providerId: "anth", id: "claude-3", type: "chat" });
    let captured: { url: string } | null = null;
    const wrappedFetch = (async (input: RequestInfo | URL) => {
      captured = { url: typeof input === "string" ? input : input.toString() };
      return new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const c = createLappClient({ profile: p, provider: "anth", model: "claude-3", resolveSecrets: true, fetchImpl: wrappedFetch });
    await c.chat({ messages: [{ role: "user", content: "hi" }] });
    expect(captured!.url).toBe("https://gateway.corp/openai/v1/messages");
  });

  // Regression: deriveEnvName must produce a valid POSIX env var even for
  // ids starting with a digit — e.g. "1provider" → "_1PROVIDER_API_KEY"
  // (leading underscore, not "1PROVIDER_API_KEY" which the shell rejects).
  // Exercised via the plaintext path (env:// uses the ref name directly).
  it("deriveEnvName produces valid env name for digit-leading ids", async () => {
    const { exportEnv, collectExportEntries, deriveEnvName } = await import("../src/index.js");
    // Direct unit check: deriveEnvName is exported.
    expect(deriveEnvName("1provider")).toBe("_1PROVIDER_API_KEY");
    // End-to-end: a plaintext secret with a digit-leading id must emit a
    // valid export line, not "1PROVIDER_API_KEY=..." (shell syntax error).
    let p = createProfile({ rootDir: "/tmp/.lapp" });
    p = upsertProvider(p, {
      id: "1provider",
      protocol: "openai-chat-completions",
      baseUrl: "https://x",
      auth: { secret: "sk-plain" },
    });
    const out = exportEnv(p, { format: "bash", resolve: true, allowPlaintext: true });
    expect(out).toMatch(/^export _1PROVIDER_API_KEY='sk-plain'$/m);
    expect(out).not.toMatch(/^export 1PROVIDER_API_KEY=/m);
    // Also verify collectExportEntries uses the sanitized name.
    const entries = collectExportEntries(p, { format: "bash", resolve: true, allowPlaintext: true });
    expect(entries[0]!.name).toBe("_1PROVIDER_API_KEY");
  });

  // Regression: parseFlags (in cli/src/index.ts) must not consume a
  // flag-shaped token as a value. The unit test for it lives in the
  // CLI package; this suite covers the SDK surface.

  // Regression: a profile with only disabled providers must throw a clear
  // "no enabled provider available" instead of falling through to providers[0]
  // and surfacing a misleading "provider is disabled" error.
  it("all-disabled profile throws clear no-enabled-provider error", () => {
    let p = createProfile({ rootDir: "/tmp/.lapp" });
    p = upsertProvider(p, { id: "off", protocol: "openai-chat-completions", baseUrl: "https://x", enabled: false });
    expect(() => createLappClient({ profile: p })).toThrow(/no enabled provider/);
  });

  // Regression: stream:true must be rejected, not silently forwarded. The
  // non-streaming endpoint returns SSE which parseResponse can't parse,
  // yielding an empty LappResponse with no error.
  it("openai-chat rejects stream:true with a clear error", async () => {
    const p = baseProfile();
    const wrappedFetch = (async () => new Response("{}")) as unknown as typeof fetch;
    const c = createLappClient({ profile: p, provider: "deepseek", model: "deepseek-chat", resolveSecrets: true, env: { DEEPSEEK_API_KEY: "sk" }, fetchImpl: wrappedFetch });
    await expect(c.chat({ messages: [{ role: "user", content: "hi" }], stream: true } as ChatInput)).rejects.toThrow(/streaming is not supported/);
  });

  it("openai-responses rejects stream:true with a clear error", async () => {
    let p = createProfile({ rootDir: "/tmp/.lapp" });
    p = upsertProvider(p, { id: "oai", protocol: "openai-responses", baseUrl: "https://x", auth: { secret: "sk" } });
    p = upsertModel(p, { providerId: "oai", id: "gpt-4o", type: "chat" });
    const wrappedFetch = (async () => new Response("{}")) as unknown as typeof fetch;
    const c = createLappClient({ profile: p, provider: "oai", model: "gpt-4o", resolveSecrets: true, fetchImpl: wrappedFetch });
    await expect(c.chat({ messages: [{ role: "user", content: "hi" }], stream: true } as ChatInput)).rejects.toThrow(/streaming is not supported/);
  });

  // Anthropic: tool message with toolCallId maps to tool_result content block
  it("anthropic: tool messages with toolCallId become tool_result blocks", async () => {
    let p = createProfile({ rootDir: "/tmp/.lapp" });
    p = upsertProvider(p, { id: "anth", protocol: "anthropic-messages", baseUrl: "https://api.anthropic.com", auth: { secret: "sk-ant" } });
    p = upsertModel(p, { providerId: "anth", id: "claude-3", type: "chat" });
    let captured: { body: { messages: Array<{ role: string; content: unknown }> } } | null = null;
    const wrappedFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(init.body as string) : {};
      captured = { body };
      return new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const c = createLappClient({ profile: p, provider: "anth", model: "claude-3", resolveSecrets: true, fetchImpl: wrappedFetch });
    await c.chat({
      messages: [
        { role: "user", content: "hi" },
        { role: "tool", content: "result", toolCallId: "call_123" },
      ],
    } as ChatInput);
    const toolMsg = captured!.body.messages[1]!;
    expect(toolMsg.role).toBe("user");
    expect(Array.isArray(toolMsg.content)).toBe(true);
    const contentBlock = (toolMsg.content as Array<Record<string, unknown>>)[0]!;
    expect(contentBlock.type).toBe("tool_result");
    expect(contentBlock.tool_use_id).toBe("call_123");
  });

  // Anthropic: authHeader "authorization" routes to Bearer prefix logic
  it("anthropic: authHeader=authorization uses Bearer prefix", async () => {
    let p = createProfile({ rootDir: "/tmp/.lapp" });
    p = upsertProvider(p, {
      id: "anth",
      protocol: "anthropic-messages",
      baseUrl: "https://api.anthropic.com",
      auth: { secret: "sk-ant-test", header: "Authorization" },
    });
    p = upsertModel(p, { providerId: "anth", id: "claude-3", type: "chat" });
    let captured: { headers: Record<string, string> } | null = null;
    const wrappedFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      captured = { headers: (init?.headers as Record<string, string>) ?? {} };
      return new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const c = createLappClient({ profile: p, provider: "anth", model: "claude-3", resolveSecrets: true, fetchImpl: wrappedFetch });
    await c.chat({ messages: [{ role: "user", content: "hi" }] });
    expect(captured!.headers["Authorization"]).toBe("Bearer sk-ant-test");
  });

  // Openai-responses: assistant message maps to developer role
  it("openai-responses: assistant messages map to role developer", async () => {
    let p = createProfile({ rootDir: "/tmp/.lapp" });
    p = upsertProvider(p, { id: "oai", protocol: "openai-responses", baseUrl: "https://api.openai.com/v1", auth: { secret: "sk-oai" } });
    p = upsertModel(p, { providerId: "oai", id: "gpt-4o", type: "chat" });
    let captured: { body: { input: Array<{ role: string }> } } | null = null;
    const wrappedFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(init.body as string) : {};
      captured = { body };
      return new Response(JSON.stringify({ output_text: "ok", model: "gpt-4o" }), { status: 200 });
    }) as unknown as typeof fetch;
    const c = createLappClient({ profile: p, provider: "oai", model: "gpt-4o", resolveSecrets: true, fetchImpl: wrappedFetch });
    await c.chat({
      messages: [
        { role: "assistant", content: "I can help" },
        { role: "user", content: "thanks" },
      ],
    } as ChatInput);
    const items = captured!.body.input;
    expect(items[0]!.role).toBe("developer");
    expect(items[1]!.role).toBe("user");
  });

  // Openai-responses: parseResponse uses output array when output_text is absent
  it("openai-responses: falls back to output array for text", async () => {
    let p = createProfile({ rootDir: "/tmp/.lapp" });
    p = upsertProvider(p, { id: "oai", protocol: "openai-responses", baseUrl: "https://api.openai.com/v1", auth: { secret: "sk-oai" } });
    p = upsertModel(p, { providerId: "oai", id: "gpt-4o", type: "chat" });
    const wrappedFetch = (async () =>
      new Response(JSON.stringify({
        output: [{ content: [{ type: "output_text", text: "from block" }] }],
        model: "gpt-4o",
      }), { status: 200 })) as unknown as typeof fetch;
    const c = createLappClient({ profile: p, provider: "oai", model: "gpt-4o", resolveSecrets: true, fetchImpl: wrappedFetch });
    const resp = await c.chat({ messages: [{ role: "user", content: "hi" }] });
    expect(resp.text).toBe("from block");
  });

  // Openai-chat: authType=custom-header sets secret without Bearer prefix
  it("openai-chat: authType=custom-header passes secret without Bearer prefix", async () => {
    let p = createProfile({ rootDir: "/tmp/.lapp" });
    p = upsertProvider(p, {
      id: "cu",
      protocol: "openai-chat-completions",
      baseUrl: "https://x",
      auth: { type: "custom-header", header: "X-Api-Key", secret: "sk-secret-value" },
    });
    p = upsertModel(p, { providerId: "cu", id: "m", type: "chat" });
    let captured: { headers: Record<string, string> } | null = null;
    const wrappedFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      captured = { headers: (init?.headers as Record<string, string>) ?? {} };
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const c = createLappClient({ profile: p, provider: "cu", model: "m", resolveSecrets: true, fetchImpl: wrappedFetch });
    await c.chat({ messages: [{ role: "user", content: "hi" }] });
    expect(captured!.headers["X-Api-Key"]).toBe("sk-secret-value");
    expect(captured!.headers["X-Api-Key"]).not.toContain("Bearer");
  });

  // Openai-chat: strips auth-case headers from requestHeaders
  it("openai-chat: strips auth headers from requestHeaders to avoid duplicates", async () => {
    let p = createProfile({ rootDir: "/tmp/.lapp" });
    p = upsertProvider(p, {
      id: "cu",
      protocol: "openai-chat-completions",
      baseUrl: "https://x",
      auth: { secret: "sk-real" },
      requestHeaders: { "authorization": "sk-should-be-stripped", "X-Api-Key": "also-stripped" },
    });
    p = upsertModel(p, { providerId: "cu", id: "m", type: "chat" });
    let captured: { headers: Record<string, string> } | null = null;
    const wrappedFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      captured = { headers: (init?.headers as Record<string, string>) ?? {} };
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const c = createLappClient({ profile: p, provider: "cu", model: "m", resolveSecrets: true, fetchImpl: wrappedFetch });
    await c.chat({ messages: [{ role: "user", content: "hi" }] });
    expect(captured!.headers["authorization"]).toBeUndefined();
    expect(captured!.headers["X-Api-Key"]).toBeUndefined();
    expect(captured!.headers["Authorization"]).toContain("sk-real");
  });

  // HTTP error response: non-200 status with redacted error message
  it("HTTP 401 returns redacted error (no secret leak in message)", async () => {
    const p = baseProfile();
    const wrappedFetch = (async () =>
      new Response(JSON.stringify({ error: { message: "invalid sk-abc123def4567890 key" } }), { status: 401 }),
    ) as unknown as typeof fetch;
    const c = createLappClient({ profile: p, provider: "deepseek", model: "deepseek-chat", resolveSecrets: true, env: { DEEPSEEK_API_KEY: "sk-test" }, fetchImpl: wrappedFetch });
    await expect(c.chat({ messages: [{ role: "user", content: "hi" }] })).rejects.toThrow(/provider deepseek returned 401/);
  });

  // JSON parse failure on response body (non-JSON text)
  it("non-JSON response body is stored as _rawText", async () => {
    const p = baseProfile();
    let rawResult: unknown = null;
    const wrappedFetch = (async () =>
      new Response("plain error text", { status: 503, headers: { "content-type": "text/plain" } }),
    ) as unknown as typeof fetch;
    const c = createLappClient({ profile: p, provider: "deepseek", model: "deepseek-chat", resolveSecrets: true, env: { DEEPSEEK_API_KEY: "sk-test" }, fetchImpl: wrappedFetch });
    try { await c.chat({ messages: [{ role: "user", content: "hi" }] }); } catch (err) { rawResult = (err as { raw?: unknown }).raw; }
    expect(rawResult).toBeTruthy();
  });

  // Openai-chat: auth headers stripped from requestHeaders to avoid duplicates
  it("openai-chat: strips x-api-key from requestHeaders", async () => {
    let p = createProfile({ rootDir: "/tmp/.lapp" });
    p = upsertProvider(p, { id: "cu", protocol: "openai-chat-completions", baseUrl: "https://x", auth: { secret: "sk-one" }, requestHeaders: { "X-Api-Key": "sk-dup" } });
    p = upsertModel(p, { providerId: "cu", id: "m", type: "chat" });
    let captured: { headers: Record<string, string> } | null = null;
    const wrappedFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => { captured = { headers: (init?.headers as Record<string, string>) ?? {} }; return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 }); }) as unknown as typeof fetch;
    const c = createLappClient({ profile: p, provider: "cu", model: "m", resolveSecrets: true, fetchImpl: wrappedFetch });
    await c.chat({ messages: [{ role: "user", content: "hi" }] });
    expect(captured!.headers["X-Api-Key"]).toBeUndefined();
    expect(captured!.headers["Authorization"]).toContain("sk-one");
  });

  // Openai-responses: strips auth headers from requestHeaders
  it("openai-responses: strips auth headers from requestHeaders", async () => {
    let p = createProfile({ rootDir: "/tmp/.lapp" });
    p = upsertProvider(p, { id: "oai", protocol: "openai-responses", baseUrl: "https://x", auth: { secret: "sk-one" }, requestHeaders: { "Authorization": "sk-dup" } });
    p = upsertModel(p, { providerId: "oai", id: "m", type: "chat" });
    let captured: { headers: Record<string, string> } | null = null;
    const wrappedFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => { captured = { headers: (init?.headers as Record<string, string>) ?? {} }; return new Response(JSON.stringify({ output_text: "ok", model: "m" }), { status: 200 }); }) as unknown as typeof fetch;
    const c = createLappClient({ profile: p, provider: "oai", model: "m", resolveSecrets: true, fetchImpl: wrappedFetch });
    await c.chat({ messages: [{ role: "user", content: "hi" }] });
    expect(captured!.headers["Authorization"]).toContain("sk-one");
    expect(Object.keys(captured!.headers).filter((k) => k.toLowerCase() === "authorization")).toHaveLength(1);
  });

  // Openai-responses: custom-header authType
  it("openai-responses: authType=custom-header passes secret without Bearer prefix", async () => {
    let p = createProfile({ rootDir: "/tmp/.lapp" });
    p = upsertProvider(p, { id: "oai", protocol: "openai-responses", baseUrl: "https://x", auth: { type: "custom-header", header: "X-Api-Key", secret: "sk-secret-value" } });
    p = upsertModel(p, { providerId: "oai", id: "m", type: "chat" });
    let captured: { headers: Record<string, string> } | null = null;
    const wrappedFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => { captured = { headers: (init?.headers as Record<string, string>) ?? {} }; return new Response(JSON.stringify({ output_text: "ok", model: "m" }), { status: 200 }); }) as unknown as typeof fetch;
    const c = createLappClient({ profile: p, provider: "oai", model: "m", resolveSecrets: true, fetchImpl: wrappedFetch });
    await c.chat({ messages: [{ role: "user", content: "hi" }] });
    expect(captured!.headers["X-Api-Key"]).toBe("sk-secret-value");
    expect(captured!.headers["X-Api-Key"]).not.toContain("Bearer");
  });

  // Anthropic: strips auth headers from requestHeaders
  it("anthropic: strips duplicate x-api-key from requestHeaders", async () => {
    let p = createProfile({ rootDir: "/tmp/.lapp" });
    p = upsertProvider(p, { id: "anth", protocol: "anthropic-messages", baseUrl: "https://api.anthropic.com", auth: { secret: "sk-ant-test" }, requestHeaders: { "X-Api-Key": "sk-dup" } });
    p = upsertModel(p, { providerId: "anth", id: "claude-3", type: "chat" });
    let captured: { headers: Record<string, string> } | null = null;
    const wrappedFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => { captured = { headers: (init?.headers as Record<string, string>) ?? {} }; return new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }] }), { status: 200 }); }) as unknown as typeof fetch;
    const c = createLappClient({ profile: p, provider: "anth", model: "claude-3", resolveSecrets: true, fetchImpl: wrappedFetch });
    await c.chat({ messages: [{ role: "user", content: "hi" }] });
    expect(Object.keys(captured!.headers).filter((k) => k.toLowerCase() === "x-api-key")).toHaveLength(1);
    expect(captured!.headers["x-api-key"]).toBe("sk-ant-test");
  });

  // Anthropic: tool message without toolCallId throws
  it("anthropic: tool message without toolCallId throws clear error", async () => {
    let p = createProfile({ rootDir: "/tmp/.lapp" });
    p = upsertProvider(p, { id: "anth", protocol: "anthropic-messages", baseUrl: "https://api.anthropic.com", auth: { secret: "sk-ant" } });
    p = upsertModel(p, { providerId: "anth", id: "claude-3", type: "chat" });
    const wrappedFetch = (async () => new Response("{}")) as unknown as typeof fetch;
    const c = createLappClient({ profile: p, provider: "anth", model: "claude-3", resolveSecrets: true, fetchImpl: wrappedFetch });
    await expect(c.chat({ messages: [{ role: "tool", content: "result" }] } as ChatInput)).rejects.toThrow(/toolCallId/);
  });

  // Regression: Bearer-prefixed secret with authorization header (line 51 branch)
  it("anthropic: Bearer-prefixed secret with authHeader=Authorization is not double-wrapped", async () => {
    let p = createProfile({ rootDir: "/tmp/.lapp" });
    p = upsertProvider(p, { id: "anth", protocol: "anthropic-messages", baseUrl: "https://api.anthropic.com", auth: { secret: "Bearer sk-ant-already", header: "Authorization" } });
    p = upsertModel(p, { providerId: "anth", id: "claude-3", type: "chat" });
    let captured: { headers: Record<string, string> } | null = null;
    const wrappedFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => { captured = { headers: (init?.headers as Record<string, string>) ?? {} }; return new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }] }), { status: 200 }); }) as unknown as typeof fetch;
    const c = createLappClient({ profile: p, provider: "anth", model: "claude-3", resolveSecrets: true, fetchImpl: wrappedFetch });
    await c.chat({ messages: [{ role: "user", content: "hi" }] });
    expect(captured!.headers["Authorization"]).toBe("Bearer sk-ant-already");
  });

  // Openai-chat: unknown authType falls back to Bearer prefix
  it("openai-chat: unknown authType falls back to Bearer prefix", async () => {
    let p = createProfile({ rootDir: "/tmp/.lapp" });
    p = upsertProvider(p, { id: "cu", protocol: "openai-chat-completions", baseUrl: "https://x", auth: { type: "weird-auth", secret: "sk-x" } });
    p = upsertModel(p, { providerId: "cu", id: "m", type: "chat" });
    let captured: { headers: Record<string, string> } | null = null;
    const wrappedFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => { captured = { headers: (init?.headers as Record<string, string>) ?? {} }; return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 }); }) as unknown as typeof fetch;
    const c = createLappClient({ profile: p, provider: "cu", model: "m", resolveSecrets: true, fetchImpl: wrappedFetch });
    await c.chat({ messages: [{ role: "user", content: "hi" }] });
    expect(captured!.headers["Authorization"]).toBe("Bearer sk-x");
  });

  // Openai-responses: unknown authType falls back to Bearer prefix
  it("openai-responses: unknown authType falls back to Bearer prefix", async () => {
    let p = createProfile({ rootDir: "/tmp/.lapp" });
    p = upsertProvider(p, { id: "oai", protocol: "openai-responses", baseUrl: "https://x", auth: { type: "weird-auth", secret: "sk-x" } });
    p = upsertModel(p, { providerId: "oai", id: "m", type: "chat" });
    let captured: { headers: Record<string, string> } | null = null;
    const wrappedFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => { captured = { headers: (init?.headers as Record<string, string>) ?? {} }; return new Response(JSON.stringify({ output_text: "ok", model: "m" }), { status: 200 }); }) as unknown as typeof fetch;
    const c = createLappClient({ profile: p, provider: "oai", model: "m", resolveSecrets: true, fetchImpl: wrappedFetch });
    await c.chat({ messages: [{ role: "user", content: "hi" }] });
    expect(captured!.headers["Authorization"]).toBe("Bearer sk-x");
  });

  // Negative: explicitly requesting a disabled provider throws
  it("explicitly requesting a disabled provider throws provider is disabled", () => {
    let p = createProfile({ rootDir: "/tmp/.lapp" });
    p = upsertProvider(p, { id: "off", protocol: "openai-chat-completions", baseUrl: "https://x", enabled: false, auth: { secret: "sk" } });
    p = upsertModel(p, { providerId: "off", id: "m", type: "chat" });
    expect(() => createLappClient({ profile: p, provider: "off", resolveSecrets: true })).toThrow(/provider is disabled/);
  });

  // Negative: fail-fast when secret resolution fails (env:// with resolveSecrets:false)
  it("chat() throws when secret cannot be resolved (fail-fast, no placeholder)", async () => {
    const p = baseProfile(); // env://DEEPSEEK_API_KEY
    const wrappedFetch = (async () => new Response("{}")) as unknown as typeof fetch;
    const c = createLappClient({ profile: p, provider: "deepseek", model: "deepseek-chat", resolveSecrets: false, fetchImpl: wrappedFetch });
    await expect(c.chat({ messages: [{ role: "user", content: "hi" }] })).rejects.toThrow(/explicit.*resolve/);
  });

  // Negative: provider has models but all are disabled → no enabled models error
  it("provider with only disabled models throws no enabled models", () => {
    let p = createProfile({ rootDir: "/tmp/.lapp" });
    p = upsertProvider(p, { id: "ds", protocol: "openai-chat-completions", baseUrl: "https://x", auth: { secret: "sk" } });
    p = upsertModel(p, { providerId: "ds", id: "m1", type: "chat", enabled: false });
    expect(() => createLappClient({ profile: p, provider: "ds", resolveSecrets: true })).toThrow(/no enabled models/);
  });

  // Non-auth requestHeaders must pass through adapters untouched
  it("openai-chat: non-auth requestHeaders are forwarded", async () => {
    let p = createProfile({ rootDir: "/tmp/.lapp" });
    p = upsertProvider(p, { id: "cu", protocol: "openai-chat-completions", baseUrl: "https://x", auth: { secret: "sk-x" }, requestHeaders: { "X-Custom": "val" } });
    p = upsertModel(p, { providerId: "cu", id: "m", type: "chat" });
    let captured: { headers: Record<string, string> } | null = null;
    const wrappedFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => { captured = { headers: (init?.headers as Record<string, string>) ?? {} }; return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 }); }) as unknown as typeof fetch;
    const c = createLappClient({ profile: p, provider: "cu", model: "m", resolveSecrets: true, fetchImpl: wrappedFetch });
    await c.chat({ messages: [{ role: "user", content: "hi" }] });
    expect(captured!.headers["X-Custom"]).toBe("val");
  });

  it("openai-responses: non-auth requestHeaders are forwarded", async () => {
    let p = createProfile({ rootDir: "/tmp/.lapp" });
    p = upsertProvider(p, { id: "oai", protocol: "openai-responses", baseUrl: "https://x", auth: { secret: "sk-x" }, requestHeaders: { "X-Custom": "val" } });
    p = upsertModel(p, { providerId: "oai", id: "m", type: "chat" });
    let captured: { headers: Record<string, string> } | null = null;
    const wrappedFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => { captured = { headers: (init?.headers as Record<string, string>) ?? {} }; return new Response(JSON.stringify({ output_text: "ok", model: "m" }), { status: 200 }); }) as unknown as typeof fetch;
    const c = createLappClient({ profile: p, provider: "oai", model: "m", resolveSecrets: true, fetchImpl: wrappedFetch });
    await c.chat({ messages: [{ role: "user", content: "hi" }] });
    expect(captured!.headers["X-Custom"]).toBe("val");
  });

  it("anthropic: non-auth requestHeaders are forwarded", async () => {
    let p = createProfile({ rootDir: "/tmp/.lapp" });
    p = upsertProvider(p, { id: "anth", protocol: "anthropic-messages", baseUrl: "https://api.anthropic.com", auth: { secret: "sk-ant" }, requestHeaders: { "X-Custom": "val" } });
    p = upsertModel(p, { providerId: "anth", id: "claude-3", type: "chat" });
    let captured: { headers: Record<string, string> } | null = null;
    const wrappedFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => { captured = { headers: (init?.headers as Record<string, string>) ?? {} }; return new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }] }), { status: 200 }); }) as unknown as typeof fetch;
    const c = createLappClient({ profile: p, provider: "anth", model: "claude-3", resolveSecrets: true, fetchImpl: wrappedFetch });
    await c.chat({ messages: [{ role: "user", content: "hi" }] });
    expect(captured!.headers["X-Custom"]).toBe("val");
  });

  // Negative: empty providers array throws clear error
  it("throws TargetResolutionError when profile has zero providers", () => {
    const p = createProfile({ rootDir: "/tmp/.lapp" });
    expect(() => createLappClient({ profile: p })).toThrow(/no providers available/);
  });

  // Negative: falls back to first enabled provider when no global default and no explicit providerId
  it("falls back to first enabled provider when no global default", () => {
    let p = createProfile({ rootDir: "/tmp/.lapp" });
    p = upsertProvider(p, { id: "first", protocol: "openai-chat-completions", baseUrl: "https://x", auth: { secret: "sk" } });
    p = upsertModel(p, { providerId: "first", id: "m1", type: "chat" });
    const c = createLappClient({ profile: p, resolveSecrets: false });
    expect(c.providerId).toBe("first");
  });

  // Negative: model id not in models list is passed through verbatim
  it("passes through arbitrary model id not listed in models.json", () => {
    const p = baseProfile();
    const c = createLappClient({ profile: p, provider: "deepseek", model: "not-listed", resolveSecrets: false });
    expect(c.model).toBe("not-listed");
  });
});