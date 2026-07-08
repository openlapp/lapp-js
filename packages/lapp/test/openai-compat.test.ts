import { describe, it, expect } from "vitest";
import { fetchOpenAiCompatModels } from "../src/sync/openai-compat.js";

function stubFetch(status: number, body: unknown, contentType = "application/json"): typeof fetch {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return (async () =>
    new Response(text, { status, headers: { "content-type": contentType } }),
  ) as unknown as typeof fetch;
}

const baseCtx = {
  providerId: "test",
  protocol: "openai-chat-completions",
  baseUrl: "https://api.test/v1",
  secret: "sk-test",
};

describe("fetchOpenAiCompatModels", () => {
  // --- positive cases ---

  it("parses standard /models response", async () => {
    const models = await fetchOpenAiCompatModels(
      baseCtx,
      stubFetch(200, { data: [{ id: "gpt-4o", owned_by: "openai" }] }),
    );
    expect(models.map((m) => m.id)).toEqual(["gpt-4o"]);
    expect(models[0]!.ownedBy).toBe("openai");
  });

  it("accepts Ollama name field", async () => {
    const models = await fetchOpenAiCompatModels(
      baseCtx,
      stubFetch(200, { data: [{ name: "llama3:latest" }] }),
    );
    expect(models[0]!.id).toBe("llama3:latest");
    expect(models[0]!.name).toBe("llama3:latest");
  });

  it("uses provided modelsUrl", async () => {
    let capturedUrl = "";
    const fetchImpl = (async (input: RequestInfo | URL) => {
      capturedUrl = String(input);
      return new Response(JSON.stringify({ data: [{ id: "custom" }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const models = await fetchOpenAiCompatModels(baseCtx, fetchImpl, "https://custom.api/list");
    expect(capturedUrl).toBe("https://custom.api/list");
    expect(models[0]!.id).toBe("custom");
  });

  it("strips trailing slash from baseUrl", async () => {
    let capturedUrl = "";
    const fetchImpl = (async (input: RequestInfo | URL) => {
      capturedUrl = String(input);
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    await fetchOpenAiCompatModels({ ...baseCtx, baseUrl: "https://api.test/" }, fetchImpl);
    expect(capturedUrl).toBe("https://api.test/models");
  });

  it("accepts null/empty secret", async () => {
    const models = await fetchOpenAiCompatModels(
      { ...baseCtx, secret: "" },
      stubFetch(200, { data: [{ id: "m" }] }),
    );
    expect(models).toHaveLength(1);
  });

  it("accepts custom-header auth type", async () => {
    let capturedHeaders: Record<string, string> = {};
    const fetchImpl = (async (_u: RequestInfo | URL, init?: RequestInit) => {
      capturedHeaders = (init?.headers as Record<string, string>) ?? {};
      return new Response(JSON.stringify({ data: [{ id: "m" }] }), { status: 200 });
    }) as unknown as typeof fetch;
    await fetchOpenAiCompatModels(
      { ...baseCtx, authType: "custom-header", authHeader: "X-API-Key" },
      fetchImpl,
    );
    expect(capturedHeaders["X-API-Key"]).toBe("sk-test");
    expect(capturedHeaders["X-API-Key"]).not.toContain("Bearer");
  });

  it("falls back to Bearer for unknown auth type", async () => {
    let capturedHeaders: Record<string, string> = {};
    const fetchImpl = (async (_u: RequestInfo | URL, init?: RequestInit) => {
      capturedHeaders = (init?.headers as Record<string, string>) ?? {};
      return new Response(JSON.stringify({ data: [{ id: "m" }] }), { status: 200 });
    }) as unknown as typeof fetch;
    await fetchOpenAiCompatModels(
      { ...baseCtx, authType: "unknown-type", secret: "sk-x" },
      fetchImpl,
    );
    expect(capturedHeaders["Authorization"]).toBe("Bearer sk-x");
  });

  it("maps entry name to id when name is present alongside id", async () => {
    const models = await fetchOpenAiCompatModels(
      baseCtx,
      stubFetch(200, { data: [{ id: "model-1", name: "Model One" }] }),
    );
    expect(models[0]!.id).toBe("model-1");
    expect(models[0]!.name).toBe("Model One");
  });

  it("returns empty array for non-JSON response body", async () => {
    const models = await fetchOpenAiCompatModels(
      baseCtx,
      stubFetch(200, "plain text", "text/plain"),
    );
    // The response is non-JSON, data is not an array → returns empty
    expect(models).toEqual([]);
  });

  it("handles empty string response", async () => {
    const fetchImpl = (async () =>
      new Response("", { status: 200 }),
    ) as unknown as typeof fetch;
    const models = await fetchOpenAiCompatModels(baseCtx, fetchImpl);
    expect(models).toEqual([]);
  });

  it("strips auth-carrying headers from requestHeaders", async () => {
    let capturedHeaders: Record<string, string> = {};
    const fetchImpl = (async (_u: RequestInfo | URL, init?: RequestInit) => {
      capturedHeaders = (init?.headers as Record<string, string>) ?? {};
      return new Response(JSON.stringify({ data: [{ id: "m" }] }), { status: 200 });
    }) as unknown as typeof fetch;
    await fetchOpenAiCompatModels(
      {
        ...baseCtx,
        requestHeaders: { "Authorization": "stale", "x-api-key": "stale2", "X-Tenant": "acme" },
      },
      fetchImpl,
    );
    expect(capturedHeaders["Authorization"]).toBe("Bearer sk-test");
    expect(capturedHeaders["x-api-key"]).toBeUndefined();
    expect(capturedHeaders["X-Tenant"]).toBe("acme");
  });

  // --- negative cases ---

  it("throws on non-ok response with redacted message", async () => {
    let err: Error | undefined;
    try {
      await fetchOpenAiCompatModels(
        baseCtx,
        stubFetch(401, { error: { message: "invalid key sk-abc1234567890123" } }),
      );
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeDefined();
    expect(err!.message).toMatch(/provider test returned 401/);
    expect(err!.message).toContain("<redacted>");
    expect(err!.message).not.toContain("sk-abc1234567890123");
  });

  it("throws when entry has no id or name", async () => {
    await expect(
      fetchOpenAiCompatModels(
        baseCtx,
        stubFetch(200, { data: [{ owned_by: "nobody" }] }),
      ),
    ).rejects.toThrow(/without id or name/);
  });

  it("redacts secrets in error response body", async () => {
    // Use raw text that contains a secret pattern
    const fetchImpl = (async () =>
      new Response("error: sk-abc123def4567890123456 is invalid", { status: 403 }),
    ) as unknown as typeof fetch;
    let err: Error | undefined;
    try {
      await fetchOpenAiCompatModels(baseCtx, fetchImpl);
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeDefined();
    expect(err!.message).toMatch(/provider test returned 403/);
    expect(err!.message).toContain("<redacted>");
    expect(err!.message).not.toContain("sk-abc123def4567890123456");
  });
});
