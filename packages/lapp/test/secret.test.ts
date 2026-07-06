import { describe, it, expect } from "vitest";
import {
  parseSecretRef,
  redactSecret,
  resolveSecret,
  MissingEnvSecretError,
  UnsupportedSecretSchemeError,
} from "../src/index.js";

describe("parseSecretRef", () => {
  it("parses plaintext", () => {
    expect(parseSecretRef("sk-abc")).toEqual({ raw: "sk-abc", scheme: "plaintext", plaintext: true });
  });
  it("parses env://", () => {
    expect(parseSecretRef("env://DEEPSEEK_API_KEY")).toMatchObject({ scheme: "env", reference: "DEEPSEEK_API_KEY", plaintext: false });
  });
  it("parses keychain://", () => {
    expect(parseSecretRef("keychain://ns/item")).toMatchObject({ scheme: "keychain", reference: "ns/item" });
  });
  it("parses file://", () => {
    expect(parseSecretRef("file:///etc/key")).toMatchObject({ scheme: "file", reference: "/etc/key" });
  });
  it("treats unknown scheme as plaintext (not a ref)", () => {
    // Plaintext keys that happen to contain "://" (e.g. URL-shaped values or
    // a key like "vault://x" that the user intended as a literal string) must
    // remain usable as plaintext. Only schemes in SECRET_SCHEMES (env, keychain,
    // file) are treated as references.
    expect(parseSecretRef("vault://x")).toEqual({ raw: "vault://x", scheme: "plaintext", plaintext: true });
  });
  it("parses empty or whitespace-only as plaintext", () => {
    expect(parseSecretRef("")).toEqual({ raw: "", scheme: "plaintext", plaintext: true });
    expect(parseSecretRef("   ")).toEqual({ raw: "", scheme: "plaintext", plaintext: true });
  });
  it("parses env:// and keychain:// and file:// as references", () => {
    expect(parseSecretRef("env://FOO").plaintext).toBe(false);
    expect(parseSecretRef("keychain://ns/item").plaintext).toBe(false);
    expect(parseSecretRef("file:///etc/k").plaintext).toBe(false);
  });
});

describe("redactSecret", () => {
  it("redacts plaintext", () => {
    expect(redactSecret("sk-supersecret")).toBe("<redacted>");
  });
  it("keeps env reference name", () => {
    expect(redactSecret("env://DEEPSEEK_API_KEY")).toBe("env://DEEPSEEK_API_KEY");
  });
  it("redacts file:// body", () => {
    expect(redactSecret("file:///etc/key")).toBe("file://<redacted>");
  });
  it("redacts keychain:// keeping ref name visible", () => {
    expect(redactSecret("keychain://ns/item")).toBe("keychain://ns/item");
  });
  it("handles unset", () => {
    expect(redactSecret(undefined)).toBe("<unset>");
  });
});

describe("resolveSecret", () => {
  it("returns plaintext without resolve flag", () => {
    expect(resolveSecret("sk-x").ok).toBe(true);
  });
  it("refuses env:// without resolve", () => {
    const r = resolveSecret("env://FOO");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("unsupported");
  });
  it("resolves env:// with resolve + present var", () => {
    const r = resolveSecret("env://FOO", { resolve: true, env: { FOO: "value" } });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe("value");
  });
  it("returns missing-env error for absent var", () => {
    const r = resolveSecret("env://NOPE", { resolve: true, env: {} });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("missing");
      expect(r.error).toBeInstanceOf(MissingEnvSecretError);
    }
  });
  it("returns unsupported for keychain://", () => {
    const r = resolveSecret("keychain://ns/item", { resolve: true });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("unsupported");
      expect(r.error).toBeInstanceOf(UnsupportedSecretSchemeError);
    }
  });
  it("returns unsupported for file://", () => {
    const r = resolveSecret("file:///etc/secret", { resolve: true });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("unsupported");
      expect(r.error).toBeInstanceOf(UnsupportedSecretSchemeError);
    }
  });
  it("returns unset for empty or whitespace", () => {
    const r1 = resolveSecret("", {});
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.reason).toBe("unset");
    const r2 = resolveSecret("  ", {});
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.reason).toBe("unset");
  });
});