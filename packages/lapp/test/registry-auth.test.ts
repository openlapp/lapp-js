import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  computeProfileRevision,
  computeRegistryRevision,
  commitRegistryTransaction,
  createProfile,
  listModelTargets,
  readRegistryStable,
  readProfileStable,
  removeAuthSource,
  resolveModelTarget,
  setAuthDefault,
  upsertAuthSource,
  upsertProvider,
  validateProfile,
  writeProfileAtomic,
} from "../src/index.js";
import type { RegistryModelSelector } from "../src/index.js";

const roots: string[] = [];

function root(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lapp-registry-"));
  roots.push(directory);
  return path.join(directory, ".lapp");
}

afterEach(() => {
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("LAPP 1.1 Auth registry", () => {
  it("upgrades global.json with the first Auth source in one atomic profile write", async () => {
    const profileRoot = root();
    const legacy = upsertProvider(createProfile({ rootDir: profileRoot }), {
      id: "provider",
      baseUrl: "https://api.example.test/v1",
      protocols: ["openai-chat-completions"],
      auth: { type: "none" },
      models: [{ id: "chat" }],
    });
    await writeProfileAtomic(legacy, { path: profileRoot, before: null });
    expect(fs.existsSync(path.join(profileRoot, "global.json"))).toBe(false);
    const before = readRegistryStable({ path: profileRoot });
    expect(before.value.global).toBeUndefined();

    const next = upsertAuthSource(before.value, {
      id: "grok-main",
      driver: "xai-grok",
      protocols: ["openai-chat-completions"],
      models: [{ id: "grok-build-0.1" }],
    });
    expect(next.global).toEqual({ schemaVersion: "1.1", defaults: {} });
    await writeProfileAtomic(next, { path: profileRoot, before: before.value });

    const persisted = readRegistryStable({ path: profileRoot });
    expect(persisted.value.global).toEqual({ schemaVersion: "1.1", defaults: {} });
    expect(persisted.value.auth).toHaveLength(1);
    expect(fs.existsSync(path.join(profileRoot, "global.json"))).toBe(true);
  });

  it("keeps provider-only writes on their legacy v1 boundary", async () => {
    const profileRoot = root();
    const legacy = upsertProvider(createProfile({ rootDir: profileRoot }), {
      id: "provider",
      baseUrl: "https://api.example.test/v1",
      protocols: ["openai-chat-completions"],
      auth: { type: "none" },
      models: [{ id: "chat" }],
    });
    await writeProfileAtomic(legacy, { path: profileRoot, before: null });
    const persisted = readProfileStable({ path: profileRoot });
    expect(persisted.value.global).toBeUndefined();
    expect(computeProfileRevision(profileRoot)).toBe(persisted.revision);
  });

  it("rejects credential-bearing Auth config keys recursively but permits endpoint metadata", () => {
    const safeConfig = {
      clientId: "public-client-id",
      tokenEndpoint: "https://auth.example.test/oauth/token",
      deviceCodeUrl: "https://auth.example.test/device/code",
      discoveryUrl: "https://auth.example.test/.well-known/openid-configuration",
      modelsUrl: "https://api.example.test/v1/models",
      inferenceBaseUrl: "https://api.example.test/v1",
      issuer: "https://auth.example.test",
      scope: "openid profile",
      reasoningEffort: "medium",
      accountId: "public-account-selector",
    };
    const safeProfile = upsertAuthSource(createProfile({ rootDir: root() }), {
      id: "grok-main",
      driver: "xai-grok",
      protocols: ["openai-chat-completions"],
      config: safeConfig,
      models: [{ id: "grok-build-0.1" }],
    });
    safeProfile.auth![0]!.config.extensions = {
      nested: { display: "safe" },
      tokenEndpoint: "https://auth.example.test/oauth/token",
    };
    safeProfile.auth![0]!.models.extensions = {
      nested: { display: "safe" },
      tokenEndpoint: "https://auth.example.test/oauth/token",
    };
    safeProfile.auth![0]!.models.models[0]!.extensions = {
      nested: { display: "safe" },
      deviceCodeUrl: "https://auth.example.test/device/code",
    };
    expect(validateProfile(safeProfile).valid).toBe(true);

    const profile = upsertAuthSource(createProfile({ rootDir: root() }), {
      id: "grok-main",
      driver: "xai-grok",
      protocols: ["openai-chat-completions"],
      config: {
        ...safeConfig,
        deviceCode: "must-not-be-portable",
        nested: [{
          "API-Key": "must-not-be-portable",
          privateKey: "must-not-be-portable",
          sessionCookie: "must-not-be-portable",
          credentialValue: "must-not-be-portable",
          authorization: "must-not-be-portable",
          authorizationHeader: "must-not-be-portable",
        }],
      },
      models: [{ id: "grok-build-0.1" }],
    });
    const result = validateProfile(profile);
    expect(result.valid).toBe(false);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: "SCHEMA_AUTH",
      location: "auth/grok-main/auth.json#/config/deviceCode",
    }));
    const locations = result.diagnostics.map((entry) => entry.location);
    expect(locations).toEqual(expect.arrayContaining([
      "auth/grok-main/auth.json#/config/nested/0/privateKey",
      "auth/grok-main/auth.json#/config/nested/0/sessionCookie",
      "auth/grok-main/auth.json#/config/nested/0/credentialValue",
      "auth/grok-main/auth.json#/config/nested/0/authorization",
      "auth/grok-main/auth.json#/config/nested/0/authorizationHeader",
    ]));
  });

  it("rejects Auth extensions and Auth models extensions recursively without tightening Provider models", () => {
    const safeProfile = upsertAuthSource(createProfile({ rootDir: root() }), {
      id: "grok-main",
      driver: "xai-grok",
      protocols: ["openai-chat-completions"],
      extensions: {
        nested: { display: "safe" },
        tokenEndpoint: "https://auth.example.test/oauth/token",
      },
      models: [{
        id: "grok-build-0.1",
        extensions: {
          nested: { display: "safe" },
          deviceCodeUrl: "https://auth.example.test/device/code",
        },
      }],
    });
    safeProfile.auth![0]!.models.extensions = {
      nested: { display: "safe" },
      tokenEndpoint: "https://auth.example.test/oauth/token",
    };
    expect(validateProfile(safeProfile).valid).toBe(true);

    const providerProfile = upsertProvider(createProfile({ rootDir: root() }), {
      id: "provider-main",
      baseUrl: "https://api.example.test/v1",
      protocols: ["openai-chat-completions"],
      auth: { type: "none" },
      models: [{ id: "provider-model", extensions: { nested: { accessToken: "provider-scope-unchanged" } } }],
    });
    providerProfile.providers[0]!.models.extensions = { nested: { privateKey: "provider-scope-unchanged" } };
    expect(validateProfile(providerProfile).valid).toBe(true);

    const authExtensions = structuredClone(safeProfile);
    authExtensions.auth![0]!.config.extensions = {
      nested: {
        accessToken: "must-not-be-portable",
        privateKey: "must-not-be-portable",
      },
    };
    const authResult = validateProfile(authExtensions);
    expect(authResult.valid).toBe(false);
    expect(authResult.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "SCHEMA_AUTH",
        location: "auth/grok-main/auth.json#/extensions/nested/accessToken",
      }),
      expect.objectContaining({
        code: "SCHEMA_AUTH",
        location: "auth/grok-main/auth.json#/extensions/nested/privateKey",
      }),
    ]));

    const modelsExtensions = structuredClone(safeProfile);
    modelsExtensions.auth![0]!.models.extensions = {
      nested: { accessToken: "must-not-be-portable" },
    };
    modelsExtensions.auth![0]!.models.models[0]!.extensions = {
      nested: { privateKey: "must-not-be-portable" },
    };
    const modelsResult = validateProfile(modelsExtensions);
    expect(modelsResult.valid).toBe(false);
    expect(modelsResult.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "SENSITIVE_AUTH_CONFIG_KEY",
        location: "auth/grok-main/models.json#/extensions/nested/accessToken",
      }),
      expect.objectContaining({
        code: "SENSITIVE_AUTH_CONFIG_KEY",
        location: "auth/grok-main/models.json#/models/0/extensions/nested/privateKey",
      }),
    ]));
  });

  it("accepts an Auth-only registry without providers and with empty 1.1 defaults", () => {
    const profileRoot = root();
    fs.mkdirSync(path.join(profileRoot, "auth", "codex-main"), { recursive: true });
    fs.writeFileSync(path.join(profileRoot, "global.json"), JSON.stringify({
      schemaVersion: "1.1",
      defaults: {},
    }));
    fs.writeFileSync(path.join(profileRoot, "auth", "codex-main", "auth.json"), JSON.stringify({
      schemaVersion: "1.1",
      id: "codex-main",
      driver: "openai-codex",
      protocols: ["openai-chat-completions"],
    }));
    fs.writeFileSync(path.join(profileRoot, "auth", "codex-main", "models.json"), JSON.stringify({
      schemaVersion: "1.0",
      models: [{ id: "gpt-5-codex" }],
    }));
    const stable = readRegistryStable({ path: profileRoot });
    expect(stable.value.providers).toEqual([]);
    expect(stable.value.auth).toHaveLength(1);
    expect(stable.value.global?.defaults).toEqual({});
  });

  it("persists, reads, lists, resolves, and revisions Auth model sources", async () => {
    const profileRoot = root();
    let profile = createProfile({ rootDir: profileRoot });
    profile = upsertAuthSource(profile, {
      id: "grok-main",
      name: "Grok subscription",
      driver: "xai-grok",
      protocols: ["openai-chat-completions"],
      models: [{ id: "grok-build-0.1", aliases: ["grok"] }],
    });
    profile = setAuthDefault(profile, "chat", { authId: "grok-main", modelId: "grok" });
    await writeProfileAtomic(profile, { path: profileRoot, before: null });

    expect(fs.existsSync(path.join(profileRoot, "auth", "grok-main", "auth.json"))).toBe(true);
    expect(fs.existsSync(path.join(profileRoot, "auth", "grok-main", "models.json"))).toBe(true);

    const stable = readRegistryStable({ path: profileRoot });
    expect(stable.revision).toBe(computeRegistryRevision(profileRoot));
    expect(stable.value.auth).toHaveLength(1);
    expect(listModelTargets(stable.value)).toContainEqual(expect.objectContaining({
      source: "auth",
      authId: "grok-main",
      modelId: "grok-build-0.1",
      driver: "xai-grok",
    }));
    expect(resolveModelTarget(stable.value, { default: "chat" })).toMatchObject({
      source: "auth",
      authId: "grok-main",
      modelId: "grok-build-0.1",
      protocol: "openai-chat-completions",
    });
  });

  it("revision-v2 observes auth bytes while revision-v1 remains provider-only", async () => {
    const profileRoot = root();
    const profile = upsertAuthSource(createProfile({ rootDir: profileRoot }), {
      id: "codex-main",
      driver: "openai-codex",
      protocols: ["openai-chat-completions"],
      models: [{ id: "gpt-5-codex" }],
    });
    await writeProfileAtomic(profile, { path: profileRoot, before: null });
    const providerRevision = computeProfileRevision(profileRoot);
    const registryRevision = computeRegistryRevision(profileRoot);
    const authFile = path.join(profileRoot, "auth", "codex-main", "auth.json");
    fs.writeFileSync(authFile, fs.readFileSync(authFile, "utf8").replace("codex-main", "codex-next"));
    expect(computeProfileRevision(profileRoot)).toBe(providerRevision);
    expect(computeRegistryRevision(profileRoot)).not.toBe(registryRevision);
  });

  it("refuses to remove an Auth directory that contains unmanaged data", async () => {
    const profileRoot = root();
    const before = upsertAuthSource(createProfile({ rootDir: profileRoot }), {
      id: "grok-main",
      driver: "xai-grok",
      protocols: ["openai-chat-completions"],
      models: [{ id: "grok-build-0.1" }],
    });
    before.global = { schemaVersion: "1.1", defaults: {} };
    await writeProfileAtomic(before, { path: profileRoot, before: null });
    const marker = path.join(profileRoot, "auth", "grok-main", "notes.txt");
    fs.writeFileSync(marker, "unmanaged");
    const after = removeAuthSource(before, "grok-main");
    await expect(writeProfileAtomic(after, { path: profileRoot, before }))
      .rejects.toThrow("unmanaged content");
    expect(fs.existsSync(marker)).toBe(true);
    expect(fs.existsSync(path.join(profileRoot, "auth", "grok-main", "auth.json"))).toBe(true);
  });

  it("rejects non-closed RegistryModelRef branches", () => {
    const profile = upsertAuthSource(createProfile({ rootDir: root() }), {
      id: "grok-main",
      driver: "xai-grok",
      protocols: ["openai-chat-completions"],
      models: [{ id: "grok-build-0.1" }],
    });
    const invalid = [
      { modelId: "grok-build-0.1" },
      { authId: "grok-main", providerId: "grok-main", modelId: "grok-build-0.1" },
      { authId: "grok-main", modelId: "grok-build-0.1", extra: true },
    ];
    for (const selector of invalid) {
      expect(() => resolveModelTarget(profile, selector as unknown as RegistryModelSelector))
        .toThrow(TypeError);
    }
  });

  it("commits Auth catalog changes under revision-v2 CAS", async () => {
    const profileRoot = root();
    const before = upsertAuthSource(createProfile({ rootDir: profileRoot }), {
      id: "grok-main",
      driver: "xai-grok",
      protocols: ["openai-chat-completions"],
      models: [{ id: "grok-build-0.1" }],
    });
    before.global = { schemaVersion: "1.1", defaults: {} };
    await writeProfileAtomic(before, { path: profileRoot, before: null });
    const expectedRevision = computeRegistryRevision(profileRoot);
    const stateHome = root();
    const next = structuredClone(before);
    next.auth![0]!.models.models.push({ id: "grok-build-0.2" });
    await commitRegistryTransaction({
      rootDir: profileRoot,
      before,
      next,
      expectedRevision,
      lock: { stateHome },
    });
    expect(readRegistryStable({ path: profileRoot }).value.auth[0]?.models.models)
      .toContainEqual(expect.objectContaining({ id: "grok-build-0.2" }));
    await expect(commitRegistryTransaction({
      rootDir: profileRoot,
      before,
      next: before,
      profileChanged: true,
      expectedRevision,
      lock: { stateHome },
    })).rejects.toMatchObject({ code: "PROFILE_CONFLICT" });
  });
});
