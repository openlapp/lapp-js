import { describe, it, expect } from "vitest";
import { stripJsonc, readJsonc, findConfigFile } from "../src/config/jsonc.js";
import { lappRoot } from "../../../scripts/lapp-paths.mjs";
import path from "node:path";

describe("stripJsonc", () => {
  it("strips line comments", () => {
    expect(JSON.parse(stripJsonc('{ "a": 1 // c\n}'))).toEqual({ a: 1 });
  });
  it("strips block comments", () => {
    expect(JSON.parse(stripJsonc('{ "a": 1 /* c */, "b": 2 }'))).toEqual({ a: 1, b: 2 });
  });
  it("preserves // inside strings (URLs)", () => {
    expect(JSON.parse(stripJsonc('{ "u": "https://x.com/y" }'))).toEqual({ u: "https://x.com/y" });
  });
  it("handles escaped quotes", () => {
    expect(JSON.parse(stripJsonc('{ "s": "a\\" // nc" }'))).toEqual({ s: 'a" // nc' });
  });
});

describe("readJsonc on sibling fixtures", () => {
  it("reads jsonc provider example", () => {
    const f = path.join(lappRoot, "examples/en/full/.lapp/providers/deepseek/provider.jsonc");
    const data = readJsonc(f) as { id: string; protocol: string };
    expect(data.id).toBe("deepseek");
    expect(data.protocol).toBe("openai-chat-completions");
  });

  it("findConfigFile prefers .json then .jsonc", () => {
    const dir = path.join(lappRoot, "examples/en/full/.lapp/providers/deepseek");
    const found = findConfigFile(dir, "provider");
    expect(found).toBeTruthy();
    expect(path.extname(found!)).toBe(".jsonc");
  });
});