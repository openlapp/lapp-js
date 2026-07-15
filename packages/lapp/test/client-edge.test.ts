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

function response(value: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(value), { status: 200, ...init });
}

function sse(data: string): Response {
  return new Response(`data: ${data}\n\n`, {
    headers: { "content-type": "text/event-stream" },
  });
}

describe("client request boundary", () => {
  for (const protocol of [
    "openai-chat-completions",
    "openai-responses",
    "anthropic-messages",
  ]) {
    it(`${protocol}: rejects extra fields that bypass resolved model`, async () => {
      let called = false;
      const client = createLappClient({
        profile: profile(protocol, protocol === "anthropic-messages"
          ? { type: "header", name: "x-api-key", secret: "secret" }
          : undefined),
        fetchImpl: async () => {
          called = true;
          return response({});
        },
      });

      await expect(client.chat({
        messages: [{ role: "user", content: "hi" }],
        extra: { model: "bypass" },
      })).rejects.toThrow("extra field is reserved: model");
      expect(called).toBe(false);
    });
  }

  it("rejects conversation, stream, tool, and auth overrides in extra", async () => {
    const client = createLappClient({
      profile: profile("openai-chat-completions"),
      fetchImpl: async () => response({}),
    });

    for (const key of ["messages", "input", "instructions", "stream", "tools", "tool_choice", "Authorization", "api_key"]) {
      await expect(client.chat({
        messages: [{ role: "user", content: "hi" }],
        extra: { [key]: "bypass" },
      })).rejects.toThrow(`extra field is reserved: ${key}`);
    }
  });

  it("passes AbortSignal and redirect:error to fetch", async () => {
    const controller = new AbortController();
    let captured: RequestInit | undefined;
    const client = createLappClient({
      profile: profile("openai-chat-completions"),
      fetchImpl: async (_input, init) => {
        captured = init;
        return response({ choices: [{ message: { content: "ok" } }] });
      },
    });

    await client.chat({
      messages: [{ role: "user", content: "hi" }],
      signal: controller.signal,
    });

    expect(captured?.signal).toBe(controller.signal);
    expect(captured?.redirect).toBe("error");
  });

  it("does not call fetch when already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("stop"));
    let called = false;
    const client = createLappClient({
      profile: profile("openai-chat-completions"),
      fetchImpl: async () => {
        called = true;
        return response({});
      },
    });

    await expect(client.chat({
      messages: [{ role: "user", content: "hi" }],
      signal: controller.signal,
    })).rejects.toThrow("stop");
    expect(called).toBe(false);
  });

  it("rejects stream:true on non-stream chat methods", async () => {
    const client = createLappClient({
      profile: profile("openai-chat-completions"),
      fetchImpl: async () => response({}),
    });

    await expect(client.chat({ messages: [], stream: true })).rejects.toThrow("use client.stream()");
    await expect(client.rawChat({ messages: [], stream: true })).rejects.toThrow("use client.stream()");
  });

  it("reports HTTP stream failures without parsing them as SSE", async () => {
    const client = createLappClient({
      profile: profile("openai-chat-completions"),
      fetchImpl: async () => new Response("upstream failed", { status: 503 }),
    });

    const consume = async () => {
      for await (const _event of client.stream({ messages: [{ role: "user", content: "hi" }] })) {
        // consume
      }
    };
    await expect(consume()).rejects.toThrow("provider p returned 503");
  });

  for (const protocol of [
    "openai-chat-completions",
    "openai-responses",
    "anthropic-messages",
  ]) {
    it(`${protocol}: rejects malformed successful responses on all non-stream paths`, async () => {
      const client = createLappClient({
        profile: profile(protocol),
        fetchImpl: async () => response({}),
      });

      await expect(client.chat({ messages: [{ role: "user", content: "hi" }] }))
        .rejects.toThrow(`invalid ${protocol} response`);
      await expect(client.rawChat({ messages: [{ role: "user", content: "hi" }] }))
        .rejects.toThrow(`invalid ${protocol} response`);
      await expect(client.testConnection()).resolves.toMatchObject({
        ok: false,
        message: `invalid ${protocol} response`,
      });
    });
  }

  it("redacts the resolved opaque credential from non-stream HTTP errors and Error.raw", async () => {
    const credential = "opaque/value +47!";
    const auth: AuthConfig = { type: "header", name: "X-Credential", secret: "env://TOKEN" };
    const failing = createLappClient({
      profile: profile("openai-chat-completions", auth),
      env: { TOKEN: credential },
      fetchImpl: async () => response({ error: `echo ${credential}` }, { status: 401 }),
    });
    const error = await failing.chat({ messages: [] }).catch((caught: unknown) => caught as Error & { raw?: unknown });
    expect(error.message).not.toContain(credential);
    expect(JSON.stringify(error.raw)).not.toContain(credential);
    expect(JSON.stringify(error.raw)).toContain("<redacted>");

    const streamFailure = createLappClient({
      profile: profile("openai-chat-completions", auth),
      env: { TOKEN: credential },
      fetchImpl: async () => response({ [credential]: credential }, { status: 502 }),
    });
    const consume = async () => {
      for await (const _event of streamFailure.stream({ messages: [] })) {
        // consume
      }
    };
    const streamError = await consume().catch((caught: unknown) => caught as Error & { raw?: unknown });
    expect(streamError.message).not.toContain(credential);
    expect(JSON.stringify(streamError.raw)).not.toContain(credential);
  });

  it("preserves successful provider-native data even when it equals the credential", async () => {
    const credential = "opaque-success-credential!";
    const client = createLappClient({
      profile: profile("openai-chat-completions", {
        type: "header",
        name: "X-Credential",
        secret: credential,
      }),
      fetchImpl: async () => response({ choices: [{ message: { content: credential } }] }),
    });

    const parsed = await client.chat({ messages: [] });
    const raw = await client.rawChat({ messages: [] }) as { choices: Array<{ message: { content: string } }> };
    expect(parsed.text).toBe(credential);
    expect(raw.choices[0]?.message.content).toBe(credential);
  });

  it("redacts the resolved opaque credential from fetch errors and malformed SSE errors", async () => {
    const credential = "opaque-fetch-credential!";
    const auth: AuthConfig = { type: "query", name: "key", secret: credential };
    const fetchFailure = createLappClient({
      profile: profile("openai-chat-completions", auth),
      fetchImpl: async () => {
        throw Object.assign(new Error(`fetch failed for ${credential}`), {
          raw: { credential },
        });
      },
    });
    const fetchError = await fetchFailure.chat({ messages: [] })
      .catch((caught: unknown) => caught as Error & { raw?: unknown });
    expect(fetchError.message).not.toContain(credential);
    expect(JSON.stringify(fetchError.raw)).not.toContain(credential);

    const malformedStream = createLappClient({
      profile: profile("openai-chat-completions", auth),
      fetchImpl: async () => sse(`not-json ${credential}`),
    });
    const events = [];
    for await (const event of malformedStream.stream({ messages: [] })) events.push(event);
    expect(events).toEqual([{
      kind: "error",
      message: "invalid JSON in stream: not-json <redacted>",
    }]);
  });
});
