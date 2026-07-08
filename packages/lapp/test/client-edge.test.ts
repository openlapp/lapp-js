import { describe, it, expect } from "vitest";
import {
  createLappClient,
  type ChatInput,
} from "../src/index.js";
import { createProfile, upsertProvider, upsertModel, replaceProviderModels } from "../src/index.js";

function makeStream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

function baseProfile() {
  let p = createProfile({ rootDir: "/tmp/.lapp" });
  p = upsertProvider(p, { id: "p", protocol: "openai-chat-completions", baseUrl: "https://x", auth: { secret: "sk" } });
  p = upsertModel(p, { providerId: "p", id: "m", type: "chat" });
  return p;
}

describe("stream error paths", () => {
  it("openai-chat: yields error on malformed JSON in stream", async () => {
    let p = createProfile({ rootDir: "/tmp/.lapp" });
    p = upsertProvider(p, { id: "p", protocol: "openai-chat-completions", baseUrl: "https://x", auth: { secret: "sk" } });
    p = upsertModel(p, { providerId: "p", id: "m", type: "chat" });
    const sse = "data: {not-json\n\n";
    const wrappedFetch = (async () => new Response(makeStream(sse), { status: 200 })) as unknown as typeof fetch;
    const c = createLappClient({ profile: p, provider: "p", model: "m", resolveSecrets: true, fetchImpl: wrappedFetch });
    const events: any[] = [];
    for await (const ev of c.stream({ messages: [{ role: "user", content: "x" }] })) events.push(ev);
    expect(events.some((e) => e.kind === "error")).toBe(true);
  });

  it("anthropic: yields error on malformed JSON in stream", async () => {
    let p = createProfile({ rootDir: "/tmp/.lapp" });
    p = upsertProvider(p, { id: "p", protocol: "anthropic-messages", baseUrl: "https://api.anthropic.com", auth: { secret: "sk" } });
    p = upsertModel(p, { providerId: "p", id: "m", type: "chat" });
    const sse = "data: {not-json\n\n";
    const wrappedFetch = (async () => new Response(makeStream(sse), { status: 200 })) as unknown as typeof fetch;
    const c = createLappClient({ profile: p, provider: "p", model: "m", resolveSecrets: true, fetchImpl: wrappedFetch });
    const events: any[] = [];
    for await (const ev of c.stream({ messages: [{ role: "user", content: "x" }] })) events.push(ev);
    expect(events.some((e) => e.kind === "error")).toBe(true);
  });

  it("openai-responses: yields error on malformed JSON in stream", async () => {
    let p = createProfile({ rootDir: "/tmp/.lapp" });
    p = upsertProvider(p, { id: "p", protocol: "openai-responses", baseUrl: "https://x", auth: { secret: "sk" } });
    p = upsertModel(p, { providerId: "p", id: "m", type: "chat" });
    const sse = "data: {bad-json\n\n";
    const wrappedFetch = (async () => new Response(makeStream(sse), { status: 200 })) as unknown as typeof fetch;
    const c = createLappClient({ profile: p, provider: "p", model: "m", resolveSecrets: true, fetchImpl: wrappedFetch });
    const events: any[] = [];
    for await (const ev of c.stream({ messages: [{ role: "user", content: "x" }] })) events.push(ev);
    expect(events.some((e) => e.kind === "error")).toBe(true);
  });

  it("stream: HTTP error response throws", async () => {
    const p = baseProfile();
    const wrappedFetch = (async () =>
      new Response(JSON.stringify({ error: "bad" }), { status: 500 }),
    ) as unknown as typeof fetch;
    const c = createLappClient({ profile: p, provider: "p", model: "m", resolveSecrets: true, fetchImpl: wrappedFetch });
    await expect(async () => {
      for await (const _ of c.stream({ messages: [{ role: "user", content: "x" }] })) {}
    }).rejects.toThrow(/provider p returned 500/);
  });

  it("stream: empty body throws", async () => {
    const p = baseProfile();
    const wrappedFetch = (async () =>
      new Response(null, { status: 200 }),
    ) as unknown as typeof fetch;
    const c = createLappClient({ profile: p, provider: "p", model: "m", resolveSecrets: true, fetchImpl: wrappedFetch });
    await expect(async () => {
      for await (const _ of c.stream({ messages: [{ role: "user", content: "x" }] })) {}
    }).rejects.toThrow(/empty stream body/);
  });

  it("openai-chat: yields usage events in stream", async () => {
    let p = createProfile({ rootDir: "/tmp/.lapp" });
    p = upsertProvider(p, { id: "p", protocol: "openai-chat-completions", baseUrl: "https://x", auth: { secret: "sk" } });
    p = upsertModel(p, { providerId: "p", id: "m", type: "chat" });
    const sse = "data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}],\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":5,\"total_tokens\":15}}\n\n" +
      "data: [DONE]\n\n";
    const wrappedFetch = (async () => new Response(makeStream(sse), { status: 200 })) as unknown as typeof fetch;
    const c = createLappClient({ profile: p, provider: "p", model: "m", resolveSecrets: true, fetchImpl: wrappedFetch });
    const events: any[] = [];
    for await (const ev of c.stream({ messages: [{ role: "user", content: "x" }] })) events.push(ev);
    const usage = events.find((e) => e.kind === "usage");
    expect(usage).toBeDefined();
    expect(usage!.inputTokens).toBe(10);
    expect(usage!.outputTokens).toBe(5);
  });

  it("stream: HTTP error with non-JSON body", async () => {
    const p = baseProfile();
    const wrappedFetch = (async () =>
      new Response("internal server error", { status: 500 }),
    ) as unknown as typeof fetch;
    const c = createLappClient({ profile: p, provider: "p", model: "m", resolveSecrets: true, fetchImpl: wrappedFetch });
    await expect(async () => {
      for await (const _ of c.stream({ messages: [{ role: "user", content: "x" }] })) {}
    }).rejects.toThrow(/provider p returned 500/);
  });
});

describe("executeWithTools: edge cases", () => {
  it("throws when signal is already aborted before first turn", async () => {
    const p = baseProfile();
    const wrappedFetch = (async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 }),
    ) as unknown as typeof fetch;
    const c = createLappClient({ profile: p, provider: "p", model: "m", resolveSecrets: true, fetchImpl: wrappedFetch });
    const controller = new AbortController();
    controller.abort();
    await expect(c.executeWithTools(
      { messages: [{ role: "user", content: "x" }] },
      [{ name: "t", parameters: {} }],
      { t: () => "ok" },
      { signal: controller.signal },
    )).rejects.toThrow(/aborted/);
  });

  it("passes toolChoice to chat calls", async () => {
    const p = baseProfile();
    let capturedBody: any;
    const wrappedFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = JSON.parse((init?.body as string) ?? "{}");
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const c = createLappClient({ profile: p, provider: "p", model: "m", resolveSecrets: true, fetchImpl: wrappedFetch });
    await c.executeWithTools(
      { messages: [{ role: "user", content: "x" }] },
      [{ name: "t", parameters: {} }],
      { t: () => "ok" },
      { toolChoice: "required" },
    );
    expect(capturedBody.tool_choice).toBe("required");
  });

  it("async handler resolves correctly", async () => {
    const p = baseProfile();
    const responses = [
      new Response(JSON.stringify({
        choices: [{ message: { tool_calls: [{ id: "c1", function: { name: "asyncAdd", arguments: "{\"x\":3}" } }] } }],
      }), { status: 200 }),
      new Response(JSON.stringify({ choices: [{ message: { content: "done" } }] }), { status: 200 }),
    ];
    let i = 0;
    const wrappedFetch = (async () => responses[i++]!) as unknown as typeof fetch;
    const c = createLappClient({ profile: p, provider: "p", model: "m", resolveSecrets: true, fetchImpl: wrappedFetch });
    const out = await c.executeWithTools(
      { messages: [{ role: "user", content: "x" }] },
      [{ name: "asyncAdd", parameters: { type: "object" } }],
      { asyncAdd: async (args) => String((args.x as number) * 2) },
    );
    expect(out.text).toBe("done");
  });

  it("handles handler returning non-error throw with message property", async () => {
    const p = baseProfile();
    const responses = [
      new Response(JSON.stringify({
        choices: [{ message: { tool_calls: [{ id: "c1", function: { name: "boom", arguments: "{}" } }] } }],
      }), { status: 200 }),
      new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 }),
    ];
    let i = 0;
    const wrappedFetch = (async () => responses[i++]!) as unknown as typeof fetch;
    const c = createLappClient({ profile: p, provider: "p", model: "m", resolveSecrets: true, fetchImpl: wrappedFetch });
    const out = await c.executeWithTools(
      { messages: [{ role: "user", content: "x" }] },
      [{ name: "boom", parameters: { type: "object" } }],
      { boom: () => { throw "string error"; } },
    );
    const toolMsg = out.messages.find((m) => m.role === "tool");
    expect(toolMsg?.content).toMatch(/error:/);
  });
});

describe("openai-chat: parseResponse edge cases", () => {
  it("returns empty text when choices is missing", async () => {
    let p = createProfile({ rootDir: "/tmp/.lapp" });
    p = upsertProvider(p, { id: "p", protocol: "openai-chat-completions", baseUrl: "https://x", auth: { secret: "sk" } });
    p = upsertModel(p, { providerId: "p", id: "m", type: "chat" });
    const wrappedFetch = (async () =>
      new Response(JSON.stringify({ model: "m" }), { status: 200 }),
    ) as unknown as typeof fetch;
    const c = createLappClient({ profile: p, provider: "p", model: "m", resolveSecrets: true, fetchImpl: wrappedFetch });
    const resp = await c.chat({ messages: [{ role: "user", content: "x" }] });
    expect(resp.text).toBe("");
  });

  it("uses ctx.model when response model is absent", async () => {
    let p = createProfile({ rootDir: "/tmp/.lapp" });
    p = upsertProvider(p, { id: "p", protocol: "openai-chat-completions", baseUrl: "https://x", auth: { secret: "sk" } });
    p = upsertModel(p, { providerId: "p", id: "m", type: "chat" });
    const wrappedFetch = (async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "hi" } }] }), { status: 200 }),
    ) as unknown as typeof fetch;
    const c = createLappClient({ profile: p, provider: "p", model: "m", resolveSecrets: true, fetchImpl: wrappedFetch });
    const resp = await c.chat({ messages: [{ role: "user", content: "x" }] });
    expect(resp.model).toBe("m");
  });

  it("empty toolCalls array returns undefined", async () => {
    let p = createProfile({ rootDir: "/tmp/.lapp" });
    p = upsertProvider(p, { id: "p", protocol: "openai-chat-completions", baseUrl: "https://x", auth: { secret: "sk" } });
    p = upsertModel(p, { providerId: "p", id: "m", type: "chat" });
    const wrappedFetch = (async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "hi", tool_calls: [] } }] }), { status: 200 }),
    ) as unknown as typeof fetch;
    const c = createLappClient({ profile: p, provider: "p", model: "m", resolveSecrets: true, fetchImpl: wrappedFetch });
    const resp = await c.chat({ messages: [{ role: "user", content: "x" }] });
    expect(resp.toolCalls).toBeUndefined();
  });

  it("tool_call without function.arguments defaults to empty args", async () => {
    let p = createProfile({ rootDir: "/tmp/.lapp" });
    p = upsertProvider(p, { id: "p", protocol: "openai-chat-completions", baseUrl: "https://x", auth: { secret: "sk" } });
    p = upsertModel(p, { providerId: "p", id: "m", type: "chat" });
    const wrappedFetch = (async () =>
      new Response(JSON.stringify({
        choices: [{ message: { tool_calls: [{ id: "c1", function: { name: "f" } }] } }],
      }), { status: 200 }),
    ) as unknown as typeof fetch;
    const c = createLappClient({ profile: p, provider: "p", model: "m", resolveSecrets: true, fetchImpl: wrappedFetch });
    const resp = await c.chat({ messages: [{ role: "user", content: "x" }] });
    expect(resp.toolCalls?.[0]?.arguments).toEqual({});
    expect(resp.toolCalls?.[0]?.parseError).toBeUndefined();
  });
});

describe("rawChat edge cases", () => {
  it("rawChat rejects stream:true", async () => {
    const p = baseProfile();
    const wrappedFetch = (async () => new Response("{}")) as unknown as typeof fetch;
    const c = createLappClient({ profile: p, provider: "p", model: "m", resolveSecrets: true, fetchImpl: wrappedFetch });
    await expect(c.rawChat({ messages: [{ role: "user", content: "hi" }], stream: true })).rejects.toThrow(/rawChat.*stream/);
  });
});

describe("anomalous parseResponse coverage", () => {
  it("openai-responses: parseResponse with null model falls back to ctx.model", async () => {
    let p = createProfile({ rootDir: "/tmp/.lapp" });
    p = upsertProvider(p, { id: "p", protocol: "openai-responses", baseUrl: "https://x", auth: { secret: "sk" } });
    p = upsertModel(p, { providerId: "p", id: "m", type: "chat" });
    const wrappedFetch = (async () =>
      new Response(JSON.stringify({ output_text: "ok" }), { status: 200 }),
    ) as unknown as typeof fetch;
    const c = createLappClient({ profile: p, provider: "p", model: "m", resolveSecrets: true, fetchImpl: wrappedFetch });
    const resp = await c.chat({ messages: [{ role: "user", content: "x" }] });
    expect(resp.model).toBe("m");
  });

  it("anthropic: parseResponse with content type mix", async () => {
    let p = createProfile({ rootDir: "/tmp/.lapp" });
    p = upsertProvider(p, { id: "p", protocol: "anthropic-messages", baseUrl: "https://api.anthropic.com", auth: { secret: "sk" } });
    p = upsertModel(p, { providerId: "p", id: "m", type: "chat" });
    const wrappedFetch = (async () =>
      new Response(JSON.stringify({
        content: [
          { type: "text", text: "hello " },
          { type: "tool_use", id: "t1", name: "f", input: { x: 1 } },
          { type: "text", text: "world" },
        ],
        model: "m",
        stop_reason: "tool_use",
        usage: { input_tokens: 10, output_tokens: 20 },
      }), { status: 200 }),
    ) as unknown as typeof fetch;
    const c = createLappClient({ profile: p, provider: "p", model: "m", resolveSecrets: true, fetchImpl: wrappedFetch });
    const resp = await c.chat({ messages: [{ role: "user", content: "x" }] });
    expect(resp.text).toBe("hello world");
    expect(resp.toolCalls).toHaveLength(1);
    expect(resp.toolCalls?.[0]?.id).toBe("t1");
    expect(resp.usage?.totalTokens).toBe(30);
  });

  it("anthropic: tool_use with non-object input yields parseError", async () => {
    let p = createProfile({ rootDir: "/tmp/.lapp" });
    p = upsertProvider(p, { id: "p", protocol: "anthropic-messages", baseUrl: "https://api.anthropic.com", auth: { secret: "sk" } });
    p = upsertModel(p, { providerId: "p", id: "m", type: "chat" });
    const wrappedFetch = (async () =>
      new Response(JSON.stringify({
        content: [{ type: "tool_use", id: "t1", name: "f", input: "not-an-object" }],
        model: "m",
        stop_reason: "tool_use",
      }), { status: 200 }),
    ) as unknown as typeof fetch;
    const c = createLappClient({ profile: p, provider: "p", model: "m", resolveSecrets: true, fetchImpl: wrappedFetch });
    const resp = await c.chat({ messages: [{ role: "user", content: "x" }] });
    expect(resp.toolCalls?.[0]?.parseError).toBeDefined();
  });

  it("anthropic: tool_use with null input defaults to empty args", async () => {
    let p = createProfile({ rootDir: "/tmp/.lapp" });
    p = upsertProvider(p, { id: "p", protocol: "anthropic-messages", baseUrl: "https://api.anthropic.com", auth: { secret: "sk" } });
    p = upsertModel(p, { providerId: "p", id: "m", type: "chat" });
    const wrappedFetch = (async () =>
      new Response(JSON.stringify({
        content: [{ type: "tool_use", id: "t1", name: "f", input: null }],
        model: "m",
        stop_reason: "tool_use",
      }), { status: 200 }),
    ) as unknown as typeof fetch;
    const c = createLappClient({ profile: p, provider: "p", model: "m", resolveSecrets: true, fetchImpl: wrappedFetch });
    const resp = await c.chat({ messages: [{ role: "user", content: "x" }] });
    expect(resp.toolCalls?.[0]?.arguments).toEqual({});
  });

  it("anthropic: usage with only input_tokens", async () => {
    let p = createProfile({ rootDir: "/tmp/.lapp" });
    p = upsertProvider(p, { id: "p", protocol: "anthropic-messages", baseUrl: "https://api.anthropic.com", auth: { secret: "sk" } });
    p = upsertModel(p, { providerId: "p", id: "m", type: "chat" });
    const wrappedFetch = (async () =>
      new Response(JSON.stringify({
        content: [{ type: "text", text: "ok" }],
        model: "m",
        usage: { input_tokens: 42 },
      }), { status: 200 }),
    ) as unknown as typeof fetch;
    const c = createLappClient({ profile: p, provider: "p", model: "m", resolveSecrets: true, fetchImpl: wrappedFetch });
    const resp = await c.chat({ messages: [{ role: "user", content: "x" }] });
    expect(resp.usage?.inputTokens).toBe(42);
  });

  it("anthropic: usage with only output_tokens", async () => {
    let p = createProfile({ rootDir: "/tmp/.lapp" });
    p = upsertProvider(p, { id: "p", protocol: "anthropic-messages", baseUrl: "https://api.anthropic.com", auth: { secret: "sk" } });
    p = upsertModel(p, { providerId: "p", id: "m", type: "chat" });
    const wrappedFetch = (async () =>
      new Response(JSON.stringify({
        content: [{ type: "text", text: "ok" }],
        model: "m",
        usage: { output_tokens: 7 },
      }), { status: 200 }),
    ) as unknown as typeof fetch;
    const c = createLappClient({ profile: p, provider: "p", model: "m", resolveSecrets: true, fetchImpl: wrappedFetch });
    const resp = await c.chat({ messages: [{ role: "user", content: "x" }] });
    expect(resp.usage?.outputTokens).toBe(7);
    expect(resp.usage?.totalTokens).toBe(7);
  });

  it("openai-responses: parseResponse with function_call output items", async () => {
    let p = createProfile({ rootDir: "/tmp/.lapp" });
    p = upsertProvider(p, { id: "p", protocol: "openai-responses", baseUrl: "https://x", auth: { secret: "sk" } });
    p = upsertModel(p, { providerId: "p", id: "m", type: "chat" });
    const wrappedFetch = (async () =>
      new Response(JSON.stringify({
        output: [
          { type: "function_call", call_id: "call_1", name: "f", arguments: "{\"x\":1}" },
          { type: "output_text", content: [{ type: "output_text", text: "done" }] },
        ],
        model: "m",
        status: "completed",
      }), { status: 200 }),
    ) as unknown as typeof fetch;
    const c = createLappClient({ profile: p, provider: "p", model: "m", resolveSecrets: true, fetchImpl: wrappedFetch });
    const resp = await c.chat({ messages: [{ role: "user", content: "x" }] });
    expect(resp.text).toBe("done");
    expect(resp.toolCalls).toHaveLength(1);
    expect(resp.toolCalls?.[0]?.name).toBe("f");
  });
});

describe("stream: SSE edge cases", () => {
  it("parseSse handles multi-line data with leading space after colon", async () => {
    const { parseSse } = await import("../src/client/sse.js");
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: {\"key\":\n"));
        controller.enqueue(new TextEncoder().encode("data:  \"value\"}\n\n"));
        controller.close();
      },
    });
    const events: any[] = [];
    for await (const ev of parseSse(stream)) events.push(ev);
    expect(events).toHaveLength(1);
    expect(events[0]!.data).toBe("{\"key\":\n \"value\"}");
  });
});

describe('replaceProviderModels', () => {
  it('replaces a provider models list', () => {
    let p = createProfile({ rootDir: '/tmp/.lapp' });
    p = upsertProvider(p, { id: 'ds', protocol: 'openai-chat-completions', baseUrl: 'https://x' });
    p = upsertModel(p, { providerId: 'ds', id: 'm1', type: 'chat' });
    expect(p.providers[0]!.models?.models).toHaveLength(1);
    p = replaceProviderModels(p, 'ds', { schemaVersion: '1.0', models: [{ id: 'm2', type: 'embedding', source: 'provider' }] });
    expect(p.providers[0]!.models?.models[0]!.id).toBe('m2');
  });
  it('replaceProviderModels clears models when null is passed', () => {
    let p = createProfile({ rootDir: '/tmp/.lapp' });
    p = upsertProvider(p, { id: 'ds', protocol: 'openai-chat-completions', baseUrl: 'https://x' });
    p = upsertModel(p, { providerId: 'ds', id: 'm1', type: 'chat' });
    p = replaceProviderModels(p, 'ds', null);
    expect(p.providers[0]!.models).toBeNull();
  });
  it('replaceProviderModels throws for non-existent provider', () => {
    let p = createProfile({ rootDir: '/tmp/.lapp' });
    expect(() => replaceProviderModels(p, 'nope', null)).toThrow(/provider not found/);
  });
});
