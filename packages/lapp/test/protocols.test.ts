import { describe, it, expect } from "vitest";
import {
  normalizeProtocolEntry,
  getProviderProtocols,
  getPrimaryProtocol,
  getPrimaryProtocolId,
  getProtocolBaseUrl,
  mergeProtocolRequestHeaders,
} from "../src/protocols.js";
import type { ProviderConfig } from "../src/types.js";

describe("normalizeProtocolEntry", () => {
  it("returns null for null/undefined", () => {
    expect(normalizeProtocolEntry(null)).toBeNull();
    expect(normalizeProtocolEntry(undefined)).toBeNull();
  });

  it("returns null for numbers and booleans", () => {
    expect(normalizeProtocolEntry(42)).toBeNull();
    expect(normalizeProtocolEntry(true)).toBeNull();
  });

  it("returns null for empty array", () => {
    expect(normalizeProtocolEntry([])).toBeNull();
  });

  it("parses a string entry", () => {
    const r = normalizeProtocolEntry("openai-chat-completions");
    expect(r).toEqual({ id: "openai-chat-completions" });
  });

  it("returns null for empty string", () => {
    expect(normalizeProtocolEntry("")).toBeNull();
  });

  it("returns null for whitespace-only string", () => {
    expect(normalizeProtocolEntry("   ")).toBeNull();
  });

  it("returns null for object without id", () => {
    expect(normalizeProtocolEntry({ name: "test" })).toBeNull();
  });

  it("returns null for object with empty id", () => {
    expect(normalizeProtocolEntry({ id: "" })).toBeNull();
  });

  it("returns null for object with whitespace-only id", () => {
    expect(normalizeProtocolEntry({ id: "  " })).toBeNull();
  });

  it("trims id from object", () => {
    const r = normalizeProtocolEntry({ id: "  openai  " });
    expect(r!.id).toBe("openai");
  });

  it("preserves baseUrl from object when present", () => {
    const r = normalizeProtocolEntry({ id: "o", baseUrl: "https://x/v1" });
    expect(r).toEqual({ id: "o", baseUrl: "https://x/v1" });
  });

  it("drops baseUrl when it is not a string", () => {
    const r = normalizeProtocolEntry({ id: "o", baseUrl: 42 });
    expect(r).toEqual({ id: "o" });
  });

  it("preserves requestHeaders from object when it is a plain object", () => {
    const r = normalizeProtocolEntry({ id: "o", requestHeaders: { "X-Custom": "v" } });
    expect(r).toEqual({ id: "o", requestHeaders: { "X-Custom": "v" } });
  });

  it("drops requestHeaders when it is not a plain object", () => {
    const r = normalizeProtocolEntry({ id: "o", requestHeaders: ["bad"] });
    expect(r).toEqual({ id: "o" });
  });

  it("filters capabilities to string-only values", () => {
    const r = normalizeProtocolEntry({ id: "o", capabilities: ["chat", 42, "stream", null] });
    expect(r).toEqual({ id: "o", capabilities: ["chat", "stream"] });
  });

  it("preserves extra unknown fields on the object", () => {
    const r = normalizeProtocolEntry({ id: "o", extra: true, tags: ["a"] });
    expect(r).toEqual({ id: "o", extra: true, tags: ["a"] });
  });

  it("handles object with id only", () => {
    const r = normalizeProtocolEntry({ id: "simple" });
    expect(r).toEqual({ id: "simple" });
  });
});

describe("getProviderProtocols", () => {
  function cfg(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
    return {
      id: "test",
      protocol: "openai-chat-completions",
      baseUrl: "https://x",
      ...overrides,
    } as ProviderConfig;
  }

  it("returns parsed entries from protocols array", () => {
    const result = getProviderProtocols(cfg({
      protocols: ["openai-chat-completions", "anthropic-messages"],
    }));
    expect(result).toEqual([
      { id: "openai-chat-completions" },
      { id: "anthropic-messages" },
    ]);
  });

  it("filters out null entries from protocols array", () => {
    const result = getProviderProtocols(cfg({
      protocols: ["openai-chat-completions", "", { id: "" }],
    }));
    expect(result).toEqual([{ id: "openai-chat-completions" }]);
  });

  it("returns empty array when protocols is empty", () => {
    const result = getProviderProtocols(cfg({ protocols: [] }));
    expect(result).toEqual([]);
  });

  it("falls back to single protocol string when protocols is not an array", () => {
    const result = getProviderProtocols(cfg({
      protocol: "openai-responses",
      protocols: undefined,
    }));
    expect(result).toEqual([{ id: "openai-responses" }]);
  });

  it("returns empty array when protocol is empty string", () => {
    const result = getProviderProtocols(cfg({
      protocol: "",
      protocols: undefined,
    }));
    expect(result).toEqual([]);
  });

  it("returns empty array when protocol is whitespace", () => {
    const result = getProviderProtocols(cfg({
      protocol: "   ",
      protocols: undefined,
    }));
    expect(result).toEqual([]);
  });

  it("protocols array with string and object entries", () => {
    const result = getProviderProtocols(cfg({
      protocols: ["openai-chat-completions", { id: "custom", baseUrl: "https://custom/v1" }],
    }));
    expect(result).toEqual([
      { id: "openai-chat-completions" },
      { id: "custom", baseUrl: "https://custom/v1" },
    ]);
  });
});

describe("getPrimaryProtocol", () => {
  function cfg(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
    return {
      id: "test",
      protocol: "openai-chat-completions",
      baseUrl: "https://x",
      ...overrides,
    } as ProviderConfig;
  }

  it("returns first protocol from protocols array", () => {
    const r = getPrimaryProtocol(cfg({
      protocols: ["anthropic-messages", "openai-chat-completions"],
    }));
    expect(r).toEqual({ id: "anthropic-messages" });
  });

  it("falls back to config.protocol when protocols array is empty", () => {
    const r = getPrimaryProtocol(cfg({ protocols: [] }));
    expect(r).toEqual({ id: "openai-chat-completions" });
  });

  it("falls back to config.protocol when no protocols field", () => {
    const r = getPrimaryProtocol(cfg({ protocols: undefined }));
    expect(r).toEqual({ id: "openai-chat-completions" });
  });

  it("returns config.protocol even when it is empty", () => {
    const r = getPrimaryProtocol(cfg({ protocol: "", protocols: undefined }));
    expect(r).toEqual({ id: "" });
  });
});

describe("getPrimaryProtocolId", () => {
  it("returns primary protocol id as string", () => {
    const r = getPrimaryProtocolId({
      id: "t",
      protocol: "openai-chat-completions",
      baseUrl: "https://x",
    } as ProviderConfig);
    expect(r).toBe("openai-chat-completions");
  });
});

describe("getProtocolBaseUrl", () => {
  it("uses protocol-level baseUrl when present", () => {
    const protocol = { id: "o", baseUrl: "https://protocol.example/v1" };
    const result = getProtocolBaseUrl(
      { id: "t", baseUrl: "https://config.example" } as ProviderConfig,
      protocol,
    );
    expect(result).toBe("https://protocol.example/v1");
  });

  it("falls back to config baseUrl when protocol has none", () => {
    const protocol = { id: "o" };
    const result = getProtocolBaseUrl(
      { id: "t", baseUrl: "https://config.example" } as ProviderConfig,
      protocol,
    );
    expect(result).toBe("https://config.example");
  });
});

describe("mergeProtocolRequestHeaders", () => {
  it("returns undefined when neither has requestHeaders", () => {
    const result = mergeProtocolRequestHeaders(
      { id: "t", baseUrl: "https://x" } as ProviderConfig,
      { id: "o" },
    );
    expect(result).toBeUndefined();
  });

  it("returns config headers when protocol has none", () => {
    const result = mergeProtocolRequestHeaders(
      { id: "t", baseUrl: "https://x", requestHeaders: { "X-A": "1" } } as ProviderConfig,
      { id: "o" },
    );
    expect(result).toEqual({ "X-A": "1" });
  });

  it("returns protocol headers when config has none", () => {
    const result = mergeProtocolRequestHeaders(
      { id: "t", baseUrl: "https://x" } as ProviderConfig,
      { id: "o", requestHeaders: { "X-B": "2" } },
    );
    expect(result).toEqual({ "X-B": "2" });
  });

  it("merges both with protocol taking precedence", () => {
    const result = mergeProtocolRequestHeaders(
      { id: "t", baseUrl: "https://x", requestHeaders: { "X-A": "1", "X-Common": "config" } } as ProviderConfig,
      { id: "o", requestHeaders: { "X-B": "2", "X-Common": "protocol" } },
    );
    expect(result).toEqual({ "X-A": "1", "X-B": "2", "X-Common": "protocol" });
  });
});
