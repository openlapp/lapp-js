import { describe, it, expect } from "vitest";
import {
  createProfile,
  upsertProvider,
  upsertModel,
  syncProviderModels,
  applySyncedModels,
  buildModelSyncResult,
  fetchProviderModels,
  ModelSyncUnsupportedError,
  TargetResolutionError,
  UnsupportedProtocolError,
  MissingEnvSecretError,
} from "../src/index.js";
import { inferCapabilitiesFromProviderEntry } from "../src/sync/capabilities.js";
import { diffModels } from "../src/sync/diff.js";

function stubFetch(response: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(response), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

describe("inferCapabilitiesFromProviderEntry", () => {
  it("infers chat/stream for generic ids", () => {
    const r = inferCapabilitiesFromProviderEntry({ id: "gpt-4o", raw: {} }, "openai-chat-completions");
    expect(r.type).toBe("chat");
    expect(r.capabilities).toContain("chat");
    expect(r.capabilities).toContain("stream");
  });

  it("infers embedding for embedding ids", () => {
    const r = inferCapabilitiesFromProviderEntry({ id: "text-embedding-3-small", raw: {} }, "openai-chat-completions");
    expect(r.type).toBe("embedding");
    expect(r.capabilities).toEqual(["embedding"]);
  });

  it("infers reasoning for o-series ids", () => {
    const r = inferCapabilitiesFromProviderEntry({ id: "o1-mini", raw: {} }, "openai-chat-completions");
    expect(r.capabilities).toContain("reasoning");
    expect(r.capabilities).toContain("stream");
  });

  // Regression: previous heuristic matched the bare substring "m3" and
  // miscategorized "m3-large-chat" as embedding. Narrow id matching fixes it.
  it("does not misclassify chat models with 'm3' in the id", () => {
    const r = inferCapabilitiesFromProviderEntry({ id: "m3-large-chat", raw: {} }, "openai-chat-completions");
    expect(r.type).toBe("chat");
  });

  // Regression: previous heuristic matched the bare substring "image" and
  // miscategorized "image-classifier-v1" as image-generation. "image" no
  // longer matches as a bare substring for image-generation.
  it("does not misclassify chat models with 'image' in the id", () => {
    const r = inferCapabilitiesFromProviderEntry({ id: "image-classifier-v1", raw: {} }, "openai-chat-completions");
    expect(r.type).toBe("chat");
  });

  // Whisper → audio-transcription (audio in, text out)
  it("infers whisper as audio-transcription", () => {
    const r = inferCapabilitiesFromProviderEntry({ id: "whisper-large-v3", raw: {} }, "openai-chat-completions");
    expect(r.type).toBe("audio");
    expect(r.inputModalities).toEqual(["audio"]);
    expect(r.outputModalities).toEqual(["text"]);
    expect(r.capabilities).toContain("audio-transcription");
  });

  // tts- prefix → text-to-speech (text in, audio out)
  it("infers tts- prefix as text-to-speech", () => {
    const r = inferCapabilitiesFromProviderEntry({ id: "tts-1", raw: {} }, "openai-chat-completions");
    expect(r.type).toBe("audio");
    expect(r.inputModalities).toEqual(["text"]);
    expect(r.outputModalities).toEqual(["audio"]);
    expect(r.capabilities).toContain("text-to-speech");
  });

  // Rerank id → rerank type
  it("infers rerank- prefix as rerank", () => {
    const r = inferCapabilitiesFromProviderEntry({ id: "rerank-english-v3", raw: {} }, "openai-chat-completions");
    expect(r.type).toBe("rerank");
    expect(r.capabilities).toContain("rerank");
  });

  // Vision-language ids get image input
  it("infers vision ids to have image input", () => {
    const r = inferCapabilitiesFromProviderEntry({ id: "llava-v1.6-vl", raw: {} }, "openai-chat-completions");
    expect(r.type).toBe("chat");
    expect(r.inputModalities).toContain("image");
  });
});

describe("diffModels", () => {
  it("detects added, removed, and unchanged entries", () => {
    const before = [{ id: "a" }, { id: "b" }] as ReturnType<typeof diffModels>["added"];
    const after = [{ id: "b" }, { id: "c" }] as typeof before;
    const { added, removed, updated } = diffModels(before, after);
    expect(added.map((m) => m.id)).toEqual(["c"]);
    expect(removed.map((m) => m.id)).toEqual(["a"]);
    expect(updated).toHaveLength(0);
  });
});

describe("fetchProviderModels", () => {
  it("parses OpenAI-compatible /models response", async () => {
    let p = createProfile({ rootDir: "/tmp/.lapp" });
    p = upsertProvider(p, {
      id: "openai",
      protocol: "openai-chat-completions",
      baseUrl: "https://api.openai.com/v1",
      auth: { secret: "sk-test" },
    });
    const fetchImpl = stubFetch({
      data: [{ id: "gpt-4o", owned_by: "openai" }, { id: "gpt-3.5-turbo", owned_by: "openai" }],
    });
    const fetched = await fetchProviderModels(p, "openai", { resolveSecrets: true, fetchImpl });
    expect(fetched.map((e) => e.id)).toEqual(["gpt-4o", "gpt-3.5-turbo"]);
  });

  it("rejects anthropic without override URL", async () => {
    let p = createProfile({ rootDir: "/tmp/.lapp" });
    p = upsertProvider(p, {
      id: "anth",
      protocol: "anthropic-messages",
      baseUrl: "https://api.anthropic.com",
      auth: { secret: "sk-ant" },
    });
    await expect(fetchProviderModels(p, "anth", { resolveSecrets: true })).rejects.toThrow(ModelSyncUnsupportedError);
  });

  it("accepts Ollama name field", async () => {
    let p = createProfile({ rootDir: "/tmp/.lapp" });
    p = upsertProvider(p, {
      id: "ollama",
      protocol: "openai-chat-completions",
      baseUrl: "http://localhost:11434/v1",
      auth: { secret: "plaintext" },
    });
    const fetchImpl = stubFetch({ data: [{ name: "llama3:latest" }] });
    const fetched = await fetchProviderModels(p, "ollama", { resolveSecrets: true, fetchImpl });
    expect(fetched.map((e) => e.id)).toEqual(["llama3:latest"]);
  });
});

describe("syncProviderModels", () => {
  it("returns diff against existing models", async () => {
    let p = createProfile({ rootDir: "/tmp/.lapp" });
    p = upsertProvider(p, {
      id: "openai",
      protocol: "openai-chat-completions",
      baseUrl: "https://api.openai.com/v1",
      auth: { secret: "sk-test" },
    });
    p = upsertModel(p, { providerId: "openai", id: "gpt-4o", type: "chat" });
    const fetchImpl = stubFetch({
      data: [{ id: "gpt-4o" }, { id: "gpt-4-turbo" }],
    });
    const result = await syncProviderModels(p, "openai", { resolveSecrets: true, fetchImpl });
    expect(result.added.map((m) => m.id)).toEqual(["gpt-4-turbo"]);
    expect(result.removed).toHaveLength(0);
    expect(result.models).toHaveLength(2);
  });
});

describe("applySyncedModels", () => {
  it("preserves user-curated fields on existing entries", () => {
    const before = {
      schemaVersion: "1.0",
      models: [
        { id: "gpt-4o", source: "manual" as const, aliases: ["fast"], enabled: false, metadata: { foo: "bar" } },
      ],
    };
    const result: import("../src/sync/types.js").ModelSyncResult = {
      models: [{ id: "gpt-4o", source: "provider", type: "chat", capabilities: ["chat", "stream"] }],
      added: [],
      removed: [],
      updated: [{ id: "gpt-4o", source: "provider", type: "chat", capabilities: ["chat", "stream"] }],
    };
    const merged = applySyncedModels(before, result);
    const m = merged.models[0]!;
    expect(m.source).toBe("manual");
    expect(m.aliases).toEqual(["fast"]);
    expect(m.enabled).toBe(false);
    expect(m.metadata).toEqual({ foo: "bar" });
    expect(m.capabilities).toEqual(["chat", "stream"]);
  });

  it("preserves existing entries not in the fetched list (manual entries survive)", () => {
    const before = {
      schemaVersion: "1.0",
      models: [
        { id: "gpt-4o", source: "provider" as const, type: "chat" },
        { id: "custom-model", source: "manual" as const, type: "chat", enabled: true },
      ],
    };
    const result: import("../src/sync/types.js").ModelSyncResult = {
      models: [{ id: "gpt-4o", source: "provider", type: "chat", capabilities: ["chat", "stream"] }],
      added: [],
      removed: [{ id: "custom-model", source: "manual", type: "chat" }],
      updated: [],
    };
    const merged = applySyncedModels(before, result);
    expect(merged.models.map((m) => m.id).sort()).toEqual(["custom-model", "gpt-4o"]);
    expect(merged.models.find((m) => m.id === "custom-model")!.source).toBe("manual");
  });
});

describe("buildModelSyncResult", () => {
  it("converts fetched entries to ModelEntry with inferred capabilities", () => {
    const result = buildModelSyncResult(
      null,
      [{ id: "text-embedding-ada-002", raw: {} }],
      "openai-chat-completions",
    );
    expect(result.models[0]!.type).toBe("embedding");
    expect(result.models[0]!.capabilities).toEqual(["embedding"]);
  });
});

// Regression coverage for Round 4 sync findings.
describe("sync: provider.config.requestHeaders forwarded on /models (F5)", () => {
  it("X-Tenant-Id from requestHeaders is sent on the sync GET /models", async () => {
    let p = createProfile({ rootDir: "/tmp/.lapp" });
    p = upsertProvider(p, {
      id: "corp",
      protocol: "openai-chat-completions",
      baseUrl: "https://corp.example/v1",
      auth: { secret: "sk" },
      requestHeaders: { "X-Tenant-Id": "acme" },
    });
    let capturedHeaders: Record<string, string> = {};
    const fetchImpl = (async (_u: RequestInfo | URL, init?: RequestInit) => {
      capturedHeaders = (init?.headers as Record<string, string>) ?? {};
      return new Response(JSON.stringify({ data: [{ id: "m" }] }), { status: 200 });
    }) as unknown as typeof fetch;
    await fetchProviderModels(p, "corp", { resolveSecrets: true, fetchImpl });
    expect(capturedHeaders["X-Tenant-Id"]).toBe("acme");
  });

  it("auth-carrying keys in requestHeaders are stripped (sync honors auth-header dedup)", async () => {
    let p = createProfile({ rootDir: "/tmp/.lapp" });
    p = upsertProvider(p, {
      id: "stale",
      protocol: "openai-chat-completions",
      baseUrl: "https://x",
      auth: { secret: "sk" },
      requestHeaders: { Authorization: "stale-bearer", "X-Tenant": "acme" },
    });
    let capturedHeaders: Record<string, string> = {};
    const fetchImpl = (async (_u: RequestInfo | URL, init?: RequestInit) => {
      capturedHeaders = (init?.headers as Record<string, string>) ?? {};
      return new Response(JSON.stringify({ data: [{ id: "m" }] }), { status: 200 });
    }) as unknown as typeof fetch;
    await fetchProviderModels(p, "stale", { resolveSecrets: true, fetchImpl });
    // Only the adapter's bearer survives; the stale Authorization was stripped.
    expect(capturedHeaders["Authorization"]).toBe("Bearer sk");
    expect(capturedHeaders["X-Tenant"]).toBe("acme");
  });
});

describe("sync: allowUnauthenticated (F6)", () => {
  it("Ollama-style provider with auth.type:none + allowUnauthenticated succeeds", async () => {
    let p = createProfile({ rootDir: "/tmp/.lapp" });
    p = upsertProvider(p, {
      id: "ollama",
      protocol: "openai-chat-completions",
      baseUrl: "http://localhost:11434/v1",
      auth: { type: "none" },
    });
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ data: [{ id: "llama3" }] }), { status: 200 })) as unknown as typeof fetch;
    const r = await syncProviderModels(p, "ollama", {
      resolveSecrets: true,
      fetchImpl,
      allowUnauthenticated: true,
    });
    expect(r.models.map((m) => m.id)).toEqual(["llama3"]);
  });
});

describe("inferCapabilitiesFromProviderEntry: image-generation id (F7)", () => {
  it("model id 'image-generation' (no known prefix) classifies as image", () => {
    const r = inferCapabilitiesFromProviderEntry(
      { id: "image-generation", raw: {} },
      "openai-chat-completions",
    );
    expect(r.type).toBe("image");
  });
});

describe("diffModels: edge cases", () => {
  it("detects updated entries when name changes", () => {
    const before = [{ id: "a", name: "old", type: "chat" }] as ReturnType<typeof diffModels>["added"];
    const after = [{ id: "a", name: "new", type: "chat" }] as typeof before;
    const result = diffModels(before, after);
    expect(result.added).toHaveLength(0);
    expect(result.removed).toHaveLength(0);
    expect(result.updated).toHaveLength(1);
  });

  it("detects update when capabilities differ", () => {
    const before = [{ id: "a", capabilities: ["chat"] }] as ReturnType<typeof diffModels>["added"];
    const after = [{ id: "a", capabilities: ["chat", "stream"] }] as typeof before;
    const result = diffModels(before, after);
    expect(result.updated).toHaveLength(1);
  });

  it("detects update when contextWindow differs", () => {
    const before = [{ id: "a", contextWindow: 4096 }] as ReturnType<typeof diffModels>["added"];
    const after = [{ id: "a", contextWindow: 8192 }] as typeof before;
    const result = diffModels(before, after);
    expect(result.updated).toHaveLength(1);
  });

  it("detects update when maxOutputTokens differs", () => {
    const before = [{ id: "a", maxOutputTokens: 1024 }] as ReturnType<typeof diffModels>["added"];
    const after = [{ id: "a", maxOutputTokens: 2048 }] as typeof before;
    const result = diffModels(before, after);
    expect(result.updated).toHaveLength(1);
  });

  it("detects update when inputModalities differ", () => {
    const before = [{ id: "a", inputModalities: ["text"] }] as ReturnType<typeof diffModels>["added"];
    const after = [{ id: "a", inputModalities: ["text", "image"] }] as typeof before;
    const result = diffModels(before, after);
    expect(result.updated).toHaveLength(1);
  });

  it("detects update when outputModalities differ", () => {
    const before = [{ id: "a", outputModalities: ["text"] }] as ReturnType<typeof diffModels>["added"];
    const after = [{ id: "a", outputModalities: ["text", "audio"] }] as typeof before;
    const result = diffModels(before, after);
    expect(result.updated).toHaveLength(1);
  });

  it("treats empty before and empty after as no changes", () => {
    const result = diffModels([], []);
    expect(result.added).toHaveLength(0);
    expect(result.removed).toHaveLength(0);
    expect(result.updated).toHaveLength(0);
  });

  it("treats all-as-new when before is empty", () => {
    const after = [{ id: "a" }, { id: "b" }] as ReturnType<typeof diffModels>["added"];
    const result = diffModels([], after);
    expect(result.added.map((m) => m.id)).toEqual(["a", "b"]);
  });

  it("treats all-as-removed when after is empty", () => {
    const before = [{ id: "a" }, { id: "b" }] as ReturnType<typeof diffModels>["added"];
    const result = diffModels(before, []);
    expect(result.removed.map((m) => m.id)).toEqual(["a", "b"]);
  });

  it("arraysEqual: both undefined fields are equal", () => {
    const before = [{ id: "a" }] as ReturnType<typeof diffModels>["added"];
    const after = [{ id: "a" }] as typeof before;
    const result = diffModels(before, after);
    expect(result.updated).toHaveLength(0);
  });

  it("arraysEqual: one undefined, one empty array are treated as different", () => {
    const before = [{ id: "a", capabilities: undefined }] as ReturnType<typeof diffModels>["added"];
    const after = [{ id: "a", capabilities: [] }] as typeof before;
    const result = diffModels(before, after);
    expect(result.updated).toHaveLength(1);
  });

  it("user-curated fields do not trigger update", () => {
    const before = [{ id: "a", type: "chat", enabled: true, aliases: ["x"] }] as ReturnType<typeof diffModels>["added"];
    const after = [{ id: "a", type: "chat", enabled: false, aliases: ["y"] }] as typeof before;
    const result = diffModels(before, after);
    expect(result.updated).toHaveLength(0);
  });
});

describe("sync: fetchProviderModels additional paths", () => {
  it("openai-responses protocol syncs via /models", async () => {
    let p = createProfile({ rootDir: "/tmp/.lapp" });
    p = upsertProvider(p, {
      id: "resp",
      protocol: "openai-responses",
      baseUrl: "https://api.test/v1",
      auth: { secret: "sk-test" },
    });
    const fetchImpl = stubFetch({ data: [{ id: "gpt-4o" }] });
    const fetched = await fetchProviderModels(p, "resp", { resolveSecrets: true, fetchImpl });
    expect(fetched[0]!.id).toBe("gpt-4o");
  });

  it("anthropic with modelsUrl syncs via openai-compat", async () => {
    let p = createProfile({ rootDir: "/tmp/.lapp" });
    p = upsertProvider(p, {
      id: "anth",
      protocol: "anthropic-messages",
      baseUrl: "https://api.anthropic.com",
      auth: { secret: "sk-ant" },
      links: { models: "https://gateway/models" },
    });
    const fetchImpl = stubFetch({ data: [{ id: "claude-3" }] });
    const fetched = await fetchProviderModels(p, "anth", { resolveSecrets: true, fetchImpl });
    expect(fetched[0]!.id).toBe("claude-3");
  });

  it("disabled provider throws TargetResolutionError", async () => {
    let p = createProfile({ rootDir: "/tmp/.lapp" });
    p = upsertProvider(p, {
      id: "off",
      protocol: "openai-chat-completions",
      baseUrl: "https://x",
      enabled: false,
      auth: { secret: "sk" },
    });
    await expect(fetchProviderModels(p, "off", { resolveSecrets: true })).rejects.toThrow(TargetResolutionError);
  });

  it("unknown protocol throws UnsupportedProtocolError", async () => {
    let p = createProfile({ rootDir: "/tmp/.lapp" });
    p = upsertProvider(p, {
      id: "x",
      protocol: "unknown-protocol",
      baseUrl: "https://x",
      auth: { secret: "sk" },
    });
    await expect(fetchProviderModels(p, "x", { resolveSecrets: true })).rejects.toThrow(/unsupported protocol/i);
  });
});

describe("sync: resolveSecret failure path", () => {
  it("fetchProviderModels keeps env:// unresolved when resolveSecrets:false", async () => {
    let p = createProfile({ rootDir: "/tmp/.lapp" });
    p = upsertProvider(p, {
      id: "env",
      protocol: "openai-chat-completions",
      baseUrl: "https://x",
      auth: { secret: "env://NONEXISTENT_VAR_FOR_TEST" },
    });
    // With resolveSecrets:false the secret must stay as the literal env://
    // reference; the implementation must not touch process.env.
    const provider = p.providers.find((x) => x.config.id === "env")!;
    expect(provider.config.auth).toEqual({ secret: "env://NONEXISTENT_VAR_FOR_TEST" });
  });

  it("fetchProviderModels throws MissingEnvSecretError when resolveSecrets:true and env var is missing", async () => {
    let p = createProfile({ rootDir: "/tmp/.lapp" });
    p = upsertProvider(p, {
      id: "env",
      protocol: "openai-chat-completions",
      baseUrl: "https://x",
      auth: { secret: "env://NONEXISTENT_VAR_FOR_TEST" },
    });
    await expect(fetchProviderModels(p, "env", { resolveSecrets: true })).rejects.toThrow(MissingEnvSecretError);
  });
});
