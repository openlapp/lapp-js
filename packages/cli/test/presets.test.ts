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
  PRESETS,
  type ProviderPreset,
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
    expect(r.input.protocols.map((p) => p.id)).toEqual([
      "openai-responses",
      "openai-chat-completions",
    ]);
    // String entries are normalized to objects carrying the preset baseUrl.
    expect(r.input.protocols[0]).toEqual({
      id: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    });
    expect(r.input.auth).toEqual({ secret: "env://OPENAI_API_KEY" });
    // defaultModel comes from the preset.
    expect(r.input.defaultModel).toBe("gpt-4o-mini");
  });

  it("overrides baseUrl on every string-form entry", () => {
    const r = applyPreset("openai", { baseUrl: "https://proxy.example.com/v1" });
    expect(r.input.baseUrl).toBe("https://proxy.example.com/v1");
    expect(r.input.protocols[0]!.baseUrl).toBe("https://proxy.example.com/v1");
    expect(r.input.protocols[1]!.baseUrl).toBe("https://proxy.example.com/v1");
  });

  it("overrides secret and model", () => {
    const r = applyPreset("openai", { secret: "env://MY_OPENAI_KEY", model: "gpt-4o" });
    expect(r.input.auth).toEqual({ secret: "env://MY_OPENAI_KEY" });
    expect(r.input.defaultModel).toBe("gpt-4o");
  });
});

describe("applyPreset — Ollama (no-auth local)", () => {
  it("resolves to auth type none with no secret", () => {
    const r = applyPreset("ollama");
    expect(r.input.baseUrl).toBe("http://localhost:11434/v1");
    expect(r.input.protocols.map((p) => p.id)).toEqual(["openai-chat-completions"]);
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
    expect(r.input.protocols.map((p) => p.id)).toEqual(["anthropic-messages"]);
    expect(r.input.auth).toEqual({ secret: "env://ANTHROPIC_API_KEY" });
  });
});

describe("applyPreset — object-form preset protocols keep their own baseUrl", () => {
  it("does not clobber a protocol object's explicit baseUrl with the preset default", () => {
    // Build a preset with a mixed string + object protocols list in-memory and
    // resolve through the public API by temporarily registering it.
    const custom: ProviderPreset = {
      id: "custom",
      displayName: "Custom",
      protocols: [
        "openai-chat-completions",
        { id: "anthropic-messages", baseUrl: "https://anth.example.com" },
      ],
      baseUrl: "https://default.example.com/v1",
      suggestedSecret: "env://CUSTOM_KEY",
    };
    const prev = PRESETS["custom"];
    PRESETS["custom"] = custom;
    try {
      const r = applyPreset("custom");
      expect(r.input.protocols[0]!.baseUrl).toBe("https://default.example.com/v1");
      expect(r.input.protocols[1]!.baseUrl).toBe("https://anth.example.com");
    } finally {
      if (prev === undefined) delete PRESETS["custom"];
      else PRESETS["custom"] = prev;
    }
  });
});

describe("applyPreset — error cases", () => {
  it("throws on an unknown preset id", () => {
    expect(() => applyPreset("does-not-exist")).toThrow(/unknown preset/);
  });
});
