/**
 * Local/self-hosted model support: OpenAI-compatible providers (Ollama, LM
 * Studio, vLLM, etc.) without authentication. Covers the `allowUnauthenticated`
 * client option, the per-adapter header skip when `ctx.secret === ""`, and
 * the Ollama `name` field accepted by `fetchOpenAiCompatModels`.
 */

import { describe, it, expect } from "vitest";
import {
  createLappClient,
  syncProviderModels,
  fetchProviderModels,
} from "../src/index.js";
import { createProfile, upsertProvider, upsertModel } from "../src/index.js";

describe("allowUnauthenticated", () => {
  it("openai-chat: omit Authorization header when secret is empty and allowUnauthenticated is true", async () => {
    let p = createProfile({ rootDir: "/tmp/.lapp" });
    p = upsertProvider(p, { id: "ollama", protocol: "openai-chat-completions", baseUrl: "http://localhost:11434/v1" });
    p = upsertModel(p, { providerId: "ollama", id: "llama3", type: "chat" });
    let captured: { headers: Record<string, string> } | null = null;
    const wrappedFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      captured = { headers: (init?.headers as Record<string, string>) ?? {} };
      return new Response(JSON.stringify({ choices: [{ message: { content: "hi" } }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const c = createLappClient({ profile: p, provider: "ollama", model: "llama3", resolveSecrets: false, allowUnauthenticated: true, fetchImpl: wrappedFetch });
    await c.chat({ messages: [{ role: "user", content: "x" }] });
    expect(captured!.headers["Authorization"]).toBeUndefined();
    expect(captured!.headers["authorization"]).toBeUndefined();
  });

  it("openai-responses: omit Authorization header when secret is empty and allowUnauthenticated is true", async () => {
    let p = createProfile({ rootDir: "/tmp/.lapp" });
    p = upsertProvider(p, { id: "vllm", protocol: "openai-responses", baseUrl: "http://localhost:8000/v1" });
    p = upsertModel(p, { providerId: "vllm", id: "m", type: "chat" });
    let captured: { headers: Record<string, string> } | null = null;
    const wrappedFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      captured = { headers: (init?.headers as Record<string, string>) ?? {} };
      return new Response(JSON.stringify({ output_text: "ok" }), { status: 200 });
    }) as unknown as typeof fetch;
    const c = createLappClient({ profile: p, provider: "vllm", model: "m", resolveSecrets: false, allowUnauthenticated: true, fetchImpl: wrappedFetch });
    await c.chat({ messages: [{ role: "user", content: "x" }] });
    expect(captured!.headers["Authorization"]).toBeUndefined();
  });

  it("anthropic-messages: omit x-api-key header when secret is empty and allowUnauthenticated is true", async () => {
    let p = createProfile({ rootDir: "/tmp/.lapp" });
    p = upsertProvider(p, { id: "local-anth", protocol: "anthropic-messages", baseUrl: "http://localhost:8080" });
    p = upsertModel(p, { providerId: "local-anth", id: "m", type: "chat" });
    let captured: { headers: Record<string, string> } | null = null;
    const wrappedFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      captured = { headers: (init?.headers as Record<string, string>) ?? {} };
      return new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const c = createLappClient({ profile: p, provider: "local-anth", model: "m", resolveSecrets: false, allowUnauthenticated: true, fetchImpl: wrappedFetch });
    await c.chat({ messages: [{ role: "user", content: "x" }] });
    expect(captured!.headers["x-api-key"]).toBeUndefined();
    expect(captured!.headers["X-Api-Key"]).toBeUndefined();
  });

  it("throws when secret is missing and allowUnauthenticated is false (default)", async () => {
    let p = createProfile({ rootDir: "/tmp/.lapp" });
    p = upsertProvider(p, { id: "ollama", protocol: "openai-chat-completions", baseUrl: "http://localhost:11434/v1" });
    p = upsertModel(p, { providerId: "ollama", id: "llama3", type: "chat" });
    const c = createLappClient({ profile: p, provider: "ollama", model: "llama3", resolveSecrets: false });
    await expect(c.chat({ messages: [{ role: "user", content: "x" }] })).rejects.toThrow();
  });

  it("does not bypass other secret resolution errors (unsupported scheme)", async () => {
    let p = createProfile({ rootDir: "/tmp/.lapp" });
    p = upsertProvider(p, { id: "ollama", protocol: "openai-chat-completions", baseUrl: "http://localhost:11434/v1", auth: { secret: "keychain://KEY" } });
    p = upsertModel(p, { providerId: "ollama", id: "m", type: "chat" });
    const c = createLappClient({ profile: p, provider: "ollama", model: "m", resolveSecrets: false, allowUnauthenticated: true });
    await expect(c.chat({ messages: [{ role: "user", content: "x" }] })).rejects.toThrow();
  });
});

describe("Ollama name field in model list sync", () => {
  it("fetchOpenAiCompatModels accepts entries with `name` instead of `id`", async () => {
    let p = createProfile({ rootDir: "/tmp/.lapp" });
    p = upsertProvider(p, { id: "ollama", protocol: "openai-chat-completions", baseUrl: "http://localhost:11434/v1" });
    p = upsertModel(p, { providerId: "ollama", id: "llama3", type: "chat" });
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ data: [{ name: "llama3:latest" }, { name: "qwen2.5:7b" }] }), { status: 200 })) as unknown as typeof fetch;
    const fetched = await fetchProviderModels(p, "ollama", { resolveSecrets: false, allowUnauthenticated: true, fetchImpl });
    expect(fetched.map((e) => e.id)).toEqual(["llama3:latest", "qwen2.5:7b"]);
  });

  it("syncProviderModels merges Ollama name-based models into existing profile", async () => {
    let p = createProfile({ rootDir: "/tmp/.lapp" });
    p = upsertProvider(p, { id: "ollama", protocol: "openai-chat-completions", baseUrl: "http://localhost:11434/v1" });
    p = upsertModel(p, { providerId: "ollama", id: "llama3", type: "chat" });
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ data: [{ name: "llama3:latest" }] }), { status: 200 })) as unknown as typeof fetch;
    const result = await syncProviderModels(p, "ollama", { resolveSecrets: false, allowUnauthenticated: true, fetchImpl });
    expect(result.models.map((m) => m.id)).toEqual(["llama3:latest"]);
  });
});
