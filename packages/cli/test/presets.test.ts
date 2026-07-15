/**
 * Unit tests for the CLI provider-preset registry.
 *
 * These cover `applyPreset`'s resolution rules: protocol normalization,
 * secret/env/no-auth derivation, override precedence, and the unknown-preset
 * error. They run without a profile or network — pure functions.
 */
import { describe, it, expect } from "vitest";
import {
  applyPreset,
  getPreset,
  listPresets,
} from "../src/presets.js";

describe("getPreset / listPresets", () => {
  it("returns known presets", () => {
    expect(getPreset("openai")?.displayName).toBe("OpenAI");
    expect(getPreset("ollama")?.noAuth).toBe(true);
    expect(getPreset("nonexistent")).toBeUndefined();
  });

  it("listPresets is sorted and covers all registered ids", () => {
    const list = listPresets();
    const ids = list.map((p) => p.id);
    expect([...ids].sort()).toEqual(ids);
    // sanity: the marquee presets are present
    for (const id of ["openai", "anthropic", "deepseek", "ollama", "openrouter"]) {
      expect(ids).toContain(id);
    }
  });
});

describe("applyPreset — OpenAI", () => {
  it("resolves to a Responses-first protocols array and env secret", () => {
    const r = applyPreset("openai");
    expect(r.preset.id).toBe("openai");
    expect(r.input.id).toBe("openai");
    expect(r.input.baseUrl).toBe("https://api.openai.com/v1");
    // Two protocols, Responses preferred first.
    expect(r.input.protocols).toEqual([
      "openai-responses",
      "openai-chat-completions",
    ]);
    expect(r.input.auth).toEqual({ type: "bearer", secret: "env://OPENAI_API_KEY" });
    expect(r.input.modelDiscovery).toEqual({
      protocol: "openai-models",
      url: "https://api.openai.com/v1/models",
    });
    // defaultModel comes from the preset.
    expect(r.input.defaultModel).toBe("gpt-4o-mini");
  });

  it("overrides baseUrl on every string-form entry", () => {
    const r = applyPreset("openai", { baseUrl: "https://proxy.example.com/v1" });
    expect(r.input.baseUrl).toBe("https://proxy.example.com/v1");
    expect(r.input.modelDiscovery?.url).toBe("https://proxy.example.com/v1/models");
  });

  it("overrides secret and model", () => {
    const r = applyPreset("openai", { secret: "env://MY_OPENAI_KEY", model: "gpt-4o" });
    expect(r.input.auth).toEqual({ type: "bearer", secret: "env://MY_OPENAI_KEY" });
    expect(r.input.defaultModel).toBe("gpt-4o");
  });
});

describe("applyPreset — Ollama (no-auth local)", () => {
  it("resolves to auth type none with no secret", () => {
    const r = applyPreset("ollama");
    expect(r.input.baseUrl).toBe("http://localhost:11434/v1");
    expect(r.input.protocols).toEqual(["openai-chat-completions"]);
    expect(r.input.auth).toEqual({ type: "none" });
    expect(r.input.defaultModel).toBeUndefined();
  });

  it("--no-auth override forces none even on a secret-bearing preset", () => {
    const r = applyPreset("openai", { noAuth: true });
    expect(r.input.auth).toEqual({ type: "none" });
  });
});

describe("applyPreset — Anthropic baseUrl has no /v1", () => {
  it("uses the spec baseUrl without a trailing /v1 segment", () => {
    const r = applyPreset("anthropic");
    expect(r.input.baseUrl).toBe("https://api.anthropic.com");
    expect(r.input.protocols).toEqual(["anthropic-messages"]);
    expect(r.input.auth).toEqual({ type: "header", name: "x-api-key", secret: "env://ANTHROPIC_API_KEY" });
    expect(r.input.modelDiscovery?.url).toBe("https://api.anthropic.com/v1/models");
  });

  it("does not duplicate /v1 for an overridden Anthropic base URL", () => {
    const r = applyPreset("anthropic", { baseUrl: "https://proxy.example.com/v1" });
    expect(r.input.modelDiscovery?.url).toBe("https://proxy.example.com/v1/models");
  });
});

describe("applyPreset — error cases", () => {
  it("throws on an unknown preset id", () => {
    expect(() => applyPreset("does-not-exist")).toThrow(/unknown preset/);
  });
});
