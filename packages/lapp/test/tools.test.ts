import { describe, expect, it } from "vitest";
import { createLappClient } from "../src/client/index.js";
import type { AuthConfig, LappProfile } from "../src/types.js";

function profile(protocol: string, auth: AuthConfig = { type: "bearer", secret: "secret" }): LappProfile {
  return {
    global: {
      schemaVersion: "1.0",
      defaults: { chat: { providerId: "p", modelId: "m" } },
    },
    providers: [{
      config: {
        schemaVersion: "1.0",
        id: "p",
        baseUrl: "https://provider.example/v1",
        protocols: [protocol],
        auth,
      },
      models: { schemaVersion: "1.0", models: [{ id: "m", type: "chat" }] },
    }],
  };
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200 });
}

function sse(events: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(events.map((event) => `data: ${event}\n\n`).join("")));
      controller.close();
    },
  }));
}

const addTool = {
  name: "add",
  parameters: {
    type: "object",
    properties: { a: { type: "number" }, b: { type: "number" } },
    required: ["a", "b"],
    additionalProperties: false,
  },
};

describe("executeWithTools", () => {
  it("returns a closed transcript including the final assistant", async () => {
    const replies = [
      {
        choices: [{
          message: {
            content: "",
            tool_calls: [{
              id: "call_1",
              type: "function",
              function: { name: "add", arguments: "{\"a\":1,\"b\":2}" },
            }],
          },
          finish_reason: "tool_calls",
        }],
      },
      { choices: [{ message: { content: "3" }, finish_reason: "stop" }] },
    ];
    const client = createLappClient({
      profile: profile("openai-chat-completions"),
      fetchImpl: async () => json(replies.shift()),
    });

    const result = await client.executeWithTools(
      { messages: [{ role: "user", content: "1 + 2" }] },
      [addTool],
      { add: ({ a, b }) => String(Number(a) + Number(b)) },
    );

    expect(result.text).toBe("3");
    expect(result.turns).toBe(2);
    expect(result.messages).toEqual([
      { role: "user", content: "1 + 2" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call_1", name: "add", arguments: "{\"a\":1,\"b\":2}" }],
      },
      { role: "tool", content: "3", toolCallId: "call_1", name: "add" },
      { role: "assistant", content: "3" },
    ]);
  });

  it("does not execute a handler when tool arguments are malformed JSON", async () => {
    let handlerCalls = 0;
    const replies = [
      {
        choices: [{ message: { tool_calls: [{
          id: "call_1",
          type: "function",
          function: { name: "add", arguments: "{" },
        }] } }],
      },
      { choices: [{ message: { content: "recovered" } }] },
    ];
    const requestBodies: Array<Record<string, unknown>> = [];
    const client = createLappClient({
      profile: profile("openai-chat-completions"),
      fetchImpl: async (_input, init) => {
        requestBodies.push(JSON.parse(String(init?.body)));
        return json(replies.shift());
      },
    });

    await client.executeWithTools(
      { messages: [{ role: "user", content: "add" }] },
      [addTool],
      { add: () => { handlerCalls++; return "wrong"; } },
    );

    expect(handlerCalls).toBe(0);
    expect(JSON.stringify(requestBodies[1])).toContain("error: invalid arguments for tool");
  });

  it("does not execute a handler when arguments fail the declared schema", async () => {
    let handlerCalls = 0;
    const replies = [
      {
        choices: [{ message: { tool_calls: [{
          id: "call_1",
          type: "function",
          function: { name: "add", arguments: "{\"a\":1}" },
        }] } }],
      },
      { choices: [{ message: { content: "recovered" } }] },
    ];
    const client = createLappClient({
      profile: profile("openai-chat-completions"),
      fetchImpl: async () => json(replies.shift()),
    });

    await client.executeWithTools(
      { messages: [{ role: "user", content: "add" }] },
      [addTool],
      { add: () => { handlerCalls++; return "wrong"; } },
    );

    expect(handlerCalls).toBe(0);
  });

  it("passes the loop AbortSignal to every provider fetch", async () => {
    const controller = new AbortController();
    const signals: Array<AbortSignal | null | undefined> = [];
    const client = createLappClient({
      profile: profile("openai-chat-completions"),
      fetchImpl: async (_input, init) => {
        signals.push(init?.signal);
        return json({ choices: [{ message: { content: "done" } }] });
      },
    });

    await client.executeWithTools(
      { messages: [{ role: "user", content: "done" }] },
      [],
      {},
      { signal: controller.signal },
    );

    expect(signals).toEqual([controller.signal]);
  });
});

describe("provider-native tool streaming", () => {
  it("OpenAI Chat accumulates tool arguments once", async () => {
    const client = createLappClient({
      profile: profile("openai-chat-completions"),
      fetchImpl: async () => sse([
        JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "add", arguments: "{\"a\":" } }] } }] }),
        JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "1,\"b\":2}" } }] }, finish_reason: "tool_calls" }] }),
        "[DONE]",
      ]),
    });

    const events = [];
    for await (const event of client.stream({ messages: [{ role: "user", content: "add" }] })) events.push(event);

    expect(events.filter((event) => event.kind === "tool-call")).toEqual([
      { kind: "tool-call", id: "call_1", name: "add", arguments: "{\"a\":1,\"b\":2}" },
    ]);
  });

  it("OpenAI Responses correlates by item.id but exposes call_id", async () => {
    const client = createLappClient({
      profile: profile("openai-responses"),
      fetchImpl: async () => sse([
        JSON.stringify({ type: "response.output_item.added", item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "add", arguments: "" } }),
        JSON.stringify({ type: "response.function_call_arguments.delta", item_id: "fc_1", delta: "{\"a\":1,\"b\":2}" }),
        JSON.stringify({ type: "response.completed", response: { status: "completed" } }),
      ]),
    });

    const events = [];
    for await (const event of client.stream({ messages: [{ role: "user", content: "add" }] })) events.push(event);

    expect(events.filter((event) => event.kind === "tool-call")).toEqual([
      { kind: "tool-call", id: "call_1", name: "add", arguments: "{\"a\":1,\"b\":2}" },
    ]);
  });

  it("Anthropic emits tool_use with the provider call id", async () => {
    const client = createLappClient({
      profile: profile("anthropic-messages", { type: "header", name: "x-api-key", secret: "secret" }),
      fetchImpl: async () => sse([
        JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "add" } }),
        JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"a\":1,\"b\":2}" } }),
        JSON.stringify({ type: "message_stop" }),
      ]),
    });

    const events = [];
    for await (const event of client.stream({ messages: [{ role: "user", content: "add" }] })) events.push(event);

    expect(events.filter((event) => event.kind === "tool-call")).toEqual([
      { kind: "tool-call", id: "toolu_1", name: "add", arguments: "{\"a\":1,\"b\":2}" },
    ]);
  });
});
