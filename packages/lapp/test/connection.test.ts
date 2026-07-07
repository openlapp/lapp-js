/**
 * Tests for `listModels` — the flattened profile query helper.
 */

import { describe, it, expect } from "vitest";
import {
  createProfile,
  upsertProvider,
  upsertModel,
  listModels,
  type LappProfile,
} from "../src/index.js";

function makeProfile(): LappProfile {
  let p = createProfile({ rootDir: "/tmp/.lapp" });
  p = upsertProvider(p, {
    id: "openai",
    name: "OpenAI",
    protocol: "openai-chat-completions",
    baseUrl: "https://api.openai.com/v1",
    auth: { secret: "sk-test" },
  });
  p = upsertModel(p, {
    providerId: "openai",
    id: "gpt-4o",
    name: "GPT-4o",
    type: "chat",
    capabilities: ["chat", "stream", "tool-call"],
    inputModalities: ["text", "image"],
    aliases: ["4o"],
    contextWindow: 128000,
  });
  p = upsertModel(p, {
    providerId: "openai",
    id: "text-embedding-3-small",
    type: "embedding",
    capabilities: ["embedding"],
    inputModalities: ["text"],
  });
  p = upsertProvider(p, {
    id: "anthropic",
    name: "Anthropic",
    protocol: "anthropic-messages",
    baseUrl: "https://api.anthropic.com",
    auth: { secret: "sk-ant" },
  });
  p = upsertModel(p, {
    providerId: "anthropic",
    id: "claude-3-5-sonnet-latest",
    type: "chat",
    aliases: ["sonnet"],
  });
  return p;
}

describe("listModels", () => {
  it("flattens profile into one record per model", () => {
    const p = makeProfile();
    const rows = listModels(p);
    expect(rows).toHaveLength(3);
    const ids = rows.map((r) => `${r.providerId}/${r.modelId}`).sort();
    expect(ids).toEqual([
      "anthropic/claude-3-5-sonnet-latest",
      "openai/gpt-4o",
      "openai/text-embedding-3-small",
    ]);
  });

  it("propagates provider-level and model-level fields", () => {
    const p = makeProfile();
    const gpt4o = listModels(p).find((r) => r.modelId === "gpt-4o")!;
    expect(gpt4o.providerName).toBe("OpenAI");
    expect(gpt4o.providerEnabled).toBe(true);
    expect(gpt4o.modelEnabled).toBe(true);
    expect(gpt4o.modelName).toBe("GPT-4o");
    expect(gpt4o.type).toBe("chat");
    expect(gpt4o.capabilities).toEqual(["chat", "stream", "tool-call"]);
    expect(gpt4o.inputModalities).toEqual(["text", "image"]);
    expect(gpt4o.aliases).toEqual(["4o"]);
    expect(gpt4o.contextWindow).toBe(128000);
    expect(gpt4o.protocol).toBe("openai-chat-completions");
    expect(gpt4o.baseUrl).toBe("https://api.openai.com/v1");
  });

  it("filters by providerId", () => {
    const p = makeProfile();
    const rows = listModels(p, { providerId: "openai" });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.providerId === "openai")).toBe(true);
  });

  it("omits disabled providers and models by default", () => {
    let p = makeProfile();
    // Disable a single model
    p = {
      ...p,
      providers: p.providers.map((prov) => {
        if (prov.config.id !== "openai") return prov;
        return {
          ...prov,
          models: prov.models
            ? {
                ...prov.models,
                models: prov.models.models.map((m) =>
                  m.id === "text-embedding-3-small" ? { ...m, enabled: false } : m,
                ),
              }
            : prov.models,
        };
      }),
    };
    const rows = listModels(p);
    expect(rows).toHaveLength(2);
    expect(rows.some((r) => r.modelId === "text-embedding-3-small")).toBe(false);

    // Default + includeDisabledModels surfaces it back
    const all = listModels(p, { includeDisabledModels: true });
    expect(all).toHaveLength(3);
  });

  it("omits disabled providers by default", () => {
    let p = makeProfile();
    p = {
      ...p,
      providers: p.providers.map((prov) =>
        prov.config.id === "anthropic" ? { ...prov, config: { ...prov.config, enabled: false } } : prov,
      ),
    };
    const rows = listModels(p);
    expect(rows.every((r) => r.providerId !== "anthropic")).toBe(true);

    const withDisabled = listModels(p, { includeDisabled: true });
    expect(withDisabled.some((r) => r.providerId === "anthropic")).toBe(true);
  });

  it("returns an empty array for an empty profile", () => {
    const p = createProfile({ rootDir: "/tmp/.lapp" });
    expect(listModels(p)).toEqual([]);
  });

  it("skips providers with no models.json", () => {
    let p = createProfile({ rootDir: "/tmp/.lapp" });
    p = upsertProvider(p, {
      id: "empty",
      protocol: "openai-chat-completions",
      baseUrl: "https://x",
      auth: { secret: "sk" },
    });
    expect(listModels(p)).toEqual([]);
  });

  it("respects protocol-specific baseUrl override", () => {
    let p = createProfile({ rootDir: "/tmp/.lapp" });
    p = upsertProvider(p, {
      id: "multi",
      protocol: "openai-chat-completions",
      baseUrl: "https://provider.example",
      protocols: [{ id: "openai-chat-completions", baseUrl: "https://chat.example/v1" }],
      auth: { secret: "sk" },
    });
    p = upsertModel(p, { providerId: "multi", id: "m", type: "chat" });
    const rows = listModels(p);
    expect(rows[0]!.baseUrl).toBe("https://chat.example/v1");
  });
});
