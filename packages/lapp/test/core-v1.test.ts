import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MissingEnvSecretError,
  ModelRefreshError,
  ProfileValidationError,
  TargetResolutionError,
  createLappClient,
  createProfile,
  inspectProfile,
  listModels,
  loadProfile,
  refreshModels,
  removeModel,
  removeProvider,
  resolveConnection,
  setDefault,
  upsertModel,
  upsertProvider,
  validateProfile,
  writeProfileAtomic,
  type AuthConfig,
  type LappProfile,
} from "../src/index.js";

const roots: string[] = [];

function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lapp-v1-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function profile(
  auth: AuthConfig = { type: "none" },
  options: { discovery?: boolean; protocols?: string[] } = {},
): LappProfile {
  return profileAt(temporaryRoot(), auth, options);
}

function profileAt(
  root: string,
  auth: AuthConfig = { type: "none" },
  options: { discovery?: boolean; protocols?: string[] } = {},
): LappProfile {
  let result = createProfile({ rootDir: root });
  result = upsertProvider(result, {
    id: "provider",
    baseUrl: "http://127.0.0.1:8080/v1",
    protocols: options.protocols ?? ["openai-responses", "openai-chat-completions"],
    auth,
    ...(options.discovery
      ? { modelDiscovery: { protocol: "openai-models", url: "http://127.0.0.1:8080/v1/models" } as const }
      : {}),
  });
  return upsertModel(result, { providerId: "provider", id: "model-a", aliases: ["fast"] });
}

describe("LAPP v1 profile", () => {
  it("validates the strict v1 shape and rejects legacy fields", () => {
    const valid = profile();
    expect(validateProfile(valid).valid).toBe(true);
    const legacy = structuredClone(valid) as unknown as {
      providers: Array<{ config: Record<string, unknown> }>;
    };
    legacy.providers[0]!.config.protocol = "openai-responses";
    expect(validateProfile(legacy as unknown as LappProfile).valid).toBe(false);
  });

  it.each(["../../escape", "a/b", "a:b", "CON", "nul.txt", "foo."])(
    "rejects unsafe provider id %s instead of sanitizing it",
    (id) => {
      expect(() => upsertProvider(profile(), {
        id,
        baseUrl: "https://example.com/v1",
        protocols: ["openai-responses"],
        auth: { type: "none" },
      })).toThrow(/invalid provider id/i);
    },
  );

  it("rejects conflicting aliases and model protocols outside the provider set", () => {
    let value = profile();
    value = upsertModel(value, {
      providerId: "provider",
      id: "model-b",
      aliases: ["model-a"],
      protocols: ["anthropic-messages"],
    });
    const result = validateProfile(value);
    expect(result.valid).toBe(false);
    expect(result.diagnostics.some((entry) => entry.message.includes("already owned"))).toBe(true);
    expect(result.diagnostics.some((entry) => entry.message.includes("not declared"))).toBe(true);
  });

  it("stores defaults as canonical model IDs and blocks referenced removal", () => {
    const value = setDefault(profile(), "chat", { providerId: "provider", model: "fast" });
    expect(value.global?.defaults.chat).toEqual({ providerId: "provider", modelId: "model-a" });
    expect(() => removeModel(value, { providerId: "provider", model: "fast" })).toThrow(/default/);
    expect(() => removeProvider(value, "provider")).toThrow(/default/);
  });

  it("writes only JSON files and loads a clean domain profile", async () => {
    const root = temporaryRoot();
    const value = setDefault(profileAt(root), "chat", { providerId: "provider", model: "model-a" });
    await writeProfileAtomic(value);
    const loaded = loadProfile({ path: root });
    expect(loaded).toEqual(value);
    expect("rootDir" in loaded).toBe(false);
    expect("diagnostics" in loaded).toBe(false);
    expect("dir" in loaded.providers[0]!).toBe(false);
    expect("__dirName" in loaded.providers[0]!.config).toBe(false);
    expect(fs.existsSync(path.join(root, "manifest.json"))).toBe(false);
  });

  it("rejects JSONC and exposes redacted diagnostics through inspectProfile", () => {
    const root = temporaryRoot();
    fs.mkdirSync(path.join(root, "providers", "provider"), { recursive: true });
    fs.writeFileSync(path.join(root, "providers", "provider", "provider.jsonc"), "{}", "utf8");
    expect(() => loadProfile({ path: root })).toThrow(ProfileValidationError);
    const inspected = inspectProfile({ path: root });
    expect(inspected.diagnostics.some((entry) => /JSONC/.test(entry.message))).toBe(true);
    expect(JSON.stringify(inspected)).not.toContain("sk-secret");
  });

  it("rejects every provider directory that lacks provider.json", () => {
    const root = temporaryRoot();
    fs.mkdirSync(path.join(root, "providers", "orphan"), { recursive: true });
    expect(() => loadProfile({ path: root })).toThrow(ProfileValidationError);
    expect(inspectProfile({ path: root }).diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ location: "providers/orphan", message: "missing provider.json" }),
    ]));
  });

  it("requires models.json for every provider", () => {
    const root = temporaryRoot();
    const value = profileAt(root);
    fs.mkdirSync(path.join(root, "providers", "provider"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "providers", "provider", "provider.json"),
      JSON.stringify(value.providers[0]!.config),
      "utf8",
    );
    expect(() => loadProfile({ path: root })).toThrow(ProfileValidationError);
    expect(inspectProfile({ path: root }).diagnostics)
      .toEqual(expect.arrayContaining([expect.objectContaining({ message: "missing models.json" })]));
  });

  it("refuses an in-memory traversal profile before creating an outside file", async () => {
    const root = temporaryRoot();
    const outside = path.resolve(root, "..", "escape", "provider.json");
    const invalid = profileAt(root);
    invalid.providers[0]!.config.id = "../escape";
    await expect(writeProfileAtomic(invalid)).rejects.toThrow(ProfileValidationError);
    expect(fs.existsSync(outside)).toBe(false);
  });

  it("rejects non-JSON extension values instead of silently changing them", () => {
    const invalid = profile() as LappProfile & {
      providers: Array<{ config: { extensions?: Record<string, unknown> } }>;
    };
    invalid.providers[0]!.config.extensions = { date: new Date(), missing: undefined };
    expect(validateProfile(invalid).valid).toBe(false);
    expect(validateProfile(invalid).diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: expect.stringMatching(/cannot be represented in JSON/) }),
    ]));
  });
});

describe("connection resolution", () => {
  it("lists models without resolving a missing env secret", async () => {
    const value = profile({ type: "bearer", secret: "env://MISSING" });
    expect(listModels(value)).toHaveLength(1);
    await expect(resolveConnection(value, { providerId: "provider", model: "model-a" }, { env: {} }))
      .rejects.toThrow(MissingEnvSecretError);
  });

  it("selects the first supported model protocol and resolves aliases", async () => {
    const value = profile({ type: "header", name: "X-Token", secret: "env://TOKEN" });
    const resolved = await resolveConnection(
      value,
      { providerId: "provider", model: "fast" },
      { supportedProtocols: ["openai-chat-completions"], env: { TOKEN: "secret" } },
    );
    expect(resolved).toMatchObject({
      providerId: "provider",
      modelId: "model-a",
      protocol: "openai-chat-completions",
      auth: { type: "header", name: "X-Token", secret: "secret" },
    });
  });

  it("resolves named defaults and rejects disabled or unsupported targets", async () => {
    let value = setDefault(profile(), "chat", { providerId: "provider", model: "model-a" });
    expect((await resolveConnection(value, { default: "chat" })).modelId).toBe("model-a");
    await expect(resolveConnection(value, { default: "missing" })).rejects.toThrow(TargetResolutionError);
    await expect(resolveConnection(value, { default: "chat" }, { supportedProtocols: [] }))
      .rejects.toThrow(/no supported protocol/i);
    value = upsertModel(value, { providerId: "provider", id: "model-a", enabled: false });
    await expect(resolveConnection(value, { providerId: "provider", model: "model-a" }))
      .rejects.toThrow(/disabled/i);
  });

  it.each<AuthConfig>([
    { type: "none" },
    { type: "bearer", secret: "plain" },
    { type: "header", name: "X-Key", secret: "plain" },
    { type: "query", name: "key", secret: "plain" },
  ])("preserves strict auth shape $type", async (auth) => {
    expect((await resolveConnection(profile(auth), { providerId: "provider", model: "model-a" })).auth)
      .toEqual(auth);
  });

  it("rejects disguised loopback hosts and secret-like request headers", () => {
    let value = profile({ type: "header", name: "X-Custom-Key", secret: "plain" });
    value = upsertProvider(value, {
      id: "provider",
      baseUrl: "http://127.attacker.example/v1",
      requestHeaders: {
        "X-Custom-Api-Key": "leak",
        "x-custom-key": "collision",
        "X-Trace": "one",
        "x-trace": "two",
      },
    });
    const result = validateProfile(value);
    expect(result.valid).toBe(false);
    expect(result.diagnostics.map((entry) => entry.message).join("\n")).toMatch(/HTTPS/i);
    expect(result.diagnostics.map((entry) => entry.message).join("\n")).toMatch(/sensitive header/i);
    expect(result.diagnostics.map((entry) => entry.message).join("\n")).toMatch(/duplicate authentication header/i);
    expect(result.diagnostics.map((entry) => entry.message).join("\n")).toMatch(/case-insensitive duplicates/i);
  });

  it("never lets an invalid in-memory profile reach credential or network code", async () => {
    let value = profile({ type: "bearer", secret: "plaintext-secret" }, { discovery: true });
    value = upsertProvider(value, {
      id: "provider",
      baseUrl: "http://remote.example/v1",
      modelDiscovery: {
        protocol: "openai-models",
        url: "http://remote.example/v1/models",
      },
    });
    const fetchImpl = async () => {
      throw new Error("network must not be called");
    };

    expect(() => createLappClient({
      profile: value,
      provider: "provider",
      model: "model-a",
      fetchImpl,
    })).toThrow(ProfileValidationError);
    await expect(resolveConnection(value, { providerId: "provider", model: "model-a" }))
      .rejects.toThrow(ProfileValidationError);
    await expect(refreshModels(value, "provider", { fetch: fetchImpl }))
      .rejects.toThrow(ProfileValidationError);
  });
});

describe("model refresh", () => {
  it("only appends sorted new models, fills missing names, and leaves the input/disk untouched", async () => {
    const root = temporaryRoot();
    const value = profileAt(root, { type: "bearer", secret: "env://TOKEN" }, { discovery: true });
    const before = structuredClone(value);
    let request: { url?: string; init?: RequestInit } = {};
    const fetchImpl: typeof fetch = async (input, init) => {
      request = { url: String(input), init };
      return new Response(JSON.stringify({
        data: [
          { id: "model-c", name: "C" },
          { id: "model-a", name: "A" },
          { id: "model-b", name: "B" },
        ],
      }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const result = await refreshModels(value, "provider", { env: { TOKEN: "secret" }, fetch: fetchImpl });
    expect(value).toEqual(before);
    expect(fs.readdirSync(root)).toEqual([]);
    expect(result.nextProfile.providers[0]!.models!.models.map((model) => model.id))
      .toEqual(["model-a", "model-b", "model-c"]);
    expect(result.nextProfile.providers[0]!.models!.models[0]!.name).toBe("A");
    expect(result.added.map((model) => model.modelId)).toEqual(["model-b", "model-c"]);
    expect(request.init?.redirect).toBe("error");
    expect(new Headers(request.init?.headers).get("authorization")).toBe("Bearer secret");
  });

  it("treats a valid empty list as no change and malformed 200 as an error", async () => {
    const value = profile({ type: "none" }, { discovery: true });
    const empty = await refreshModels(value, "provider", {
      fetch: async () => new Response('{"data":[]}', { status: 200 }),
    });
    expect(empty.nextProfile).toBe(value);
    await expect(refreshModels(value, "provider", {
      fetch: async () => new Response('{"unexpected":[]}', { status: 200 }),
    })).rejects.toMatchObject({ code: "INVALID_RESPONSE" } satisfies Partial<ModelRefreshError>);
  });

  it("passes AbortSignal to discovery fetch and rejects alias namespace collisions", async () => {
    let value = profile({ type: "none" }, { discovery: true });
    value = upsertModel(value, { providerId: "provider", id: "model-a", aliases: ["remote-id"] });
    const controller = new AbortController();
    let capturedSignal: AbortSignal | null | undefined;
    await expect(refreshModels(value, "provider", {
      signal: controller.signal,
      fetch: async (_input, init) => {
        capturedSignal = init?.signal;
        return new Response('{"data":[{"id":"remote-id"}]}', { status: 200 });
      },
    })).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    expect(capturedSignal).toBe(controller.signal);
  });

  it("reports network, redirect, and non-advancing pagination failures deterministically", async () => {
    const openai = profile({ type: "none" }, { discovery: true });
    await expect(refreshModels(openai, "provider", {
      fetch: async () => { throw new Error("offline"); },
    })).rejects.toMatchObject({ code: "HTTP_ERROR" });
    await expect(refreshModels(openai, "provider", {
      fetch: async () => new Response("", { status: 302 }),
    })).rejects.toMatchObject({ code: "HTTP_ERROR" });

    let anthropic = profile({ type: "none" }, { protocols: ["anthropic-messages"] });
    anthropic = upsertProvider(anthropic, {
      id: "provider",
      modelDiscovery: {
        protocol: "anthropic-models",
        url: "http://127.0.0.1:8080/v1/models",
      },
    });
    await expect(refreshModels(anthropic, "provider", {
      fetch: async () => new Response(JSON.stringify({
        data: [],
        has_more: true,
        last_id: "same",
      }), { status: 200 }),
    })).rejects.toMatchObject({ code: "PAGINATION_ERROR" });
  });

  it("does not alter pre-existing profile bytes while producing a refresh proposal", async () => {
    const root = temporaryRoot();
    const value = profileAt(root, { type: "none" }, { discovery: true });
    await writeProfileAtomic(value);
    const providerFile = path.join(root, "providers", "provider", "provider.json");
    const modelsFile = path.join(root, "providers", "provider", "models.json");
    const before = [fs.readFileSync(providerFile), fs.readFileSync(modelsFile)];

    const result = await refreshModels(value, "provider", {
      fetch: async () => new Response('{"data":[{"id":"model-b","name":"Model B"}]}', {
        status: 200,
      }),
    });

    expect(result.added.map((model) => model.modelId)).toEqual(["model-b"]);
    expect(fs.readFileSync(providerFile)).toEqual(before[0]);
    expect(fs.readFileSync(modelsFile)).toEqual(before[1]);
  });

  it("uses Anthropic pagination without leaking header auth", async () => {
    let value = profile(
      { type: "query", name: "api_key", secret: "secret" },
      { protocols: ["anthropic-messages"] },
    );
    value = upsertProvider(value, {
      id: "provider",
      modelDiscovery: {
        protocol: "anthropic-models",
        url: "http://127.0.0.1:8080/v1/models",
      },
    });
    const urls: URL[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = new URL(String(input));
      urls.push(url);
      const second = url.searchParams.get("after_id") === "one";
      return new Response(JSON.stringify(second
        ? { data: [{ id: "two", display_name: "Two" }], has_more: false, last_id: "two" }
        : { data: [{ id: "one", display_name: "One" }], has_more: true, last_id: "one" }), { status: 200 });
    };
    const result = await refreshModels(value, "provider", { fetch: fetchImpl });
    expect(result.added.map((model) => model.modelId)).toEqual(["one", "two"]);
    expect(urls[0]!.searchParams.get("api_key")).toBe("secret");
    expect(urls[1]!.searchParams.get("after_id")).toBe("one");
  });

  it("rejects discovery without configuration or across origins before fetch", async () => {
    await expect(refreshModels(profile(), "provider")).rejects.toMatchObject({
      code: "DISCOVERY_NOT_CONFIGURED",
    });
    let value = profile();
    value = upsertProvider(value, {
      id: "provider",
      modelDiscovery: { protocol: "openai-models", url: "https://attacker.example/models" },
    });
    await expect(refreshModels(value, "provider", { fetch: async () => { throw new Error("called"); } }))
      .rejects.toThrow(/origin/i);
  });
});
