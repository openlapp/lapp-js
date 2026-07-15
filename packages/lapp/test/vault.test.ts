import { beforeEach, describe, expect, it } from "vitest";
import {
  CredentialError,
  createCredentialResolver,
  createLappClient,
  createProfile,
  credentialBindingForProvider,
  formatVaultSecretRef,
  parseSecretRef,
  parseVaultSecretRef,
  refreshModels,
  selectConnection,
  upsertProvider,
  upsertProviderWithCredential,
  validateProfile,
  type CredentialBinding,
  type CredentialResolver,
  type CredentialVault,
  type LappProfile,
} from "../src/index.js";
import {
  createCredentialVaultFromKeyring,
  LAPP_VAULT_SERVICE,
} from "../src/secret/vault.js";

class FakeAsyncEntry {
  static readonly records = new Map<string, string>();

  private readonly key: string;

  constructor(service: string, username: string) {
    this.key = `${service}|${username}`;
  }

  async setPassword(password: string): Promise<void> {
    FakeAsyncEntry.records.set(this.key, password);
  }

  async getPassword(): Promise<string | undefined> {
    return FakeAsyncEntry.records.get(this.key);
  }

  async deleteCredential(): Promise<boolean> {
    return FakeAsyncEntry.records.delete(this.key);
  }
}

const reference = "vault://provider/default";
const binding: CredentialBinding = {
  providerId: "provider",
  origin: "https://provider.example",
  auth: { type: "bearer" },
};

function fakeVault(): CredentialVault {
  return createCredentialVaultFromKeyring(FakeAsyncEntry);
}

function erroringVault(message: string): CredentialVault {
  return createCredentialVaultFromKeyring(class {
    constructor(_service: string, _username: string) {}
    async setPassword(): Promise<void> { throw new Error(message); }
    async getPassword(): Promise<string | undefined> { throw new Error(message); }
    async deleteCredential(): Promise<boolean> { throw new Error(message); }
  });
}

async function vaultProfile(vault: CredentialVault): Promise<LappProfile> {
  const result = await upsertProviderWithCredential(
    createProfile({ rootDir: process.cwd() }),
    {
      id: "provider",
      baseUrl: "https://provider.example/v1",
      protocols: ["openai-chat-completions"],
      models: [{ id: "model" }],
      auth: {
        type: "bearer",
        credential: { secret: "sk-vault-secret-one" },
      },
    },
    { vault },
  );
  return result.profile;
}

beforeEach(() => {
  FakeAsyncEntry.records.clear();
});

describe("vault credential references", () => {
  it("recognizes only the three v1 secret forms and applies the strict vault grammar", () => {
    expect(parseSecretRef("plain").scheme).toBe("plaintext");
    expect(parseSecretRef("env://TOKEN").scheme).toBe("env");
    expect(parseSecretRef("env:TOKEN").scheme).toBe("env");
    expect(parseSecretRef("env:TOKEN").reference).toBeUndefined();
    expect(parseSecretRef(reference).scheme).toBe("vault");
    expect(parseSecretRef("vault:provider/default").scheme).toBe("vault");
    expect(parseSecretRef("vault:provider/default").reference).toBeUndefined();
    expect(parseSecretRef("keychain://legacy/item").scheme).toBe("unknown");
    expect(parseSecretRef("file://secret").scheme).toBe("unknown");
    expect(parseVaultSecretRef(reference)).toEqual({
      providerId: "provider",
      credentialId: "default",
    });

    for (const invalid of [
      "vault://provider",
      "vault://provider/",
      "vault://provider/a/b",
      "vault://Provider/default",
      "vault://provider/%64efault",
      "vault://provider/default?x=1",
      "vault://provider/default#x",
      "vault://con/default",
      "vault://provider/nul.txt",
      "vault://provider/trailing.",
    ]) {
      expect(() => parseVaultSecretRef(invalid)).toThrow(CredentialError);
    }
    expect(formatVaultSecretRef("provider", "secondary")).toBe("vault://provider/secondary");
  });

  it("rejects malformed references and invalid plaintext through the public resolver", async () => {
    const resolver = createCredentialResolver({ vault: fakeVault(), env: {} });
    for (const raw of ["", "first\nsecond", "env:TOKEN", "vault:provider/default"]) {
      await expect(resolver.resolve(raw, binding)).rejects.toMatchObject({
        code: "INVALID_SECRET_REFERENCE",
      });
    }
    await expect(resolver.resolve("keychain://legacy/item", binding)).rejects.toMatchObject({
      code: "UNSUPPORTED_SECRET_SCHEME",
    });
  });

  it("reports stable semantic diagnostics for every secret form", () => {
    const profileFor = (secret: string): LappProfile => upsertProvider(
      createProfile({ rootDir: process.cwd() }),
      {
        id: "provider",
        baseUrl: "https://provider.example/v1",
        protocols: ["openai-chat-completions"],
        auth: { type: "bearer", secret },
      },
    );
    const codesFor = (secret: string): Array<string | undefined> =>
      validateProfile(profileFor(secret)).diagnostics.map((entry) => entry.code);

    expect(validateProfile(profileFor(reference)).valid).toBe(true);
    expect(codesFor("vault://other/default")).toContain("VAULT_PROVIDER_MISMATCH");
    expect(codesFor("vault://provider/default?x=1")).toContain("INVALID_VAULT_SECRET");
    expect(codesFor("env:INVALID")).toContain("INVALID_ENV_SECRET");
    for (const unsupported of ["keychain://legacy/item", "file://secret", "custom://secret"]) {
      expect(codesFor(unsupported)).toContain("UNSUPPORTED_SECRET_SCHEME");
    }
    expect(codesFor("explicit-plaintext")).toContain("PLAINTEXT_SECRET");
  });
});

describe("system keyring Vault adapter", () => {
  it("refuses non-portable provider and credential ids before keyring access", async () => {
    const vault = fakeVault();
    await expect(vault.put("vault://con/default", "sk-secret-value", {
      ...binding,
      providerId: "con",
    })).rejects.toMatchObject({ code: "INVALID_SECRET_REFERENCE" });
    await expect(vault.put("vault://provider/nul.txt", "sk-secret-value", binding))
      .rejects.toMatchObject({ code: "INVALID_SECRET_REFERENCE" });
    expect(FakeAsyncEntry.records.size).toBe(0);
  });

  it("rejects empty or multiline secrets before keyring access", async () => {
    const vault = fakeVault();
    for (const secret of ["", "first\nsecond", "first\rsecond"]) {
      await expect(vault.put(reference, secret, binding)).rejects.toMatchObject({
        code: "INVALID_SECRET_REFERENCE",
      });
    }
    expect(FakeAsyncEntry.records.size).toBe(0);
  });

  it("rejects invalid runtime auth bindings before keyring access", async () => {
    const vault = fakeVault();
    for (const auth of [
      { type: "unknown", name: "X-Key" },
      { type: "header", name: "bad header" },
      { type: "query", name: "" },
      { type: "query", name: "bad\nname" },
    ]) {
      await expect(vault.put(reference, "secret", { ...binding, auth } as never))
        .rejects.toMatchObject({ code: "INVALID_SECRET_REFERENCE" });
    }
    expect(FakeAsyncEntry.records.size).toBe(0);
  });

  it("returns a stable credential error for untyped secret and binding inputs", async () => {
    const vault = fakeVault();
    await expect(vault.put(reference, 123 as never, binding)).rejects.toMatchObject({
      code: "INVALID_SECRET_REFERENCE",
    });
    await expect(vault.put(reference, "secret", null as never)).rejects.toMatchObject({
      code: "INVALID_SECRET_REFERENCE",
    });
    await expect(vault.resolve(reference, null as never)).rejects.toMatchObject({
      code: "INVALID_SECRET_REFERENCE",
    });
    await expect(vault.status(reference, null as never)).rejects.toMatchObject({
      code: "INVALID_SECRET_REFERENCE",
    });
    expect(FakeAsyncEntry.records.size).toBe(0);
  });

  it("creates, inspects, resolves, rotates, and deletes a bound envelope", async () => {
    const vault = fakeVault();
    await vault.put(reference, "sk-first-secret", binding);

    const stored = FakeAsyncEntry.records.get(`${LAPP_VAULT_SERVICE}|provider/default`)!;
    const envelope = JSON.parse(stored) as Record<string, unknown>;
    expect(envelope).toMatchObject({
      version: 1,
      providerId: "provider",
      credentialId: "default",
      origin: "https://provider.example",
      auth: { type: "bearer" },
      secret: "sk-first-secret",
    });
    await expect(vault.put(reference, "sk-second-secret", binding)).rejects.toMatchObject({
      code: "VAULT_CREDENTIAL_EXISTS",
    });
    await expect(vault.resolve(reference, binding)).resolves.toBe("sk-first-secret");
    await expect(vault.status(reference, binding)).resolves.toEqual({
      reference,
      exists: true,
      bindingMatches: true,
    });

    await vault.put(reference, "sk-second-secret", binding, { overwrite: true });
    await expect(vault.resolve(reference, binding)).resolves.toBe("sk-second-secret");
    await expect(vault.delete(reference)).resolves.toBe(true);
    await expect(vault.delete(reference)).resolves.toBe(false);
    await expect(vault.resolve(reference, binding)).rejects.toMatchObject({
      code: "VAULT_CREDENTIAL_NOT_FOUND",
    });
  });

  it("enforces provider, origin, and normalized auth binding", async () => {
    const vault = fakeVault();
    const headerBinding: CredentialBinding = {
      ...binding,
      auth: { type: "header", name: "X-Api-Key" },
    };
    await vault.put(reference, "sk-bound-secret", headerBinding);

    await expect(vault.resolve(reference, {
      ...headerBinding,
      auth: { type: "header", name: "x-api-key" },
    })).resolves.toBe("sk-bound-secret");
    await expect(vault.resolve(reference, {
      ...headerBinding,
      origin: "https://attacker.example",
    })).rejects.toMatchObject({ code: "VAULT_BINDING_MISMATCH" });
    await expect(vault.resolve(reference, {
      ...headerBinding,
      auth: { type: "query", name: "X-Api-Key" },
    })).rejects.toMatchObject({ code: "VAULT_BINDING_MISMATCH" });
    await expect(vault.status(reference, {
      ...headerBinding,
      origin: "https://attacker.example",
    })).resolves.toMatchObject({ exists: true, bindingMatches: false });

    const queryBinding: CredentialBinding = {
      ...binding,
      auth: { type: "query", name: "api_key" },
    };
    await vault.put(reference, "sk-query-secret", queryBinding, { overwrite: true });
    await expect(vault.resolve(reference, queryBinding)).resolves.toBe("sk-query-secret");
    await expect(vault.resolve(reference, {
      ...queryBinding,
      auth: { type: "query", name: "API_KEY" },
    })).rejects.toMatchObject({ code: "VAULT_BINDING_MISMATCH" });
  });

  it("rejects corrupt records without exposing their contents", async () => {
    const vault = fakeVault();
    const corruptSecret = "sk-corrupt-should-not-leak";
    FakeAsyncEntry.records.set(
      `${LAPP_VAULT_SERVICE}|provider/default`,
      JSON.stringify({ secret: corruptSecret }),
    );
    let error: unknown;
    try {
      await vault.resolve(reference, binding);
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: "VAULT_RECORD_INVALID" });
    expect(String(error)).not.toContain(corruptSecret);

    FakeAsyncEntry.records.set(
      `${LAPP_VAULT_SERVICE}|provider/default`,
      JSON.stringify({
        version: 1,
        providerId: "provider",
        credentialId: "default",
        origin: "https://provider.example",
        auth: { type: "bearer" },
        secret: "multiline\nsecret",
      }),
    );
    await expect(vault.resolve(reference, binding)).rejects.toMatchObject({
      code: "VAULT_RECORD_INVALID",
    });
  });

  it("maps native failures to stable, redacted credential errors", async () => {
    const nativeMarker = "sk-native-message-must-not-leak";
    const cases = [
      [`secret service backend unavailable ${nativeMarker}`, "VAULT_BACKEND_UNAVAILABLE"],
      [`access denied ${nativeMarker}`, "VAULT_ACCESS_DENIED"],
      [`unexpected native failure ${nativeMarker}`, "VAULT_OPERATION_FAILED"],
    ] as const;
    for (const [message, code] of cases) {
      const error = await erroringVault(message)
        .status(reference, binding)
        .catch((caught: unknown) => caught);
      expect(error).toMatchObject({ code });
      expect(String(error)).not.toContain(nativeMarker);
    }
  });
});

describe("managed credentials and request-time resolution", () => {
  it("defaults raw SDK credentials to vault and only writes plaintext explicitly", async () => {
    const vault = fakeVault();
    const result = await upsertProviderWithCredential(
      createProfile({ rootDir: process.cwd() }),
      {
        id: "provider",
        baseUrl: "https://provider.example/v1",
        protocols: ["openai-chat-completions"],
        auth: { type: "bearer", credential: { secret: "sk-default-vault" } },
      },
      { vault },
    );
    expect(result.credentialRef).toBe(reference);
    expect(result.profile.providers[0]!.config.auth).toEqual({
      type: "bearer",
      secret: reference,
    });
    expect(result.warnings).toEqual([]);

    const plaintext = await upsertProviderWithCredential(
      createProfile({ rootDir: process.cwd() }),
      {
        id: "plain",
        baseUrl: "https://provider.example/v1",
        protocols: ["openai-chat-completions"],
        auth: {
          type: "bearer",
          credential: { storage: "plaintext", secret: "sk-explicit-plain" },
        },
      },
      { vault },
    );
    expect(plaintext.profile.providers[0]!.config.auth).toMatchObject({
      secret: "sk-explicit-plain",
    });
    expect(plaintext.warnings).toEqual([
      expect.objectContaining({ code: "PLAINTEXT_SECRET_IN_USE" }),
    ]);
  });

  it("validates the final provider before writing its Vault credential", async () => {
    const vault = fakeVault();
    await expect(upsertProviderWithCredential(
      createProfile({ rootDir: process.cwd() }),
      {
        id: "provider",
        baseUrl: "http://remote.example/v1",
        protocols: ["openai-chat-completions"],
        auth: { type: "bearer", credential: { secret: "sk-must-not-be-written" } },
      },
      { vault },
    )).rejects.toMatchObject({ name: "ProfileValidationError" });
    expect(FakeAsyncEntry.records.size).toBe(0);
  });

  it("rejects an unknown credential storage mode from untyped callers", async () => {
    const vault = fakeVault();
    await expect(upsertProviderWithCredential(
      createProfile({ rootDir: process.cwd() }),
      {
        id: "provider",
        baseUrl: "https://provider.example/v1",
        protocols: ["openai-chat-completions"],
        auth: {
          type: "bearer",
          credential: { storage: "file", secret: "must-not-be-written" },
        },
      } as never,
      { vault },
    )).rejects.toMatchObject({ code: "INVALID_SECRET_REFERENCE" });
    expect(FakeAsyncEntry.records.size).toBe(0);
  });

  it("selects without Vault I/O and resolves a rotated credential for every request", async () => {
    const vault = fakeVault();
    const profile = await vaultProfile(vault);
    const plan = selectConnection(profile, { providerId: "provider", model: "model" });
    expect(plan.auth).toEqual({ type: "bearer", secret: reference });
    expect(plan.credentialBinding).toEqual(binding);

    const authorizations: string[] = [];
    const client = createLappClient({
      profile,
      provider: "provider",
      model: "model",
      vault,
      fetchImpl: async (_input, init) => {
        authorizations.push(new Headers(init?.headers).get("authorization") ?? "");
        return new Response(JSON.stringify({
          choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
        }), { status: 200 });
      },
    });

    await client.chat({ messages: [{ role: "user", content: "one" }] });
    await vault.put(reference, "sk-vault-secret-two", binding, { overwrite: true });
    await client.chat({ messages: [{ role: "user", content: "two" }] });

    expect(authorizations).toEqual([
      "Bearer sk-vault-secret-one",
      "Bearer sk-vault-secret-two",
    ]);
  });

  it("freezes provider routing and binding at client creation while still resolving Vault rotation", async () => {
    const vault = fakeVault();
    const profile = await vaultProfile(vault);
    let requestUrl = "";
    let authorization = "";
    const client = createLappClient({
      profile,
      provider: "provider",
      model: "model",
      vault,
      fetchImpl: async (input, init) => {
        requestUrl = String(input);
        authorization = new Headers(init?.headers).get("authorization") ?? "";
        return new Response(JSON.stringify({
          choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
        }), { status: 200 });
      },
    });
    profile.providers[0]!.config.baseUrl = "https://attacker.example/v1";
    profile.providers[0]!.config.auth = { type: "none" };

    await client.chat({ messages: [{ role: "user", content: "hello" }] });

    expect(new URL(requestUrl).origin).toBe("https://provider.example");
    expect(authorization).toBe("Bearer sk-vault-secret-one");
  });

  it("does not fall back when Vault is missing or the provider binding changes", async () => {
    const vault = fakeVault();
    const profile = await vaultProfile(vault);
    await vault.delete(reference);
    let fetchCalls = 0;
    const missing = createLappClient({
      profile,
      provider: "provider",
      model: "model",
      vault,
      fetchImpl: async () => {
        fetchCalls++;
        return new Response("{}");
      },
    });
    await expect(missing.chat({ messages: [] })).rejects.toMatchObject({
      code: "VAULT_CREDENTIAL_NOT_FOUND",
    });
    expect(fetchCalls).toBe(0);

    await vault.put(reference, "sk-restored-secret", binding);
    const changed = structuredClone(profile);
    changed.providers[0]!.config.baseUrl = "https://attacker.example/v1";
    const rebound = createLappClient({
      profile: changed,
      provider: "provider",
      model: "model",
      vault,
      fetchImpl: async () => {
        fetchCalls++;
        return new Response("{}");
      },
    });
    await expect(rebound.chat({ messages: [] })).rejects.toMatchObject({
      code: "VAULT_BINDING_MISMATCH",
    });
    expect(fetchCalls).toBe(0);
  });

  it("reports status without resolving or exposing a credential", async () => {
    const vault = fakeVault();
    const profile = await vaultProfile(vault);
    const config = profile.providers[0]!.config;
    const expected = credentialBindingForProvider(config)!;
    const resolver = createCredentialResolver({ vault });
    await expect(resolver.status(reference, expected)).resolves.toEqual({
      scheme: "vault",
      available: true,
      bindingMatches: true,
    });
  });

  it("resolves Vault authentication immediately before model discovery", async () => {
    const vault = fakeVault();
    let profile = await vaultProfile(vault);
    profile = upsertProvider(profile, {
      id: "provider",
      modelDiscovery: {
        protocol: "openai-models",
        url: "https://provider.example/v1/models",
      },
    });
    let authorization = "";
    const result = await refreshModels(profile, "provider", {
      vault,
      fetch: async (_input, init) => {
        authorization = new Headers(init?.headers).get("authorization") ?? "";
        return new Response('{"data":[{"id":"remote-model"}]}', { status: 200 });
      },
    });
    expect(authorization).toBe("Bearer sk-vault-secret-one");
    expect(result.added.map((model) => model.modelId)).toEqual(["remote-model"]);
  });

  it("pins model discovery configuration and binding across an asynchronous resolver", async () => {
    const vault = fakeVault();
    let profile = await vaultProfile(vault);
    profile = upsertProvider(profile, {
      id: "provider",
      modelDiscovery: {
        protocol: "openai-models",
        url: "https://provider.example/v1/models",
      },
    });
    const originalProfile = profile;
    const resolver: CredentialResolver = {
      async resolve(_raw, resolverBinding) {
        originalProfile.providers[0]!.config.baseUrl = "https://attacker.example/v1";
        originalProfile.providers[0]!.config.modelDiscovery!.url = "https://attacker.example/models";
        resolverBinding.origin = "https://attacker.example";
        return "sk-vault-secret-one";
      },
      async status() {
        return { scheme: "vault", available: true, bindingMatches: true };
      },
    };
    let requestedUrl = "";

    const result = await refreshModels(profile, "provider", {
      resolver,
      fetch: async (input) => {
        requestedUrl = String(input);
        return new Response('{"data":[{"id":"remote-model"}]}', { status: 200 });
      },
    });

    expect(new URL(requestedUrl).origin).toBe("https://provider.example");
    expect(result.added.map((model) => model.modelId)).toEqual(["remote-model"]);
  });

  it("redacts an isolated surrogate credential without throwing a URI error", async () => {
    const vault = fakeVault();
    const secret = "\uD800";
    const result = await upsertProviderWithCredential(
      createProfile({ rootDir: process.cwd() }),
      {
        id: "provider",
        baseUrl: "https://provider.example/v1",
        protocols: ["openai-chat-completions"],
        models: [{ id: "model" }],
        auth: { type: "bearer", credential: { secret } },
      },
      { vault },
    );
    const client = createLappClient({
      profile: result.profile,
      provider: "provider",
      model: "model",
      vault,
      redactSuccessfulSecrets: true,
      fetchImpl: async () => new Response(JSON.stringify({
        choices: [{ message: { content: secret }, finish_reason: "stop" }],
      }), { status: 200 }),
    });

    await expect(client.chat({ messages: [] })).resolves.toMatchObject({ text: "<redacted>" });
  });

  it("rejects and redacts a Vault credential echoed by model discovery", async () => {
    const vault = fakeVault();
    let profile = await vaultProfile(vault);
    profile = upsertProvider(profile, {
      id: "provider",
      modelDiscovery: {
        protocol: "openai-models",
        url: "https://provider.example/v1/models",
      },
    });
    const secret = "sk-vault-secret-one";
    const error = await refreshModels(profile, "provider", {
      vault,
      fetch: async () => new Response(JSON.stringify({
        data: [{ id: secret, name: `echo ${secret}` }],
      }), { status: 200 }),
    }).catch((caught: unknown) => caught as Error & { code?: string });

    expect(error.code).toBe("INVALID_RESPONSE");
    expect(error.message).toBe("model discovery response contains credential data");
    expect(error.message).not.toContain(secret);
    expect(JSON.stringify(profile)).not.toContain(secret);
  });

  it("injects Vault credentials through header and query authentication", async () => {
    const vault = fakeVault();
    const cases = [
      {
        providerId: "header-provider",
        secret: "opaque/header value +47!",
        auth: {
          type: "header" as const,
          name: "X-Custom-Credential",
          credential: { secret: "opaque/header value +47!" },
        },
      },
      {
        providerId: "query-provider",
        secret: "opaque/query value +47!",
        auth: {
          type: "query" as const,
          name: "Api_Key",
          credential: { secret: "opaque/query value +47!" },
        },
      },
    ];

    for (const testCase of cases) {
      const result = await upsertProviderWithCredential(
        createProfile({ rootDir: process.cwd() }),
        {
          id: testCase.providerId,
          baseUrl: `https://${testCase.providerId}.example/v1`,
          protocols: ["openai-chat-completions"],
          models: [{ id: "model" }],
          auth: testCase.auth,
        },
        { vault },
      );
      const credentialRef = `vault://${testCase.providerId}/default`;
      expect(result.profile.providers[0]!.config.auth.secret).toBe(credentialRef);

      let requestUrl = "";
      let requestHeaders = new Headers();
      const client = createLappClient({
        profile: result.profile,
        provider: testCase.providerId,
        model: "model",
        vault,
        fetchImpl: async (input, init) => {
          requestUrl = String(input);
          requestHeaders = new Headers(init?.headers);
          return new Response(JSON.stringify({
            choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
          }), { status: 200 });
        },
      });

      await expect(client.chat({ messages: [] })).resolves.toMatchObject({ text: "ok" });
      if (testCase.auth.type === "header") {
        expect(requestHeaders.get(testCase.auth.name)).toBe(testCase.secret);
        expect(new URL(requestUrl).searchParams.has("Api_Key")).toBe(false);
      } else {
        expect(new URL(requestUrl).searchParams.get(testCase.auth.name)).toBe(testCase.secret);
        expect(requestHeaders.has("X-Custom-Credential")).toBe(false);
      }
    }
  });

  it("resolves a Vault credential for streams and redacts it from malformed SSE events", async () => {
    const vault = fakeVault();
    const secret = "opaque/stream value +47!";
    const result = await upsertProviderWithCredential(
      createProfile({ rootDir: process.cwd() }),
      {
        id: "provider",
        baseUrl: "https://provider.example/v1",
        protocols: ["openai-chat-completions"],
        models: [{ id: "model" }],
        auth: { type: "bearer", credential: { secret } },
      },
      { vault },
    );

    const authorizations: string[] = [];
    let requestNumber = 0;
    const client = createLappClient({
      profile: result.profile,
      provider: "provider",
      model: "model",
      vault,
      fetchImpl: async (_input, init) => {
        authorizations.push(new Headers(init?.headers).get("authorization") ?? "");
        requestNumber++;
        const data = requestNumber === 1
          ? JSON.stringify({
            choices: [{ delta: { content: "from-vault" }, finish_reason: "stop" }],
          })
          : `not-json ${secret}`;
        return new Response(`data: ${data}\n\n`, {
          headers: { "content-type": "text/event-stream" },
        });
      },
    });

    const successfulEvents = [];
    for await (const event of client.stream({ messages: [] })) successfulEvents.push(event);
    expect(successfulEvents).toEqual([
      { kind: "delta", text: "from-vault" },
      { kind: "finish", reason: "stop" },
    ]);

    const malformedEvents = [];
    for await (const event of client.stream({ messages: [] })) malformedEvents.push(event);
    expect(malformedEvents).toEqual([{
      kind: "error",
      message: "invalid JSON in stream: not-json <redacted>",
    }]);
    expect(JSON.stringify(malformedEvents)).not.toContain(secret);
    expect(authorizations).toEqual([`Bearer ${secret}`, `Bearer ${secret}`]);
  });

  it("can redact an echoed Vault credential from successful chat, raw, and stream results", async () => {
    const vault = fakeVault();
    const secret = "opaque/success value +47!";
    const result = await upsertProviderWithCredential(
      createProfile({ rootDir: process.cwd() }),
      {
        id: "provider",
        baseUrl: "https://provider.example/v1",
        protocols: ["openai-chat-completions"],
        models: [{ id: "model" }],
        auth: { type: "bearer", credential: { secret } },
      },
      { vault },
    );
    const client = createLappClient({
      profile: result.profile,
      provider: "provider",
      model: "model",
      vault,
      redactSuccessfulSecrets: true,
      fetchImpl: async (_input, init) => {
        const request = JSON.parse(String(init?.body ?? "{}")) as { stream?: boolean };
        if (request.stream) {
          return new Response(
            `data: ${JSON.stringify({ choices: [{ delta: { content: secret }, finish_reason: "stop" }] })}\n\n`,
            { headers: { "content-type": "text/event-stream" } },
          );
        }
        return new Response(JSON.stringify({
          choices: [{ message: { content: secret }, finish_reason: "stop" }],
          echoed: { [secret]: secret },
        }), { status: 200 });
      },
    });

    const chat = await client.chat({ messages: [] });
    expect(chat.text).toBe("<redacted>");
    expect(JSON.stringify(chat)).not.toContain(secret);
    const raw = await client.rawChat({ messages: [] });
    expect(JSON.stringify(raw)).not.toContain(secret);
    expect(JSON.stringify(raw)).toContain("<redacted>");
    const events = [];
    for await (const event of client.stream({ messages: [] })) events.push(event);
    expect(JSON.stringify(events)).not.toContain(secret);
    expect(events).toContainEqual({ kind: "delta", text: "<redacted>" });
  });

  it("redacts a resolved Vault credential from HTTP and raw fetch errors", async () => {
    const vault = fakeVault();
    const secret = "opaque/error value +47!";
    const result = await upsertProviderWithCredential(
      createProfile({ rootDir: process.cwd() }),
      {
        id: "provider",
        baseUrl: "https://provider.example/v1",
        protocols: ["openai-chat-completions"],
        models: [{ id: "model" }],
        auth: {
          type: "header",
          name: "X-Credential",
          credential: { secret },
        },
      },
      { vault },
    );

    let requestNumber = 0;
    const client = createLappClient({
      profile: result.profile,
      provider: "provider",
      model: "model",
      vault,
      fetchImpl: async () => {
        requestNumber++;
        if (requestNumber === 1) {
          return new Response(JSON.stringify({
            error: `provider echoed ${secret}`,
            [secret]: { credential: secret },
          }), { status: 401 });
        }
        throw Object.assign(new Error(`network failed for ${secret}`), {
          raw: { [secret]: secret },
        });
      },
    });

    const httpError = await client.chat({ messages: [] })
      .catch((caught: unknown) => caught as Error & { raw?: unknown });
    expect(httpError.message).not.toContain(secret);
    expect(JSON.stringify(httpError.raw)).not.toContain(secret);
    expect(httpError.message).toContain("<redacted>");
    expect(JSON.stringify(httpError.raw)).toContain("<redacted>");

    const fetchError = await client.rawChat({ messages: [] })
      .catch((caught: unknown) => caught as Error & { raw?: unknown });
    expect(fetchError.message).not.toContain(secret);
    expect(JSON.stringify(fetchError.raw)).not.toContain(secret);
    expect(fetchError.message).toContain("<redacted>");
    expect(JSON.stringify(fetchError.raw)).toContain("<redacted>");
  });
});
