import { describe, it, expect } from "vitest";
import path from "node:path";
import { loadProfile, inspectProfile, resolveLappRoot, validateProfile, createProfile, upsertProvider } from "../src/index.js";
import { lappRoot, lappFixtures } from "../../../scripts/lapp-paths.mjs";

const examples = (lang: "en" | "zh-CN", kind: "minimal" | "full") =>
  path.join(lappRoot, "examples", lang, kind, ".lapp");

describe("resolveLappRoot", () => {
  it("prefers explicit path", () => {
    expect(resolveLappRoot("/tmp/my-lapp")).toBe(path.resolve("/tmp/my-lapp"));
  });
  it("falls back to LAPP_HOME env", () => {
    const prev = process.env.LAPP_HOME;
    process.env.LAPP_HOME = "/tmp/env-lapp";
    try {
      expect(resolveLappRoot()).toBe(path.resolve("/tmp/env-lapp"));
    } finally {
      if (prev === undefined) delete process.env.LAPP_HOME; else process.env.LAPP_HOME = prev;
    }
  });
});

describe("loadProfile on sibling examples", () => {
  it("loads en/minimal successfully", () => {
    const p = loadProfile({ path: examples("en", "minimal") });
    expect(p.providers).toHaveLength(1);
    expect(p.providers[0]!.config.id).toBe("deepseek");
    expect(p.providers[0]!.config.protocol).toBe("openai-chat-completions");
    expect(p.providers[0]!.models?.models.length).toBeGreaterThan(0);
  });

  it("loads en/full and warns about non-core minimax protocol", () => {
    const p = loadProfile({ path: examples("en", "full") });
    const ids = p.providers.map((x) => x.config.id);
    expect(ids).toEqual(expect.arrayContaining(["deepseek", "minimax", "moonshot-kimi", "siliconflow"]));
    const warn = p.diagnostics.find(
      (d) => d.level === "WARN" && d.message.includes("minimax-api"),
    );
    expect(warn).toBeTruthy();
    // global defaults resolved.
    expect(p.global?.defaultModel?.providerId).toBe("deepseek");
  });

  it("redacts secrets in inspect by default", () => {
    const p = loadProfile({ path: examples("en", "full") });
    const s = inspectProfile(p);
    const ds = s.providers.find((x) => x.id === "deepseek")!;
    expect(ds.secret.scheme).toBe("env");
    expect(ds.secret.redacted).toBe("env://DEEPSEEK_API_KEY");
    expect(ds.secret.resolvable).toBe(true);
  });

  it("revealSecrets shows raw value", () => {
    const p = loadProfile({ path: examples("en", "minimal") });
    const s = inspectProfile(p, { revealSecrets: true });
    expect(s.providers[0]!.secret.redacted).toBe("env://DEEPSEEK_API_KEY");
  });
});

describe("inspectProfile coverage", () => {
  it("shows <unset> for provider with no auth secret", () => {
    let p = createProfile({ rootDir: "/tmp/.lapp" });
    p = upsertProvider(p, { id: "noauth", protocol: "openai-chat-completions", baseUrl: "https://x.com" });
    const s = inspectProfile(p);
    const prov = s.providers[0]!;
    expect(prov.secret.redacted).toBe("<unset>");
    expect(prov.secret.resolvable).toBe(false);
  });
});

describe("validateProfile on invalid fixtures", () => {
  it("detects missing-base-url as invalid", () => {
    const dir = path.join(lappFixtures, "invalid/missing-base-url/.lapp");
    const p = loadProfile({ path: dir });
    const r = validateProfile(p);
    expect(r.valid).toBe(false);
    expect(r.diagnostics.some((d) => d.level === "ERROR" && /baseUrl/.test(d.message))).toBe(true);
  });

  it("detects bad-global-reference as invalid", () => {
    const dir = path.join(lappFixtures, "invalid/bad-global-reference/.lapp");
    const p = loadProfile({ path: dir });
    const r = validateProfile(p);
    expect(r.valid).toBe(false);
  });

  it("detects bad-jsonc as invalid", () => {
    const dir = path.join(lappFixtures, "invalid/bad-jsonc/.lapp");
    const p = loadProfile({ path: dir });
    const r = validateProfile(p);
    expect(r.valid).toBe(false);
    expect(r.diagnostics.some((d) => /JSONC|unexpected/i.test(d.message))).toBe(true);
  });
});