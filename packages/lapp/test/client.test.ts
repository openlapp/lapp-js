import { describe, expect, it } from "vitest";
import { createLappClient } from "../src/client/index.js";
import type { AuthConfig, LappProfile, ModelEntry } from "../src/types.js";

function profile(
  protocol: string,
  auth: AuthConfig = { type: "bearer", secret: "secret" },
  options: {
    baseUrl?: string;
    model?: ModelEntry;
    protocols?: string[];
    requestHeaders?: Record<string, string>;
  } = {},
): LappProfile {
  const model = options.model ?? { id: "model-1", type: "chat" };
  return {
    global: {
      schemaVersion: "1.0",
      defaults: { chat: { providerId: "provider-1", modelId: model.id } },
    },
    providers: [{
      config: {
        schemaVersion: "1.0",
        id: "provider-1",
        baseUrl: options.baseUrl ?? "https://provider.example/v1",
        protocols: options.protocols ?? [protocol],
        auth,
        ...(options.requestHeaders ? { requestHeaders: options.requestHeaders } : {}),
      },
      models: { schemaVersion: "1.0", models: [model] },
    }],
  };
}

function jsonResponse(value: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

describe("createLappClient", () => {
  it("uses the chat default and the model protocol selected by resolveConnection", () => {
    const client = createLappClient({
      profile: profile("openai-chat-completions", undefined, {
        protocols: ["openai-chat-completions", "anthropic-messages"],
        model: { id: "model-1", type: "chat", protocols: ["anthropic-messages"] },
      }),
    });

    expect(client.providerId).toBe("provider-1");
    expect(client.model).toBe("model-1");
    expect(client.protocol).toBe("anthropic-messages");
  });

  it("requires provider and model together", () => {
    expect(() => createLappClient({
      profile: profile("openai-chat-completions"),
      provider: "provider-1",
    })).toThrow("provider and model must be supplied together");
  });

  it("builds an OpenAI Chat request from the resolved connection", async () => {
    let capturedUrl = "";
    let captured: RequestInit | undefined;
    const fetchImpl: typeof fetch = async (input, init) => {
      capturedUrl = String(input);
      captured = init;
      return jsonResponse({
        model: "model-1",
        choices: [{ message: { content: "hello" }, finish_reason: "stop" }],
      });
    };
    const client = createLappClient({
      profile: profile("openai-chat-completions"),
      fetchImpl,
    });

    const response = await client.chat({ messages: [{ role: "user", content: "hi" }] });

    expect(capturedUrl).toBe("https://provider.example/v1/chat/completions");
    expect(captured?.headers).toMatchObject({ Authorization: "Bearer secret" });
    expect(captured?.redirect).toBe("error");
    expect(JSON.parse(String(captured?.body))).toMatchObject({
      model: "model-1",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(response.text).toBe("hello");
  });

  it("uses only configured x-api-key auth and defaults Anthropic max_tokens to 4096", async () => {
    let captured: RequestInit | undefined;
    const fetchImpl: typeof fetch = async (_input, init) => {
      captured = init;
      return jsonResponse({ model: "model-1", content: [{ type: "text", text: "hello" }] });
    };
    const client = createLappClient({
      profile: profile("anthropic-messages", {
        type: "header",
        name: "x-api-key",
        secret: "anthropic-secret",
      }),
      fetchImpl,
    });

    await client.chat({ messages: [{ role: "user", content: "hi" }] });

    const headers = captured?.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("anthropic-secret");
    expect(headers.Authorization).toBeUndefined();
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(JSON.parse(String(captured?.body)).max_tokens).toBe(4096);
  });

  it("supports none, bearer, header, and query auth for Anthropic", async () => {
    const cases: AuthConfig[] = [
      { type: "none" },
      { type: "bearer", secret: "bearer-secret" },
      { type: "header", name: "X-Credential", secret: "header-secret" },
      { type: "query", name: "access_key", secret: "query-secret" },
    ];

    for (const auth of cases) {
      let capturedUrl = "";
      let capturedHeaders: Record<string, string> = {};
      const client = createLappClient({
        profile: profile("anthropic-messages", auth),
        fetchImpl: async (input, init) => {
          capturedUrl = String(input);
          capturedHeaders = init?.headers as Record<string, string>;
          return jsonResponse({ content: [{ type: "text", text: "ok" }] });
        },
      });

      await client.chat({ messages: [{ role: "user", content: "hi" }] });

      expect(capturedHeaders["anthropic-version"]).toBe("2023-06-01");
      if (auth.type === "bearer") expect(capturedHeaders.Authorization).toBe("Bearer bearer-secret");
      if (auth.type === "header") expect(capturedHeaders[auth.name]).toBe("header-secret");
      if (auth.type === "query") expect(new URL(capturedUrl).searchParams.get(auth.name)).toBe("query-secret");
    }
  });

  it("deduplicates anthropic-version case-insensitively", async () => {
    let capturedHeaders: Record<string, string> = {};
    const client = createLappClient({
      profile: profile(
        "anthropic-messages",
        { type: "bearer", secret: "right-secret" },
        { requestHeaders: { "Anthropic-Version": "stale" } },
      ),
      fetchImpl: async (_input, init) => {
        capturedHeaders = init?.headers as Record<string, string>;
        return jsonResponse({ content: [{ type: "text", text: "ok" }] });
      },
    });

    await client.chat({ messages: [{ role: "user", content: "hi" }] });

    expect(capturedHeaders.Authorization).toBe("Bearer right-secret");
    expect(Object.entries(capturedHeaders).filter(([name]) => name.toLowerCase() === "anthropic-version"))
      .toEqual([["anthropic-version", "2023-06-01"]]);
  });

  it("rejects auth that collides with Anthropic's required version header", async () => {
    let called = false;
    const client = createLappClient({
      profile: profile("anthropic-messages", {
        type: "header",
        name: "Anthropic-Version",
        secret: "credential",
      }),
      fetchImpl: async () => {
        called = true;
        return jsonResponse({ content: [] });
      },
    });

    await expect(client.chat({ messages: [] })).rejects.toThrow(/conflicts with required/i);
    expect(called).toBe(false);
  });

  it("uses Responses function_call items and call_id for tool history", async () => {
    let body: Record<string, unknown> | undefined;
    const fetchImpl: typeof fetch = async (_input, init) => {
      body = JSON.parse(String(init?.body));
      return jsonResponse({
        status: "completed",
        output: [{ type: "message", content: [{ type: "output_text", text: "done" }] }],
      });
    };
    const client = createLappClient({
      profile: profile("openai-responses"),
      fetchImpl,
    });

    await client.chat({
      messages: [
        { role: "assistant", content: "", toolCalls: [{ id: "call_1", name: "lookup", arguments: "{\"id\":1}" }] },
        { role: "tool", toolCallId: "call_1", content: "result" },
      ],
    });

    expect(body?.input).toEqual([
      { type: "function_call", call_id: "call_1", name: "lookup", arguments: "{\"id\":1}" },
      { type: "function_call_output", call_id: "call_1", output: "result" },
    ]);
  });

  it("applies query authentication once", async () => {
    let capturedUrl = "";
    let headers: HeadersInit | undefined;
    const fetchImpl: typeof fetch = async (input, init) => {
      capturedUrl = String(input);
      headers = init?.headers;
      return jsonResponse({ choices: [{ message: { content: "ok" } }] });
    };
    const client = createLappClient({
      profile: profile("openai-chat-completions", {
        type: "query",
        name: "key",
        secret: "a b",
      }, { baseUrl: "https://provider.example/v1?tenant=acme" }),
      fetchImpl,
    });

    await client.chat({ messages: [{ role: "user", content: "hi" }] });

    const url = new URL(capturedUrl);
    expect(url.pathname).toBe("/v1/chat/completions");
    expect(url.searchParams.get("tenant")).toBe("acme");
    expect(url.searchParams.getAll("key")).toEqual(["a b"]);
    expect(headers).not.toMatchObject({ Authorization: expect.anything() });
  });

  it("preserves a queried /v1 base URL without duplicating Anthropic's version path", async () => {
    let capturedUrl = "";
    const client = createLappClient({
      profile: profile(
        "anthropic-messages",
        { type: "query", name: "key", secret: "value" },
        { baseUrl: "https://provider.example/api/v1?tenant=acme" },
      ),
      fetchImpl: async (input) => {
        capturedUrl = String(input);
        return jsonResponse({ content: [{ type: "text", text: "ok" }] });
      },
    });

    await client.chat({ messages: [{ role: "user", content: "hi" }] });

    const url = new URL(capturedUrl);
    expect(url.pathname).toBe("/api/v1/messages");
    expect(url.searchParams.get("tenant")).toBe("acme");
    expect(url.searchParams.get("key")).toBe("value");
  });
});
