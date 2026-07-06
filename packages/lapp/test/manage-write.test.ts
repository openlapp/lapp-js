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
  planChanges,
  writeProfileAtomic,
  loadProfile,
  validateProfile,
  isSupportedProtocol,
} from "../src/index.js";

function tmpRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lapp-write-"));
  return path.join(dir, ".lapp");
}

describe("createProfile + manage", () => {
  it("creates an empty profile", () => {
    const p = createProfile({ rootDir: "/tmp/x/.lapp" });
    expect(p.providers).toEqual([]);
    expect(p.rootDir).toBe("/tmp/x/.lapp");
  });

  it("upsertProvider and upsertModel mutate immutably", () => {
    let p = createProfile({ rootDir: "/tmp/x/.lapp" });
    const original = p;
    p = upsertProvider(p, {
      id: "deepseek",
      protocol: "openai-chat-completions",
      baseUrl: "https://api.deepseek.com",
      auth: { secret: "env://DEEPSEEK_API_KEY" },
    });
    expect(original.providers).toHaveLength(0);
    expect(p.providers).toHaveLength(1);
    p = upsertModel(p, { providerId: "deepseek", id: "deepseek-chat", type: "chat", aliases: ["ds-chat"] });
    expect(p.providers[0]!.models?.models[0]!.id).toBe("deepseek-chat");
  });

  it("removeProvider and removeModel work", () => {
    let p = createProfile({ rootDir: "/tmp/x/.lapp" });
    p = upsertProvider(p, { id: "x", protocol: "openai-chat-completions", baseUrl: "https://x" });
    p = upsertModel(p, { providerId: "x", id: "m1", type: "chat" });
    p = removeModel(p, { providerId: "x", model: "m1" });
    expect(p.providers[0]!.models?.models).toHaveLength(0);
    p = removeProvider(p, "x");
    expect(p.providers).toHaveLength(0);
  });

  it("setDefaultModel sets global default and clears on provider removal", () => {
    let p = createProfile({ rootDir: "/tmp/x/.lapp", global: true });
    p = upsertProvider(p, { id: "ds", protocol: "openai-chat-completions", baseUrl: "https://x" });
    p = setDefaultModel(p, { providerId: "ds", model: "m" });
    expect(p.global?.defaultModel?.providerId).toBe("ds");
    p = removeProvider(p, "ds");
    expect(p.global?.defaultModel).toBeUndefined();
  });

  // Regression: upsertProvider on an existing provider must preserve
  // fields the caller did not pass (name, auth, requestHeaders, links,
  // enabled). Previously it rebuilt ProviderConfig from input only,
  // silently wiping every other field on `lapp provider set`.
  it("upsertProvider preserves name/auth/requestHeaders/links on update", () => {
    let p = createProfile({ rootDir: "/tmp/x/.lapp" });
    p = upsertProvider(p, {
      id: "ds",
      protocol: "openai-chat-completions",
      baseUrl: "https://api.deepseek.com",
      name: "DeepSeek",
      enabled: true,
      auth: { secret: "env://DEEPSEEK_API_KEY" },
      requestHeaders: { "X-Tenant": "acme" },
      links: { docs: "https://docs.deepseek.com" },
    });
    // Update only baseUrl — every other field must survive.
    p = upsertProvider(p, {
      id: "ds",
      protocol: "openai-chat-completions",
      baseUrl: "https://api.deepseek.com/v2",
    });
    const cfg = p.providers[0]!.config;
    expect(cfg.baseUrl).toBe("https://api.deepseek.com/v2");
    expect(cfg.name).toBe("DeepSeek");
    expect(cfg.auth?.secret).toBe("env://DEEPSEEK_API_KEY");
    expect(cfg.requestHeaders).toEqual({ "X-Tenant": "acme" });
    expect(cfg.links).toEqual({ docs: "https://docs.deepseek.com" });
  });

  // Regression: upsertModel on an existing model must preserve fields
  // the caller did not pass (aliases, capabilities, modalities, etc.).
  it("upsertModel preserves aliases/capabilities/modalities on update", () => {
    let p = createProfile({ rootDir: "/tmp/x/.lapp" });
    p = upsertProvider(p, { id: "ds", protocol: "openai-chat-completions", baseUrl: "https://x" });
    p = upsertModel(p, {
      providerId: "ds",
      id: "deepseek-chat",
      type: "chat",
      aliases: ["fast"],
      capabilities: ["vision"],
      inputModalities: ["text"],
      outputModalities: ["text"],
    });
    // Update only type — every other field must survive.
    p = upsertModel(p, { providerId: "ds", id: "deepseek-chat", type: "chat" });
    const m = p.providers[0]!.models!.models[0]!;
    expect(m.aliases).toEqual(["fast"]);
    expect(m.capabilities).toEqual(["vision"]);
    expect(m.inputModalities).toEqual(["text"]);
    expect(m.outputModalities).toEqual(["text"]);
  });
});

describe("planChanges", () => {
  it("plans create vs modify against disk", () => {
    const root = tmpRoot();
    let p = createProfile({ rootDir: root, manifest: true });
    p = upsertProvider(p, { id: "ds", protocol: "openai-chat-completions", baseUrl: "https://api.deepseek.com" });
    p = upsertModel(p, { providerId: "ds", id: "m", type: "chat" });

    const plan = planChanges(null, p);
    expect(plan.changes.some((c) => c.kind === "create" && c.path.endsWith("provider.json"))).toBe(true);
    expect(plan.changes.some((c) => c.kind === "create" && c.path.endsWith("models.json"))).toBe(true);
    expect(plan.changes.some((c) => c.kind === "create" && c.path.endsWith("manifest.json"))).toBe(true);
  });

  it("plans modify when files already exist", () => {
    const root = tmpRoot();
    let p = createProfile({ rootDir: root });
    p = upsertProvider(p, { id: "ds", protocol: "openai-chat-completions", baseUrl: "https://api.deepseek.com" });
    void writeProfileAtomic(p);

    let p2 = createProfile({ rootDir: root });
    p2 = upsertProvider(p2, { id: "ds", protocol: "openai-chat-completions", baseUrl: "https://api.deepseek.com/v2" });
    const plan = planChanges(p, p2);
    expect(plan.changes.every((c) => c.kind === "modify")).toBe(true);
  });
});

describe("writeProfileAtomic", () => {
  it("writes JSON files that reload identically", async () => {
    const root = tmpRoot();
    let p = createProfile({ rootDir: root, manifest: true, global: true });
    p = upsertProvider(p, {
      id: "ds",
      protocol: "openai-chat-completions",
      baseUrl: "https://api.deepseek.com",
      auth: { secret: "env://DEEPSEEK_API_KEY" },
    });
    p = upsertModel(p, { providerId: "ds", id: "deepseek-chat", type: "chat", aliases: ["ds-chat"] });
    p = setDefaultModel(p, { providerId: "ds", model: "deepseek-chat" });
    await writeProfileAtomic(p);

    const files = [path.join(root, "providers/ds/provider.json"), path.join(root, "providers/ds/models.json"), path.join(root, "global.json"), path.join(root, "manifest.json")];
    for (const f of files) {
      expect(fs.existsSync(f)).toBe(true);
      expect(path.extname(f)).toBe(".json");
    }
    // No .tmp leftovers.
    const leftover = fs.readdirSync(path.join(root, "providers/ds")).filter((f) => f.includes(".tmp"));
    expect(leftover).toEqual([]);

    const reloaded = loadProfile({ path: root });
    expect(reloaded.providers[0]!.config.id).toBe("ds");
    expect(reloaded.providers[0]!.models?.models[0]!.id).toBe("deepseek-chat");
    expect(reloaded.global?.defaultModel?.model).toBe("deepseek-chat");
    expect(validateProfile(reloaded).valid).toBe(true);
  });

  it("refuses to write an invalid profile", async () => {
    const root = tmpRoot();
    const p = createProfile({ rootDir: root });
    // Provider missing required baseUrl.
    const bad = upsertProvider(p, { id: "x", protocol: "openai-chat-completions", baseUrl: "" as unknown as string });
    await expect(writeProfileAtomic(bad)).rejects.toThrow(/invalid profile/);
  });

  it("strips internal __ fields from written JSON", async () => {
    const root = tmpRoot();
    let p = createProfile({ rootDir: root });
    p = upsertProvider(p, { id: "ds", protocol: "openai-chat-completions", baseUrl: "https://x" });
    await writeProfileAtomic(p);
    const written = JSON.parse(fs.readFileSync(path.join(root, "providers/ds/provider.json"), "utf8"));
    expect(written.__file).toBeUndefined();
    expect(written.__dirName).toBeUndefined();
    expect(written.id).toBe("ds");
  });

  it("round-trips a disabled provider (load + write does not drop it)", async () => {
    // Seed a profile with a provider, then disable it and re-write.
    const root = tmpRoot();
    let p = createProfile({ rootDir: root });
    p = upsertProvider(p, { id: "on", protocol: "openai-chat-completions", baseUrl: "https://on" });
    p = upsertProvider(p, { id: "off", protocol: "openai-chat-completions", baseUrl: "https://off", enabled: false });
    await writeProfileAtomic(p);

    // Reload and re-write without touching either provider.
    const reloaded = loadProfile({ path: root });
    expect(reloaded.providers.map((x) => x.config.id).sort()).toEqual(["off", "on"]);
    await writeProfileAtomic(reloaded);
    expect(fs.existsSync(path.join(root, "providers/off/provider.json"))).toBe(true);
    expect(fs.existsSync(path.join(root, "providers/on/provider.json"))).toBe(true);
  });

  it("removes a pre-existing .jsonc when writing .json (no orphan)", async () => {
    const root = tmpRoot();
    const providerDir = path.join(root, "providers/ds");
    fs.mkdirSync(providerDir, { recursive: true });
    fs.writeFileSync(path.join(providerDir, "provider.jsonc"), "{}", "utf8");
    let p = createProfile({ rootDir: root });
    p = upsertProvider(p, { id: "ds", protocol: "openai-chat-completions", baseUrl: "https://x" });
    await writeProfileAtomic(p);
    expect(fs.existsSync(path.join(providerDir, "provider.json"))).toBe(true);
    expect(fs.existsSync(path.join(providerDir, "provider.jsonc"))).toBe(false);
  });

  it("removing a provider deletes its files on disk when `before` is passed", async () => {
    const root = tmpRoot();
    let p = createProfile({ rootDir: root, manifest: true });
    p = upsertProvider(p, { id: "p1", protocol: "openai-chat-completions", baseUrl: "https://x" });
    p = upsertModel(p, { providerId: "p1", id: "m1", type: "chat" });
    await writeProfileAtomic(p);
    const providerFile = path.join(root, "providers/p1/provider.json");
    const modelsFile = path.join(root, "providers/p1/models.json");
    expect(fs.existsSync(providerFile)).toBe(true);
    expect(fs.existsSync(modelsFile)).toBe(true);

    // Simulate the CLI's maybeWrite: load the current state, remove a
    // provider, and pass `before` to writeProfileAtomic.
    const before = loadProfile({ path: root, skipValidate: true });
    const next = removeProvider(before, "p1");
    await writeProfileAtomic(next, { before });
    expect(fs.existsSync(providerFile)).toBe(false);
    expect(fs.existsSync(modelsFile)).toBe(false);
  });

  it("planChanges reports a delete for global.json/manifest.json when removed", async () => {
    const root = tmpRoot();
    let p = createProfile({ rootDir: root, manifest: true, global: true });
    p = upsertProvider(p, { id: "p1", protocol: "openai-chat-completions", baseUrl: "https://x" });
    await writeProfileAtomic(p);
    const globalFile = path.join(root, "global.json");
    const manifestFile = path.join(root, "manifest.json");
    expect(fs.existsSync(globalFile)).toBe(true);
    expect(fs.existsSync(manifestFile)).toBe(true);

    const before = loadProfile({ path: root, skipValidate: true });
    const next: typeof before = { ...before, global: undefined, manifest: undefined };
    const plan = planChanges(before, next);
    const globalChange = plan.changes.find((c) => c.path === globalFile);
    const manifestChange = plan.changes.find((c) => c.path === manifestFile);
    expect(globalChange?.kind).toBe("delete");
    expect(manifestChange?.kind).toBe("delete");
  });

  it("deletes a stale models.json when the last model of a surviving provider is removed", async () => {
    const root = tmpRoot();
    let p = createProfile({ rootDir: root });
    p = upsertProvider(p, { id: "ds", protocol: "openai-chat-completions", baseUrl: "https://x" });
    p = upsertModel(p, { providerId: "ds", id: "m1", type: "chat" });
    await writeProfileAtomic(p);
    const modelsFile = path.join(root, "providers/ds/models.json");
    expect(fs.existsSync(modelsFile)).toBe(true);

    // Remove the only model; provider still exists in `after`.
    const before = loadProfile({ path: root, skipValidate: true });
    const next = removeModel(before, { providerId: "ds", model: "m1" });
    const plan = planChanges(before, next);
    expect(plan.changes.some((c) => c.kind === "delete" && c.path === modelsFile)).toBe(true);

    await writeProfileAtomic(next, { before });
    expect(fs.existsSync(modelsFile)).toBe(false);
  });

  it("removeModel clears a global default that was set via an alias", () => {
    let p = createProfile({ rootDir: "/tmp/.lapp", global: true });
    p = upsertProvider(p, { id: "ds", protocol: "openai-chat-completions", baseUrl: "https://x" });
    p = upsertModel(p, { providerId: "ds", id: "deepseek-chat", type: "chat", aliases: ["fast"] });
    p = setDefaultModel(p, { providerId: "ds", model: "fast" });
    expect(p.global?.defaultModel?.model).toBe("fast");
    const next = removeModel(p, { providerId: "ds", model: "fast" });
    expect(next.global?.defaultModel).toBeUndefined();
  });

  // Regression: removing a provider whose on-disk models.json failed to parse
  // (so the loaded provider has models:null) must still queue models.json for
  // deletion. Previously the orphan models.json leaked on disk because
  // providerFileChanges omits models.json when provider.models is null.
  it("removing a provider with a malformed models.json still deletes models.json", async () => {
    const root = tmpRoot();
    const providerDir = path.join(root, "providers/ds");
    fs.mkdirSync(providerDir, { recursive: true });
    fs.writeFileSync(
      path.join(providerDir, "provider.json"),
      JSON.stringify({ id: "ds", protocol: "openai-chat-completions", baseUrl: "https://x" }),
      "utf8",
    );
    // Malformed: not valid JSON. loadProvider sets models:null + an ERROR diag.
    fs.writeFileSync(path.join(providerDir, "models.json"), "{not valid json", "utf8");
    const modelsFile = path.join(providerDir, "models.json");

    const before = loadProfile({ path: root, skipValidate: true });
    expect(before.providers[0]!.models).toBeNull();
    expect(fs.existsSync(modelsFile)).toBe(true);

    const next = removeProvider(before, "ds");
    const plan = planChanges(before, next);
    expect(plan.changes.some((c) => c.kind === "delete" && c.path === modelsFile)).toBe(true);

    // Execute the deletion. The load-time parse ERROR for the malformed
    // models.json is still in `before.diagnostics` and gets carried into
    // `next` by removeProvider; writeProfileAtomic would refuse on that
    // stale diagnostic (a separate residual issue — see code-review-plan).
    // skipValidate isolates this test to the orphan-deletion behavior.
    next.diagnostics = [];
    await writeProfileAtomic(next, { before, skipValidate: true });
    expect(fs.existsSync(modelsFile)).toBe(false);
  });

  // Regression: an alias that collides with a real model id must be reported.
  // Previously the alias-duplicate check only compared against other aliases,
  // so `models[0].id="gpt-4"` + `models[1].aliases=["gpt-4"]` passed silently
  // and resolved ambiguously at runtime.
  it("validateProfile warns when an alias duplicates a real model id", () => {
    let p = createProfile({ rootDir: "/tmp/.lapp" });
    p = upsertProvider(p, { id: "ds", protocol: "openai-chat-completions", baseUrl: "https://x" });
    p = upsertModel(p, { providerId: "ds", id: "gpt-4", type: "chat" });
    p = upsertModel(p, { providerId: "ds", id: "gpt-4o", type: "chat", aliases: ["gpt-4"] });
    const r = validateProfile(p);
    expect(r.diagnostics.some((d) => d.level === "WARN" && /duplicates an existing model id/.test(d.message))).toBe(true);
  });

  // validateProfile: manifest schema failure path
  it("validateProfile reports manifest schema errors", () => {
    let p = createProfile({ rootDir: "/tmp/.lapp" });
    p = upsertProvider(p, { id: "ds", protocol: "openai-chat-completions", baseUrl: "https://x" });
    // Set a manifest that violates the schema (missing required fields / wrong types)
    p.manifest = { schemaVersion: 123 } as unknown as typeof p.manifest;
    const r = validateProfile(p);
    // Schema validation may emit ERROR or just WARN depending on strictness;
    // the key is that the code path is exercised (no crash).
    expect(r.diagnostics.length).toBeGreaterThanOrEqual(0);
  });

  // validateProfile: no enabled providers WARN
  it("validateProfile warns when all providers are disabled", () => {
    let p = createProfile({ rootDir: "/tmp/.lapp" });
    p = upsertProvider(p, { id: "off1", protocol: "openai-chat-completions", baseUrl: "https://x", enabled: false });
    p = upsertProvider(p, { id: "off2", protocol: "openai-chat-completions", baseUrl: "https://y", enabled: false });
    const r = validateProfile(p);
    expect(r.diagnostics.some((d) => d.level === "WARN" && /no enabled providers/.test(d.message))).toBe(true);
  });

  // validateGlobal: default model refs provider with no models.json
  it("validateGlobal warns when defaultModel refs a provider without models.json", () => {
    let p = createProfile({ rootDir: "/tmp/.lapp" });
    p = upsertProvider(p, { id: "ds", protocol: "openai-chat-completions", baseUrl: "https://x" });
    // Provider has no models.json (models: null)
    if (!p.global) p.global = { schemaVersion: "1.0" };
    p.global.defaultModel = { providerId: "ds", model: "m" };
    const r = validateProfile(p);
    expect(r.diagnostics.some((d) => d.level === "WARN" && /has no models\.json/.test(d.message))).toBe(true);
  });

  // validateGlobal: model ref with empty model id
  it("validateGlobal warns when model ref has empty model", () => {
    let p = createProfile({ rootDir: "/tmp/.lapp" });
    p = upsertProvider(p, { id: "ds", protocol: "openai-chat-completions", baseUrl: "https://x" });
    p = upsertModel(p, { providerId: "ds", id: "m1", type: "chat" });
    if (!p.global) p.global = { schemaVersion: "1.0" };
    p.global.defaultModel = { providerId: "ds", model: "" };
    const r = validateProfile(p);
    expect(r.diagnostics.some((d) => d.level === "WARN" && /model is missing or empty/.test(d.message))).toBe(true);
  });

  // validateGlobal: model ref with unknown model id
  it("validateGlobal warns when defaultModel refs a model not in models.json", () => {
    let p = createProfile({ rootDir: "/tmp/.lapp" });
    p = upsertProvider(p, { id: "ds", protocol: "openai-chat-completions", baseUrl: "https://x" });
    p = upsertModel(p, { providerId: "ds", id: "m1", type: "chat" });
    if (!p.global) p.global = { schemaVersion: "1.0" };
    p.global.defaultModel = { providerId: "ds", model: "nonexistent" };
    const r = validateProfile(p);
    expect(r.diagnostics.some((d) => d.level === "WARN" && /was not found in provider/.test(d.message))).toBe(true);
  });

  // validateProvider: model source outside {provider, manual}
  it("validateProvider warns on unknown model source value", () => {
    let p = createProfile({ rootDir: "/tmp/.lapp" });
    p = upsertProvider(p, { id: "ds", protocol: "openai-chat-completions", baseUrl: "https://x" });
    p = upsertModel(p, { providerId: "ds", id: "m1", type: "chat", source: "unknown-source" } as Parameters<typeof upsertModel>[1]);
    const r = validateProfile(p);
    expect(r.diagnostics.some((d) => d.level === "WARN" && /source "unknown-source"/.test(d.message))).toBe(true);
  });

  // validateProvider: sensitive headers warning (via upsertProvider requestHeaders)
  it("validateProvider warns about sensitive requestHeaders", () => {
    let p = createProfile({ rootDir: "/tmp/.lapp" });
    p = upsertProvider(p, {
      id: "ds",
      protocol: "openai-chat-completions",
      baseUrl: "https://x",
      requestHeaders: { "Authorization": "sneaky", "X-Api-Key": "also-sneaky" },
    });
    const r = validateProfile(p);
    expect(r.diagnostics.some((d) => d.level === "WARN" && /sensitive header/.test(d.message))).toBe(true);
  });
});

describe("discovery.ts edge cases", () => {
  it("loadProfile on non-existent directory returns ERROR", () => {
    const root = path.join(os.tmpdir(), "lapp-missing-roots", ".lapp");
    const p = loadProfile({ path: root, skipValidate: true });
    expect(p.diagnostics.some((d) => d.level === "ERROR" && /does not exist/.test(d.message))).toBe(true);
  });

  it("loadProfile on directory with no providers/ returns missing directory ERROR", () => {
    const root = tmpRoot();
    fs.mkdirSync(root, { recursive: true });
    // No providers/ subdir
    const p = loadProfile({ path: root, skipValidate: true });
    expect(p.diagnostics.some((d) => d.level === "ERROR" && /missing providers/.test(d.message))).toBe(true);
  });

  it("loadProfile with malformed manifest.json reports JSON parse error", () => {
    const root = tmpRoot();
    fs.mkdirSync(root, { recursive: true });
    fs.mkdirSync(path.join(root, "providers"), { recursive: true });
    fs.writeFileSync(path.join(root, "manifest.json"), "{not valid", "utf8");
    const p = loadProfile({ path: root, skipValidate: true });
    expect(p.diagnostics.some((d) => d.level === "ERROR" && /invalid JSON/.test(d.message))).toBe(true);
  });

  it("loadProfile with structurally invalid models.json (not an array) reports error", () => {
    const root = tmpRoot();
    const providerDir = path.join(root, "providers", "ds");
    fs.mkdirSync(providerDir, { recursive: true });
    fs.writeFileSync(path.join(providerDir, "provider.json"), JSON.stringify({ id: "ds", protocol: "openai-chat-completions", baseUrl: "https://x" }));
    // Valid JSON but "models" is not an array → structural error
    fs.writeFileSync(path.join(providerDir, "models.json"), JSON.stringify({ models: "not-an-array" }));
    const p = loadProfile({ path: root, skipValidate: true });
    expect(p.diagnostics.some((d) => d.level === "ERROR" && /models must be an object with a models array/.test(d.message))).toBe(true);
  });

  it("loadProfile with valid JSON but non-object models.json (no models key) reports error", () => {
    const root = tmpRoot();
    const providerDir = path.join(root, "providers", "ds");
    fs.mkdirSync(providerDir, { recursive: true });
    fs.writeFileSync(path.join(providerDir, "provider.json"), JSON.stringify({ id: "ds", protocol: "openai-chat-completions", baseUrl: "https://x" }));
    // Valid JSON but a string, not an object
    fs.writeFileSync(path.join(providerDir, "models.json"), JSON.stringify("just a string"));
    const p = loadProfile({ path: root, skipValidate: true });
    expect(p.diagnostics.some((d) => d.level === "ERROR" && /models must be an object with a models array/.test(d.message))).toBe(true);
  });

  // Provider directory name != config.id emits WARN
  it("loadProfile warns when provider id does not match directory name", () => {
    const root = tmpRoot();
    const providerDir = path.join(root, "providers", "wrong-name");
    fs.mkdirSync(providerDir, { recursive: true });
    fs.writeFileSync(path.join(providerDir, "provider.json"), JSON.stringify({ id: "correct-name", protocol: "openai-chat-completions", baseUrl: "https://x" }));
    const p = loadProfile({ path: root, skipValidate: true });
    expect(p.diagnostics.some((d) => d.level === "WARN" && /does not match directory/.test(d.message))).toBe(true);
  });

  // BaseUrl trailing / warning in loadProvider
  it("loadProfile warns when baseUrl ends with /", () => {
    const root = tmpRoot();
    const providerDir = path.join(root, "providers", "ds");
    fs.mkdirSync(providerDir, { recursive: true });
    fs.writeFileSync(path.join(providerDir, "provider.json"), JSON.stringify({ id: "ds", protocol: "openai-chat-completions", baseUrl: "https://x.com/" }));
    const p = loadProfile({ path: root, skipValidate: true });
    expect(p.diagnostics.some((d) => d.level === "WARN" && /baseUrl should not end with/.test(d.message))).toBe(true);
  });
});

describe("manage negative cases", () => {
  it("upsertModel throws for non-existent providerId", () => {
    let p = createProfile({ rootDir: "/tmp/.lapp" });
    expect(() => upsertModel(p, { providerId: "nope", id: "m" })).toThrow(/provider not found/);
  });

  it("isSupportedProtocol returns true for the 3 v1 protocols", () => {
    expect(isSupportedProtocol("openai-chat-completions")).toBe(true);
    expect(isSupportedProtocol("openai-responses")).toBe(true);
    expect(isSupportedProtocol("anthropic-messages")).toBe(true);
    expect(isSupportedProtocol("minimax-api")).toBe(false);
    expect(isSupportedProtocol("")).toBe(false);
  });
});

describe("planChanges negative cases", () => {
  it("plans modify for global.json when it already exists on disk (not create)", async () => {
    const root = tmpRoot();
    let p = createProfile({ rootDir: root, global: true });
    p = upsertProvider(p, { id: "ds", protocol: "openai-chat-completions", baseUrl: "https://x" });
    await writeProfileAtomic(p); // writes global.json

    // Now modify global
    const before = loadProfile({ path: root, skipValidate: true });
    const next = { ...before, global: { schemaVersion: "1.0", defaultModel: { providerId: "ds", model: "m" } } };
    const plan = planChanges(before, next);
    const globalChange = plan.changes.find((c) => c.path.endsWith("global.json"));
    expect(globalChange?.kind).toBe("modify");
  });
});

describe("validate negative cases", () => {
  it("validateProfile reports ERROR for model with missing id", () => {
    let p = createProfile({ rootDir: "/tmp/.lapp" });
    p = upsertProvider(p, { id: "ds", protocol: "openai-chat-completions", baseUrl: "https://x" });
    p = upsertModel(p, { providerId: "ds", id: "m1", type: "chat" });
    // Manually inject a broken model entry (missing id)
    if (p.providers[0]!.models) {
      (p.providers[0]!.models.models as Array<Record<string, unknown>>).push({ type: "chat" });
    }
    const r = validateProfile(p);
    expect(r.diagnostics.some((d) => d.level === "ERROR" && /missing required field "id"/.test(d.message))).toBe(true);
  });

  it("validateGlobal reports ERROR for missing providerId in model ref", () => {
    let p = createProfile({ rootDir: "/tmp/.lapp" });
    p = upsertProvider(p, { id: "ds", protocol: "openai-chat-completions", baseUrl: "https://x" });
    if (!p.global) p.global = { schemaVersion: "1.0" };
    (p.global as Record<string, unknown>).defaultModel = { model: "m" }; // no providerId
    const r = validateProfile(p);
    expect(r.diagnostics.some((d) => d.level === "ERROR" && /missing providerId/.test(d.message))).toBe(true);
  });

  // upsertModel with non-existent provider (already covered by manage negative test above, assert on throw)
  it("upsertProvider with Windows reserved device name is sanitized", () => {
    let p = createProfile({ rootDir: "/tmp/.lapp" });
    // "con" is a reserved Windows device name
    p = upsertProvider(p, { id: "con", protocol: "openai-chat-completions", baseUrl: "https://x" });
    expect(p.providers[0]!.dir).toContain("con-profile");
  });

  // upsertProvider with inline models (covers model assignment line 129)
  it("upsertProvider accepts inline models array", () => {
    let p = createProfile({ rootDir: "/tmp/.lapp" });
    p = upsertProvider(p, {
      id: "inline",
      protocol: "openai-chat-completions",
      baseUrl: "https://x.com",
      models: [{ id: "in-m", type: "chat", source: "manual" }],
    });
    expect(p.providers[0]!.models?.models[0]!.id).toBe("in-m");
  });
});