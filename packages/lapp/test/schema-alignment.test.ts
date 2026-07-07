/**
 * Schema-alignment coverage. The `../lapp` spec has added `links`/`metadata`
 * to `ModelEntry`, expects `updatedAt` in `models.json`, and reserves four
 * extra default-model slots (`defaultEmbeddingModel`, `defaultImageModel`,
 * `defaultTextToSpeechModel`, `defaultVideoModel`) on `GlobalConfig`. These
 * tests pin the SDK's behavior to that contract end-to-end.
 */

import { describe, it, expect } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import {
  createProfile,
  upsertProvider,
  upsertModel,
  removeProvider,
  removeModel,
  setDefaultModel,
  setDefaultModelRef,
  writeProfileAtomic,
  loadProfile,
  inspectProfile,
} from "../src/index.js";

function tmpRoot(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "lapp-align-")), ".lapp");
}

describe("ModelEntry.links / metadata round-trip", () => {
  it("upsertModel preserves links and metadata through load + write", async () => {
    const root = tmpRoot();
    let p = createProfile({ rootDir: root });
    p = upsertProvider(p, { id: "ds", protocol: "openai-chat-completions", baseUrl: "https://x" });
    p = upsertModel(p, {
      providerId: "ds",
      id: "m",
      type: "chat",
      links: { docs: "https://docs.example.com", pricing: "https://example.com/pricing" },
      metadata: { vendor: "acme", tier: "pro" },
    });
    await writeProfileAtomic(p);

    const reloaded = loadProfile({ path: root });
    const m = reloaded.providers[0]!.models!.models[0]!;
    expect(m.links).toEqual({ docs: "https://docs.example.com", pricing: "https://example.com/pricing" });
    expect(m.metadata).toEqual({ vendor: "acme", tier: "pro" });

    // Subsequent partial update (only --type) must keep both fields intact.
    const next = upsertModel(reloaded, { providerId: "ds", id: "m", type: "chat" });
    const m2 = next.providers[0]!.models!.models[0]!;
    expect(m2.links).toEqual(m.links);
    expect(m2.metadata).toEqual(m.metadata);
  });
});

describe("setDefaultModelRef for all five default slots", () => {
  it("writes defaultEmbeddingModel / defaultImageModel / defaultTextToSpeechModel / defaultVideoModel", () => {
    let p = createProfile({ rootDir: "/tmp/.lapp", global: true });
    p = upsertProvider(p, { id: "p", protocol: "openai-chat-completions", baseUrl: "https://x" });
    p = setDefaultModelRef(p, "defaultEmbeddingModel", { providerId: "p", model: "e" });
    p = setDefaultModelRef(p, "defaultImageModel", { providerId: "p", model: "i" });
    p = setDefaultModelRef(p, "defaultTextToSpeechModel", { providerId: "p", model: "t" });
    p = setDefaultModelRef(p, "defaultVideoModel", { providerId: "p", model: "v" });
    expect(p.global?.defaultEmbeddingModel).toEqual({ providerId: "p", model: "e" });
    expect(p.global?.defaultImageModel).toEqual({ providerId: "p", model: "i" });
    expect(p.global?.defaultTextToSpeechModel).toEqual({ providerId: "p", model: "t" });
    expect(p.global?.defaultVideoModel).toEqual({ providerId: "p", model: "v" });
    // setDefaultModel is the chat-slot wrapper; must not clobber other slots.
    p = setDefaultModel(p, { providerId: "p", model: "chat-m" });
    expect(p.global?.defaultModel).toEqual({ providerId: "p", model: "chat-m" });
    expect(p.global?.defaultImageModel?.model).toBe("i");
  });
});

describe("removeProvider clears all five default refs that point at it", () => {
  it("clears defaultEmbeddingModel / defaultImageModel / defaultTextToSpeechModel / defaultVideoModel", () => {
    let p = createProfile({ rootDir: "/tmp/.lapp", global: true });
    p = upsertProvider(p, { id: "p", protocol: "openai-chat-completions", baseUrl: "https://x" });
    p = upsertProvider(p, { id: "other", protocol: "openai-chat-completions", baseUrl: "https://y" });
    p = setDefaultModelRef(p, "defaultEmbeddingModel", { providerId: "p", model: "e" });
    p = setDefaultModelRef(p, "defaultImageModel", { providerId: "p", model: "i" });
    p = setDefaultModelRef(p, "defaultTextToSpeechModel", { providerId: "p", model: "t" });
    p = setDefaultModelRef(p, "defaultVideoModel", { providerId: "p", model: "v" });
    p = setDefaultModelRef(p, "defaultEmbeddingModel", { providerId: "other", model: "oe" });
    p = removeProvider(p, "p");
    expect(p.global?.defaultEmbeddingModel).toEqual({ providerId: "other", model: "oe" });
    expect(p.global?.defaultImageModel).toBeUndefined();
    expect(p.global?.defaultTextToSpeechModel).toBeUndefined();
    expect(p.global?.defaultVideoModel).toBeUndefined();
  });

  it("removeModel also clears refs that match by id or alias", () => {
    let p = createProfile({ rootDir: "/tmp/.lapp", global: true });
    p = upsertProvider(p, { id: "p", protocol: "openai-chat-completions", baseUrl: "https://x" });
    p = upsertModel(p, { providerId: "p", id: "m", type: "chat", aliases: ["fast"] });
    p = setDefaultModelRef(p, "defaultEmbeddingModel", { providerId: "p", model: "fast" });
    expect(p.global?.defaultEmbeddingModel?.model).toBe("fast");
    p = removeModel(p, { providerId: "p", model: "m" });
    expect(p.global?.defaultEmbeddingModel).toBeUndefined();
  });
});

describe("writeProfileAtomic and updatedAt", () => {
  it("manage-driven writes do NOT stamp updatedAt (preserves caller value)", async () => {
    const root = tmpRoot();
    let p = createProfile({ rootDir: root });
    p = upsertProvider(p, { id: "ds", protocol: "openai-chat-completions", baseUrl: "https://x" });
    p = upsertModel(p, { providerId: "ds", id: "m", type: "chat" });
    // Caller did not set updatedAt — write should NOT introduce one.
    await writeProfileAtomic(p);
    const written = JSON.parse(fs.readFileSync(path.join(root, "providers/ds/models.json"), "utf8"));
    expect(written.updatedAt).toBeUndefined();
  });

  it("manage-driven writes preserve a caller-supplied updatedAt", async () => {
    const root = tmpRoot();
    let p = createProfile({ rootDir: root });
    p = upsertProvider(p, { id: "ds", protocol: "openai-chat-completions", baseUrl: "https://x" });
    p = upsertModel(p, { providerId: "ds", id: "m", type: "chat" });
    p = {
      ...p,
      providers: p.providers.map((prov) =>
        prov.config.id === "ds" && prov.models
          ? { ...prov, models: { ...prov.models, updatedAt: "2025-01-01T00:00:00.000Z" } }
          : prov,
      ),
    };
    await writeProfileAtomic(p);
    const written = JSON.parse(fs.readFileSync(path.join(root, "providers/ds/models.json"), "utf8"));
    expect(written.updatedAt).toBe("2025-01-01T00:00:00.000Z");
  });
});

describe("inspectProfile surfaces all five default slots", () => {
  it("returns defaultEmbeddingModel / defaultImageModel / defaultTextToSpeechModel / defaultVideoModel", () => {
    let p = createProfile({ rootDir: "/tmp/.lapp", global: true });
    p = upsertProvider(p, { id: "p", protocol: "openai-chat-completions", baseUrl: "https://x" });
    p = setDefaultModelRef(p, "defaultEmbeddingModel", { providerId: "p", model: "e" });
    p = setDefaultModelRef(p, "defaultImageModel", { providerId: "p", model: "i" });
    p = setDefaultModelRef(p, "defaultTextToSpeechModel", { providerId: "p", model: "t" });
    p = setDefaultModelRef(p, "defaultVideoModel", { providerId: "p", model: "v" });
    const summary = inspectProfile(p);
    expect(summary.global?.defaultEmbeddingModel).toEqual({ providerId: "p", model: "e" });
    expect(summary.global?.defaultImageModel).toEqual({ providerId: "p", model: "i" });
    expect(summary.global?.defaultTextToSpeechModel).toEqual({ providerId: "p", model: "t" });
    expect(summary.global?.defaultVideoModel).toEqual({ providerId: "p", model: "v" });
  });
});
