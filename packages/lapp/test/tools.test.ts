/**
 * Tool-calling coverage: per-adapter request building, response parsing, and
 * the `executeWithTools` multi-turn loop.
 */

import { describe, it, expect } from "vitest";
import {
  createLappClient,
  type ChatInput,
} from "../src/index.js";
import { createProfile, upsertProvider, upsertModel } from "../src/index.js";

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

describe("openai-chat: tool request building", () => {
  it("emits tools + tool_choice when provided", async () => {
    const p = baseProfile();
    let captured: { body: { tools?: unknown; tool_choice?: unknown } } | null = null;
    const wrappedFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      captured = { body: JSON.parse((init?.body as string) ?? "{}") };
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const c = createLappClient({ profile: p, provider: "p", model: "m", resolveSecrets: true, fetchImpl: wrappedFetch });
    await c.chat({
      messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "echo", description: "echoes args", parameters: { type: "object", properties: { x: { type: "string" } } } }],
      toolChoice: "auto",
    } as ChatInput);
    expect(captured!.body.tools).toEqual([
      { type: "function", function: { name: "echo", description: "echoes args", parameters: { type: "object", properties: { x: { type: "string" } } } } },
    ]);
    expect(captured!.body.tool_choice).toBe("auto");
  });

  it("parses tool_calls in response with parsed arguments", async () => {
    const p = baseProfile();
    const wrappedFetch = (async () =>
      new Response(JSON.stringify({
        choices: [{
          message: {
            content: "",
            tool_calls: [{
              id: "call_1",
              function: { name: "echo", arguments: '{"x":"y"}' },
            }],
          },
        }],
      }), { status: 200 })) as unknown as typeof fetch;
    const c = createLappClient({ profile: p, provider: "p", model: "m", resolveSecrets: true, fetchImpl: wrappedFetch });
    const resp = await c.chat({ messages: [{ role: "user", content: "hi" }] } as ChatInput);
    expect(resp.toolCalls).toEqual([{ id: "call_1", name: "echo", arguments: { x: "y" } }]);
  });

  it("tolerates malformed JSON in tool arguments (parseError flag)", async () => {
    const p = baseProfile();
    const wrappedFetch = (async () =>
      new Response(JSON.stringify({
        choices: [{ message: { tool_calls: [{ id: "c1", function: { name: "f", arguments: "{not-json" } }] } }],
      }), { status: 200 })) as unknown as typeof fetch;
    const c = createLappClient({ profile: p, provider: "p", model: "m", resolveSecrets: true, fetchImpl: wrappedFetch });
    const resp = await c.chat({ messages: [{ role: "user", content: "hi" }] } as ChatInput);
    expect(resp.toolCalls?.[0]?.parseError).toBeDefined();
    expect(resp.toolCalls?.[0]?.argumentsRaw).toBe("{not-json");
  });
});

describe("openai-responses: tool request building", () => {
  it("emits tools with name/description/parameters and parses function_call output items", async () => {
    let p = createProfile({ rootDir: "/tmp/.lapp" });
    p = upsertProvider(p, { id: "p", protocol: "openai-responses", baseUrl: "https://x", auth: { secret: "sk" } });
    p = upsertModel(p, { providerId: "p", id: "m", type: "chat" });
    let captured: { body: { tools?: Array<{ type: string; name: string; parameters?: unknown }> } } | null = null;
    const wrappedFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      captured = { body: JSON.parse((init?.body as string) ?? "{}") };
      return new Response(JSON.stringify({
        output: [{ type: "function_call", call_id: "call_1", name: "echo", arguments: '{"x":1}' }],
      }), { status: 200 });
    }) as unknown as typeof fetch;
    const c = createLappClient({ profile: p, provider: "p", model: "m", resolveSecrets: true, fetchImpl: wrappedFetch });
    const resp = await c.chat({
      messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "echo", parameters: { type: "object" } }],
    } as ChatInput);
    expect(captured!.body.tools?.[0]).toMatchObject({ type: "function", name: "echo" });
    expect(resp.toolCalls?.[0]).toMatchObject({ id: "call_1", name: "echo", arguments: { x: 1 } });
  });
});

describe("anthropic-messages: tool request building", () => {
  it("emits input_schema tools and parses tool_use content blocks", async () => {
    let p = createProfile({ rootDir: "/tmp/.lapp" });
    p = upsertProvider(p, { id: "p", protocol: "anthropic-messages", baseUrl: "https://api.anthropic.com", auth: { secret: "sk" } });
    p = upsertModel(p, { providerId: "p", id: "m", type: "chat" });
    let captured: { body: { tools?: Array<{ name: string; input_schema?: unknown }> } } | null = null;
    const wrappedFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      captured = { body: JSON.parse((init?.body as string) ?? "{}") };
      return new Response(JSON.stringify({
        content: [{ type: "tool_use", id: "t1", name: "echo", input: { x: 1 } }],
      }), { status: 200 });
    }) as unknown as typeof fetch;
    const c = createLappClient({ profile: p, provider: "p", model: "m", resolveSecrets: true, fetchImpl: wrappedFetch });
    const resp = await c.chat({
      messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "echo", parameters: { type: "object" } }],
    } as ChatInput);
    expect(captured!.body.tools?.[0]).toMatchObject({ name: "echo", input_schema: { type: "object" } });
    expect(resp.toolCalls?.[0]).toMatchObject({ id: "t1", name: "echo", arguments: { x: 1 } });
  });

  it("anthropic-messages: assistant text + toolCalls round-trip together", async () => {
    // Regression: assistant content with reasoning text + tool calls must
    // produce mixed text + tool_use blocks on the next request, otherwise
    // the model's prior reasoning is lost mid-loop.
    let p = createProfile({ rootDir: "/tmp/.lapp" });
    p = upsertProvider(p, { id: "p", protocol: "anthropic-messages", baseUrl: "https://api.anthropic.com", auth: { secret: "sk" } });
    p = upsertModel(p, { providerId: "p", id: "m", type: "chat" });
    let captured: { body: { messages?: Array<{ role: string; content: unknown }> } } | null = null;
    const wrappedFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      captured = { body: JSON.parse((init?.body as string) ?? "{}") };
      return new Response(JSON.stringify({ content: [{ type: "text", text: "final" }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const c = createLappClient({ profile: p, provider: "p", model: "m", resolveSecrets: true, fetchImpl: wrappedFetch });
    await c.chat({
      messages: [
        { role: "user", content: "do it" },
        {
          role: "assistant",
          content: "thinking about it",
          toolCalls: [{ id: "t1", name: "echo", arguments: '{"x":1}' }],
        },
        { role: "tool", toolCallId: "t1", content: "result" },
      ],
    } as ChatInput);
    const assistantContent = captured!.body.messages!.find((m) => m.role === "assistant")!.content as Array<{ type: string; text?: string; id?: string }>;
    const types = assistantContent.map((b) => b.type);
    expect(types).toContain("text");
    expect(types).toContain("tool_use");
    expect(assistantContent.find((b) => b.type === "text")!.text).toBe("thinking about it");
    expect(assistantContent.find((b) => b.type === "tool_use")!.id).toBe("t1");
  });
});

describe("executeWithTools", () => {
  it("loops until the model returns no tool calls", async () => {
    const p = baseProfile();
    const toolArgs = JSON.stringify({ a: 2, b: 3 });
    // First call: model asks to call "add(2,3)". Second call: final answer.
    const responses = [
      new Response(JSON.stringify({
        choices: [{ message: { content: "", tool_calls: [{ id: "c1", function: { name: "add", arguments: toolArgs } }] } }],
      }), { status: 200 }),
      new Response(JSON.stringify({
        choices: [{ message: { content: "5" } }],
      }), { status: 200 }),
    ];
    let i = 0;
    const wrappedFetch = (async () => responses[i++]!) as unknown as typeof fetch;
    const c = createLappClient({ profile: p, provider: "p", model: "m", resolveSecrets: true, fetchImpl: wrappedFetch });
    const out = await c.executeWithTools(
      { messages: [{ role: "user", content: "sum" }] },
      [{ name: "add", parameters: { type: "object" } }],
      { add: (args) => String((args.a as number) + (args.b as number)) },
    );
    expect(out.text).toBe("5");
    expect(out.turns).toBe(2);
    // 1 user + 1 assistant echo + 1 tool result = 3 messages at end.
    expect(out.messages).toHaveLength(3);
    expect(out.messages[1]?.role).toBe("assistant");
    expect(out.messages[1]?.toolCalls?.[0]?.name).toBe("add");
    expect(out.messages[2]?.role).toBe("tool");
    expect(out.messages[2]?.toolCallId).toBe("c1");
  });

  it("captures handler errors as tool result of `error: ...`", async () => {
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
      { boom: () => { throw new Error("kaboom"); } },
    );
    expect(out.text).toBe("ok");
    const toolMsg = out.messages.find((m) => m.role === "tool");
    expect(toolMsg?.content).toMatch(/error: kaboom/);
  });

  it("throws when maxTurns is exceeded", async () => {
    const p = baseProfile();
    const wrappedFetch = (async () =>
      new Response(JSON.stringify({
        choices: [{ message: { tool_calls: [{ id: "c1", function: { name: "loop", arguments: "{}" } }] } }],
      }), { status: 200 })) as unknown as typeof fetch;
    const c = createLappClient({ profile: p, provider: "p", model: "m", resolveSecrets: true, fetchImpl: wrappedFetch });
    await expect(c.executeWithTools(
      { messages: [{ role: "user", content: "x" }] },
      [{ name: "loop", parameters: { type: "object" } }],
      { loop: () => "still going" },
      { maxTurns: 2 },
    )).rejects.toThrow(/maxTurns/);
  });

  it("treats missing handler as tool result of `error: no handler...`", async () => {
    const p = baseProfile();
    const responses = [
      new Response(JSON.stringify({
        choices: [{ message: { tool_calls: [{ id: "c1", function: { name: "nope", arguments: "{}" } }] } }],
      }), { status: 200 }),
      new Response(JSON.stringify({ choices: [{ message: { content: "done" } }] }), { status: 200 }),
    ];
    let i = 0;
    const wrappedFetch = (async () => responses[i++]!) as unknown as typeof fetch;
    const c = createLappClient({ profile: p, provider: "p", model: "m", resolveSecrets: true, fetchImpl: wrappedFetch });
    const out = await c.executeWithTools(
      { messages: [{ role: "user", content: "x" }] },
      [{ name: "nope", parameters: { type: "object" } }],
      {},
    );
    const toolMsg = out.messages.find((m) => m.role === "tool");
    expect(toolMsg?.content).toMatch(/no handler/);
    expect(out.text).toBe("done");
  });
});

describe("per-adapter parseStream", () => {
  it("openai-chat: emits deltas and finish; accumulates tool-call args", async () => {
    let p = createProfile({ rootDir: "/tmp/.lapp" });
    p = upsertProvider(p, { id: "p", protocol: "openai-chat-completions", baseUrl: "https://x", auth: { secret: "sk" } });
    p = upsertModel(p, { providerId: "p", id: "m", type: "chat" });
    const sse =
      'data: {"choices":[{"delta":{"content":"he"}},{}]}' + "\n\n" +
      'data: {"choices":[{"delta":{"content":"llo"},"finish_reason":"stop"}]}' + "\n\n" +
      'data: [DONE]' + "\n\n";
    const wrappedFetch = (async () => new Response(makeStream(sse), { status: 200 })) as unknown as typeof fetch;
    const c = createLappClient({ profile: p, provider: "p", model: "m", resolveSecrets: true, fetchImpl: wrappedFetch });
    const events = [];
    for await (const ev of c.stream({ messages: [{ role: "user", content: "x" }] })) events.push(ev);
    const deltas = events.filter((e) => e.kind === "delta");
    expect(deltas.map((d) => (d as { text: string }).text).join("")).toBe("hello");
    expect(events.some((e) => e.kind === "finish" && (e as { reason: string }).reason === "stop")).toBe(true);
  });

  it("openai-responses: emits deltas on response.output_text.delta and finish on response.completed", async () => {
    let p = createProfile({ rootDir: "/tmp/.lapp" });
    p = upsertProvider(p, { id: "p", protocol: "openai-responses", baseUrl: "https://x", auth: { secret: "sk" } });
    p = upsertModel(p, { providerId: "p", id: "m", type: "chat" });
    const sse =
      'data: {"type":"response.output_text.delta","delta":"foo"}' + "\n\n" +
      'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":1,"output_tokens":1}}}' + "\n\n";
    const wrappedFetch = (async () => new Response(makeStream(sse), { status: 200 })) as unknown as typeof fetch;
    const c = createLappClient({ profile: p, provider: "p", model: "m", resolveSecrets: true, fetchImpl: wrappedFetch });
    const events = [];
    for await (const ev of c.stream({ messages: [{ role: "user", content: "x" }] })) events.push(ev);
    expect(events.some((e) => e.kind === "delta" && (e as { text: string }).text === "foo")).toBe(true);
    expect(events.some((e) => e.kind === "finish" && (e as { reason: string }).reason === "completed")).toBe(true);
  });

  it("anthropic-messages: emits deltas on content_block_delta text_delta", async () => {
    let p = createProfile({ rootDir: "/tmp/.lapp" });
    p = upsertProvider(p, { id: "p", protocol: "anthropic-messages", baseUrl: "https://api.anthropic.com", auth: { secret: "sk" } });
    p = upsertModel(p, { providerId: "p", id: "m", type: "chat" });
    const sse =
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}' + "\n\n" +
      'data: {"type":"message_stop"}' + "\n\n";
    const wrappedFetch = (async () => new Response(makeStream(sse), { status: 200 })) as unknown as typeof fetch;
    const c = createLappClient({ profile: p, provider: "p", model: "m", resolveSecrets: true, fetchImpl: wrappedFetch });
    const events = [];
    for await (const ev of c.stream({ messages: [{ role: "user", content: "x" }] })) events.push(ev);
    expect(events.some((e) => e.kind === "delta" && (e as { text: string }).text === "hi")).toBe(true);
    expect(events.some((e) => e.kind === "finish" && (e as { reason: string }).reason === "stop")).toBe(true);
  });

  it("allows stream even when model capabilities omit `stream` (adapter check is authoritative)", async () => {
    let p = createProfile({ rootDir: "/tmp/.lapp" });
    p = upsertProvider(p, { id: "p", protocol: "openai-chat-completions", baseUrl: "https://x", auth: { secret: "sk" } });
    p = upsertModel(p, { providerId: "p", id: "m", type: "chat", capabilities: ["chat"] });
    const sse = 'data: {"choices":[{"delta":{"content":"ok"}}],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\n' +
      'data: [DONE]\n\n';
    const wrappedFetch = (async () => new Response(makeStream(sse), { status: 200 })) as unknown as typeof fetch;
    const c = createLappClient({ profile: p, provider: "p", model: "m", resolveSecrets: true, fetchImpl: wrappedFetch });
    const events = [];
    for await (const ev of c.stream({ messages: [{ role: "user", content: "x" }] })) events.push(ev);
    expect(events.some((e) => e.kind === "delta" && (e as { text: string }).text === "ok")).toBe(true);
  });
});

// Regression coverage for the streaming tool-call bugs caught in the Round 4
// review: (1) the in-loop + post-loop flush both yielded tool calls on a
// normal completion (accumulator never cleared), and (2) the openai-responses
// stream keyed the accumulator by `item.call_id` while deltas correlate by
// `item.id` (the Responses API uses distinct identifiers for these).
describe("streaming tool-call regressions", () => {
  it("openai-chat: yields each tool-call exactly once on a normal completion", async () => {
    let p = createProfile({ rootDir: "/tmp/.lapp" });
    p = upsertProvider(p, { id: "p", protocol: "openai-chat-completions", baseUrl: "https://x", auth: { secret: "sk" } });
    p = upsertModel(p, { providerId: "p", id: "m", type: "chat" });
    const sse =
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"f","arguments":"{\\"x\\":"}}]}}]}' + "\n\n" +
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"1}"}}]},"finish_reason":"tool_calls"}]}' + "\n\n" +
      'data: [DONE]' + "\n\n";
    const wf = (async () => new Response(makeStream(sse), { status: 200 })) as unknown as typeof fetch;
    const c = createLappClient({ profile: p, provider: "p", model: "m", resolveSecrets: true, fetchImpl: wf });
    const events: any[] = [];
    for await (const ev of c.stream({ messages: [{ role: "user", content: "x" }] })) events.push(ev);
    expect(events.filter((e) => e.kind === "tool-call")).toHaveLength(1);
  });

  it("openai-chat: truncated stream still flushes tool calls when no finish_reason arrives", async () => {
    let p = createProfile({ rootDir: "/tmp/.lapp" });
    p = upsertProvider(p, { id: "p", protocol: "openai-chat-completions", baseUrl: "https://x", auth: { secret: "sk" } });
    p = upsertModel(p, { providerId: "p", id: "m", type: "chat" });
    const sse =
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"f","arguments":"{\\"x\\":1}"}}]}}]}' + "\n\n";
    const wf = (async () => new Response(makeStream(sse), { status: 200 })) as unknown as typeof fetch;
    const c = createLappClient({ profile: p, provider: "p", model: "m", resolveSecrets: true, fetchImpl: wf });
    const events: any[] = [];
    for await (const ev of c.stream({ messages: [{ role: "user", content: "x" }] })) events.push(ev);
    expect(events.filter((e) => e.kind === "tool-call")).toHaveLength(1);
  });

  it("openai-responses: deltas keyed by item.id (not call_id) accumulate correctly", async () => {
    let p = createProfile({ rootDir: "/tmp/.lapp" });
    p = upsertProvider(p, { id: "p", protocol: "openai-responses", baseUrl: "https://x", auth: { secret: "sk" } });
    p = upsertModel(p, { providerId: "p", id: "m", type: "chat" });
    // Real OpenAI Responses stream: item.id="fc_1" (output item id), item.call_id="call_1".
    // Deltas carry top-level item_id="fc_1". Previous keying-by-call_id dropped the args.
    const sse =
      'data: {"type":"response.output_item.added","item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"f","arguments":""}}' + "\n\n" +
      'data: {"type":"response.function_call_arguments.delta","item_id":"fc_1","delta":"{\\"x\\":1}"}' + "\n\n" +
      'data: {"type":"response.completed","response":{"status":"completed"}}' + "\n\n";
    const wf = (async () => new Response(makeStream(sse), { status: 200 })) as unknown as typeof fetch;
    const c = createLappClient({ profile: p, provider: "p", model: "m", resolveSecrets: true, fetchImpl: wf });
    const events: any[] = [];
    for await (const ev of c.stream({ messages: [{ role: "user", content: "x" }] })) events.push(ev);
    const tc = events.filter((e) => e.kind === "tool-call");
    expect(tc).toHaveLength(1);
    expect(tc[0]!.arguments).toBe('{"x":1}');
  });

  it("anthropic-messages: message_start usage.input_tokens is captured for the usage event", async () => {
    let p = createProfile({ rootDir: "/tmp/.lapp" });
    p = upsertProvider(p, { id: "p", protocol: "anthropic-messages", baseUrl: "https://api.anthropic.com", auth: { secret: "sk" } });
    p = upsertModel(p, { providerId: "p", id: "m", type: "chat" });
    const sse =
      'data: {"type":"message_start","message":{"usage":{"input_tokens":42,"output_tokens":1}}}' + "\n\n" +
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}' + "\n\n" +
      'data: {"type":"message_delta","usage":{"output_tokens":5}}' + "\n\n" +
      'data: {"type":"message_stop"}' + "\n\n";
    const wf = (async () => new Response(makeStream(sse), { status: 200 })) as unknown as typeof fetch;
    const c = createLappClient({ profile: p, provider: "p", model: "m", resolveSecrets: true, fetchImpl: wf });
    const events: any[] = [];
    for await (const ev of c.stream({ messages: [{ role: "user", content: "x" }] })) events.push(ev);
    const usage = events.filter((e) => e.kind === "usage");
    expect(usage).toHaveLength(1);
    expect(usage[0]!.inputTokens).toBe(42);
    expect(usage[0]!.outputTokens).toBe(5);
  });
});
