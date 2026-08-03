import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AuthError,
  AuthDriverRegistry,
  computeRegistryRevision,
  createProfile,
  createMemoryAuthTokenStore,
  createRegistryClient,
  computeAuthConfigDigest,
  readRegistryStable,
  upsertAuthSource,
  withAuthIdLock,
  writeProfileAtomic,
  type AuthEnvelopeV1,
  type LappProfile,
  type LappStreamEventUnion,
} from "../src/index.js";

const roots: string[] = [];

function lockHome(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lapp-auth-client-"));
  roots.push(directory);
  return directory;
}

function profile(
  id: string,
  driver: "xai-grok" | "openai-codex",
  model: string,
): LappProfile {
  return {
    providers: [],
    auth: [{
      config: {
        schemaVersion: "1.1",
        id,
        driver,
        protocols: [driver === "xai-grok" ? "openai-chat-completions" : "openai-responses"],
        config: driver === "xai-grok"
          ? {
            clientId: "xai-test-client",
            scope: "openid profile",
            discoveryUrl: "https://auth.mock.invalid/.well-known/openid-configuration",
            deviceCodeUrl: "https://auth.mock.invalid/oauth2/device/code",
            inferenceBaseUrl: "https://api.mock.invalid/v1",
          }
          : {
            clientId: "codex-test-client",
            issuer: "https://auth.mock.invalid",
            inferenceBaseUrl: "https://codex.mock.invalid/backend-api/codex",
          },
      },
      models: { schemaVersion: "1.0", models: [{ id: model }] },
    }],
  };
}

function responsesSse(text = "hello"): Response {
  return new Response([
    `data: ${JSON.stringify({ type: "response.output_text.delta", delta: text })}\n\n`,
    `data: ${JSON.stringify({
      type: "response.completed",
      response: { status: "completed", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
    })}\n\n`,
  ].join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
}

function chatSse(text = "hello"): Response {
  return new Response([
    `data: ${JSON.stringify({
      choices: [{ delta: { content: text } }],
    })}\n\n`,
    `data: ${JSON.stringify({
      choices: [{
        delta: {
          tool_calls: [{ index: 0, id: "call_1", function: { name: "lookup", arguments: '{"q":"x' } }],
        },
      }],
    })}\n\n`,
    `data: ${JSON.stringify({
      choices: [{
        delta: {
          tool_calls: [{ index: 0, function: { arguments: '"}' } }],
        },
        finish_reason: "tool_calls",
      }],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    })}\n\n`,
    "data: [DONE]\n\n",
  ].join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
}

async function events(iterable: AsyncIterable<LappStreamEventUnion>): Promise<LappStreamEventUnion[]> {
  const result: LappStreamEventUnion[] = [];
  for await (const event of iterable) result.push(event);
  return result;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("direct Auth subscription clients", () => {
  it("returns an xAI device-login proposal without reading another application's CLI state", async () => {
    const grokProfile = profile("grok-main", "xai-grok", "grok-build-0.1");
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith("/.well-known/openid-configuration")) {
        return new Response(JSON.stringify({ token_endpoint: "https://auth.mock.invalid/oauth/token" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      expect(url).toBe("https://auth.mock.invalid/oauth2/device/code");
      return new Response(JSON.stringify({
        device_code: "device-secret",
        user_code: "ABCD-EFGH",
        verification_uri: "https://auth.mock.invalid/activate",
        verification_uri_complete: "https://auth.mock.invalid/activate?code=ABCD-EFGH",
        expires_in: 600,
        interval: 5,
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const store = createMemoryAuthTokenStore();
    const client = createRegistryClient({
      profile: grokProfile,
      target: { authId: "grok-main", modelId: "grok-build-0.1" },
      tokenStore: store,
      fetchImpl,
      authLock: { stateHome: lockHome() },
    });
    const proposal = await client.proposeLogin();
    expect(proposal).toMatchObject({
      userCode: "ABCD-EFGH",
      verificationUri: "https://auth.mock.invalid/activate?code=ABCD-EFGH",
      intervalMs: 5_000,
    });
    expect(await client.status()).toEqual({ authId: "grok-main", exists: false });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("fails closed when endpoint/client configuration was not explicitly authorized", async () => {
    const unconfigured: LappProfile = {
      providers: [],
      auth: [{
        config: {
          schemaVersion: "1.1",
          id: "codex-main",
          driver: "openai-codex",
          protocols: ["openai-responses"],
        },
        models: { schemaVersion: "1.0", models: [{ id: "gpt-5-codex" }] },
      }],
    };
    const fetchImpl = vi.fn<typeof fetch>();
    const client = createRegistryClient({
      profile: unconfigured,
      target: { authId: "codex-main", modelId: "gpt-5-codex" },
      tokenStore: createMemoryAuthTokenStore(),
      fetchImpl,
      authLock: { stateHome: lockHome() },
    });
    await expect(client.proposeLogin()).rejects.toMatchObject<AuthError>({
      code: "AUTH_DRIVER_NOT_SUPPORTED",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses to use a grant after auth.json changes", async () => {
    const codexProfile = profile("codex-main", "openai-codex", "gpt-5-codex");
    const client = createRegistryClient({
      profile: codexProfile,
      target: { authId: "codex-main", modelId: "gpt-5-codex" },
      tokenStore: createMemoryAuthTokenStore([{
        version: 1,
        authId: "codex-main",
        driver: "openai-codex",
        configDigest: `sha256:${"f".repeat(64)}`,
        generation: 1,
        credentials: { accessToken: "must-not-send", accountId: "acct_123" },
      }]),
      fetchImpl: vi.fn<typeof fetch>(),
      authLock: { stateHome: lockHome() },
    });
    await expect(client.status()).rejects.toMatchObject<AuthError>({ code: "AUTH_CONFIG_CHANGED" });
  });

  it("refreshes xAI OAuth and streams direct Chat Completions messages/tools", async () => {
    const grokProfile = profile("grok-main", "xai-grok", "grok-build-0.1");
    const old: AuthEnvelopeV1 = {
      version: 1,
      authId: "grok-main",
      driver: "xai-grok",
      configDigest: computeAuthConfigDigest(grokProfile.auth![0]!.config),
      generation: 1,
      credentials: {
        accessToken: "old-access",
        refreshToken: "old-refresh",
        expiresAt: "2000-01-01T00:00:00.000Z",
        tokenEndpoint: "https://auth.mock.invalid/oauth/token",
      },
    };
    const store = createMemoryAuthTokenStore([old]);
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url === "https://auth.mock.invalid/oauth/token") {
        expect(String(init?.body)).toContain("refresh_token=old-refresh");
        return new Response(JSON.stringify({
          access_token: "new-access",
          refresh_token: "new-refresh",
          expires_in: 3600,
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      expect(url).toBe("https://api.mock.invalid/v1/chat/completions");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer new-access");
      expect(JSON.parse(String(init?.body))).toMatchObject({
        model: "grok-build-0.1",
        stream: true,
        messages: [{ role: "user", content: "hi" }],
        tools: [{ type: "function", function: { name: "lookup" } }],
      });
      return chatSse("grok");
    });
    const client = createRegistryClient({
      profile: grokProfile,
      target: { authId: "grok-main", modelId: "grok-build-0.1" },
      tokenStore: store,
      fetchImpl,
      authLock: { stateHome: lockHome() },
    });
    expect(await events(client.stream({
      messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "lookup", parameters: { type: "object" } }],
    }))).toEqual(expect.arrayContaining([
      { kind: "delta", text: "grok" },
      { kind: "tool-call", id: "call_1", name: "lookup", arguments: "{\"q\":\"x\"}" },
      { kind: "usage", inputTokens: 1, outputTokens: 2, totalTokens: 3 },
      { kind: "finish", reason: "tool_calls" },
    ]));
    expect((await store.read("grok-main"))?.credentials.refreshToken).toBe("new-refresh");
    expect((await store.read("grok-main"))?.generation).toBe(2);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(await client.status()).toMatchObject({ exists: true, driver: "xai-grok" });
    expect(await client.logout()).toBe(true);
    expect(await client.status()).toEqual({ authId: "grok-main", exists: false });
  });

  it("cancels an active device-code poll without storing a token", async () => {
    const grokProfile = profile("grok-main", "xai-grok", "grok-build-0.1");
    const store = createMemoryAuthTokenStore();
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith("/.well-known/openid-configuration")) {
        return new Response(JSON.stringify({ token_endpoint: "https://auth.mock.invalid/oauth/token" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/oauth2/device/code")) {
        return new Response(JSON.stringify({
          device_code: "device-secret",
          user_code: "ABCD-EFGH",
          verification_uri: "https://auth.mock.invalid/activate",
          expires_in: 600,
          interval: 5,
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request: ${url}`);
    });
    const client = createRegistryClient({
      profile: grokProfile,
      target: { authId: "grok-main", modelId: "grok-build-0.1" },
      tokenStore: store,
      fetchImpl,
      authLock: { stateHome: lockHome() },
    });
    const challenge = await client.loginStart();
    const polling = client.loginPoll(challenge);
    expect(client.loginCancel(challenge)).toBe(true);
    await expect(polling).rejects.toMatchObject({ name: "AbortError" });
    expect(client.loginCancel(challenge)).toBe(false);
    expect(await store.read("grok-main")).toBeUndefined();
  });

  it("returns Auth model discovery as a merge-only proposal and applies it only with explicit registry CAS", async () => {
    const profileRoot = lockHome();
    const before = upsertAuthSource(createProfile({ rootDir: profileRoot }), {
      id: "grok-main",
      driver: "xai-grok",
      protocols: ["openai-chat-completions"],
      config: {
        clientId: "xai-test-client",
        scope: "openid profile",
        discoveryUrl: "https://auth.mock.invalid/.well-known/openid-configuration",
        deviceCodeUrl: "https://auth.mock.invalid/oauth2/device/code",
        inferenceBaseUrl: "https://api.mock.invalid/v1",
        modelsUrl: "https://api.mock.invalid/v1/models",
      },
      models: [{ id: "existing" }],
    });
    before.global = { schemaVersion: "1.1", defaults: {} };
    await writeProfileAtomic(before, { path: profileRoot, before: null });
    const store = createMemoryAuthTokenStore([{
      version: 1,
      authId: "grok-main",
      driver: "xai-grok",
      configDigest: computeAuthConfigDigest(before.auth![0]!.config),
      generation: 1,
      credentials: { accessToken: "model-list-secret", expiresAt: "2099-01-01T00:00:00.000Z" },
    }]);
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe("https://api.mock.invalid/v1/models");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer model-list-secret");
      return new Response(JSON.stringify({
        data: [{ id: "z-new", name: "Z New" }, { id: "existing", name: "Filled Existing Name" }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const client = createRegistryClient({
      profile: before,
      target: { authId: "grok-main", modelId: "existing" },
      tokenStore: store,
      fetchImpl,
      authLock: { stateHome: lockHome() },
    });
    const expectedRevision = computeRegistryRevision(profileRoot);
    const writerStateHome = lockHome();
    const proposal = await client.refreshAuthModels();
    expect(proposal.added).toContainEqual(expect.objectContaining({ authId: "grok-main", modelId: "z-new" }));
    expect(proposal.nextProfile.auth![0]!.models.models).toEqual([
      { id: "existing", name: "Filled Existing Name" },
      { id: "z-new", name: "Z New" },
    ]);
    expect(computeRegistryRevision(profileRoot)).toBe(expectedRevision);
    await expect(proposal.apply({
      expectedRevision: `sha256:${"0".repeat(64)}`,
      lock: { stateHome: writerStateHome },
    }))
      .rejects.toMatchObject({ code: "PROFILE_CONFLICT" });
    expect(computeRegistryRevision(profileRoot)).toBe(expectedRevision);
    const applied = await proposal.apply({ expectedRevision, lock: { stateHome: writerStateHome } });
    expect(applied.profileChanged).toBe(true);
    expect(readRegistryStable({ path: profileRoot }).value.auth![0]!.models.models)
      .toContainEqual({ id: "z-new", name: "Z New" });
  });

  it("uses Codex subscription headers/body and refreshes once after a pre-stream 401", async () => {
    const codexProfile = profile("codex-main", "openai-codex", "gpt-5-codex");
    const store = createMemoryAuthTokenStore([{
      version: 1,
      authId: "codex-main",
      driver: "openai-codex",
      configDigest: computeAuthConfigDigest(codexProfile.auth![0]!.config),
      generation: 1,
      credentials: {
        accessToken: "old-codex-access",
        refreshToken: "old-codex-refresh",
        accountId: "acct_123",
        expiresAt: "2099-01-01T00:00:00.000Z",
      },
    }]);
    let inferenceCalls = 0;
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url === "https://auth.mock.invalid/oauth/token") {
        expect(init?.headers).toMatchObject({ "content-type": "application/json" });
        expect(JSON.parse(String(init?.body))).toMatchObject({
          grant_type: "refresh_token",
          refresh_token: "old-codex-refresh",
        });
        return new Response(JSON.stringify({
          access_token: "new-codex-access",
          refresh_token: "rotated-codex-refresh",
          expires_in: 3600,
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      expect(url).toBe("https://codex.mock.invalid/backend-api/codex/responses");
      inferenceCalls += 1;
      if (inferenceCalls === 1) return new Response("unauthorized", { status: 401 });
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer new-codex-access");
      expect(headers.get("chatgpt-account-id")).toBe("acct_123");
      expect(headers.get("originator")).toBe("openlapp");
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body).toMatchObject({ model: "gpt-5-codex", stream: true, store: false });
      expect(body.include).toContain("reasoning.encrypted_content");
      return responsesSse("codex");
    });
    const client = createRegistryClient({
      profile: codexProfile,
      target: { authId: "codex-main", modelId: "gpt-5-codex" },
      tokenStore: store,
      fetchImpl,
      authLock: { stateHome: lockHome() },
    });
    const response = await client.chat({ messages: [{ role: "user", content: "hi" }] });
    expect(response.text).toBe("codex");
    expect(inferenceCalls).toBe(2);
    expect((await store.read("codex-main"))?.credentials.refreshToken).toBe("rotated-codex-refresh");
    expect((await store.read("codex-main"))?.generation).toBe(2);
  });

  it("does not retry an Auth 401 after stream output has been yielded", async () => {
    const grokProfile = profile("grok-main", "xai-grok", "grok-build-0.1");
    const stored: AuthEnvelopeV1 = {
      version: 1,
      authId: "grok-main",
      driver: "xai-grok",
      configDigest: computeAuthConfigDigest(grokProfile.auth![0]!.config),
      generation: 1,
      credentials: {
        accessToken: "current-access",
        refreshToken: "refresh-must-not-run",
        expiresAt: "2099-01-01T00:00:00.000Z",
      },
    };
    let streamCalls = 0;
    let refreshCalls = 0;
    const drivers = new AuthDriverRegistry([{
      id: "xai-grok",
      async proposeLogin() { throw new Error("not used"); },
      async refresh() { refreshCalls += 1; throw new Error("must not refresh"); },
      async send() { throw new Error("not used"); },
      async *stream() {
        streamCalls += 1;
        yield { kind: "delta" as const, text: "already-emitted" };
        throw new AuthError("AUTH_HTTP_ERROR", "late unauthorized", 401);
      },
    }]);
    const client = createRegistryClient({
      profile: grokProfile,
      target: { authId: "grok-main", modelId: "grok-build-0.1" },
      tokenStore: createMemoryAuthTokenStore([stored]),
      drivers,
      authLock: { stateHome: lockHome() },
    });
    const seen: LappStreamEventUnion[] = [];
    await expect((async () => {
      for await (const event of client.stream({ messages: [{ role: "user", content: "hi" }] })) seen.push(event);
    })()).rejects.toMatchObject({ code: "AUTH_HTTP_ERROR", status: 401 });
    expect(seen).toEqual([{ kind: "delta", text: "already-emitted" }]);
    expect(streamCalls).toBe(1);
    expect(refreshCalls).toBe(0);
  });

  it("keeps only the latest concurrent loginStart proposal when completions arrive in reverse order", async () => {
    const grokProfile = profile("grok-main", "xai-grok", "grok-build-0.1");
    const digest = computeAuthConfigDigest(grokProfile.auth![0]!.config);
    let resolveFirst!: (proposal: import("../src/index.js").AuthLoginProposal) => void;
    let resolveSecond!: (proposal: import("../src/index.js").AuthLoginProposal) => void;
    const first = new Promise<import("../src/index.js").AuthLoginProposal>((resolve) => { resolveFirst = resolve; });
    const second = new Promise<import("../src/index.js").AuthLoginProposal>((resolve) => { resolveSecond = resolve; });
    const proposal = (accessToken: string): import("../src/index.js").AuthLoginProposal => ({
      verificationUri: "https://auth.mock.invalid/activate",
      userCode: accessToken,
      expiresAt: "2099-01-01T00:00:00.000Z",
      intervalMs: 1,
      async complete() {
        return {
          version: 1,
          authId: "grok-main",
          driver: "xai-grok",
          configDigest: digest,
          generation: 1,
          credentials: { accessToken, expiresAt: "2099-01-01T00:00:00.000Z" },
        };
      },
    });
    let startCalls = 0;
    const drivers = new AuthDriverRegistry([{
      id: "xai-grok",
      async proposeLogin() { return (startCalls++ === 0 ? first : second); },
      async refresh() { throw new Error("not used"); },
      async send() { throw new Error("not used"); },
      async *stream() { throw new Error("not used"); },
    }]);
    const store = createMemoryAuthTokenStore();
    const client = createRegistryClient({
      profile: grokProfile,
      target: { authId: "grok-main", modelId: "grok-build-0.1" },
      tokenStore: store,
      drivers,
      authLock: { stateHome: lockHome() },
    });
    const olderStart = client.loginStart();
    const newerStart = client.loginStart();
    resolveSecond(proposal("newest-access"));
    const newest = await newerStart;
    resolveFirst(proposal("stale-access"));
    await expect(olderStart).rejects.toMatchObject({ name: "AbortError" });
    await expect(client.loginPoll(newest)).resolves.toMatchObject({ exists: true });
    expect((await store.read("grok-main"))?.credentials.accessToken).toBe("newest-access");
    expect(startCalls).toBe(2);
  });

  it("cancels an in-flight loginStart before it can register a challenge or write the store", async () => {
    const grokProfile = profile("grok-main", "xai-grok", "grok-build-0.1");
    let resolveProposal!: (proposal: import("../src/index.js").AuthLoginProposal) => void;
    const delayed = new Promise<import("../src/index.js").AuthLoginProposal>((resolve) => { resolveProposal = resolve; });
    const drivers = new AuthDriverRegistry([{
      id: "xai-grok",
      async proposeLogin() { return delayed; },
      async refresh() { throw new Error("not used"); },
      async send() { throw new Error("not used"); },
      async *stream() { throw new Error("not used"); },
    }]);
    const store = createMemoryAuthTokenStore();
    const client = createRegistryClient({
      profile: grokProfile,
      target: { authId: "grok-main", modelId: "grok-build-0.1" },
      tokenStore: store,
      drivers,
      authLock: { stateHome: lockHome() },
    });
    const start = client.loginStart();
    expect(client.loginCancel()).toBe(true);
    resolveProposal({
      verificationUri: "https://auth.mock.invalid/activate",
      expiresAt: "2099-01-01T00:00:00.000Z",
      intervalMs: 1,
      async complete() { throw new Error("must not poll"); },
    });
    await expect(start).rejects.toMatchObject({ name: "AbortError" });
    expect(await store.read("grok-main")).toBeUndefined();
  });

  it("logout invalidates an in-flight loginStart before it can register a challenge", async () => {
    const grokProfile = profile("grok-main", "xai-grok", "grok-build-0.1");
    let resolveProposal!: (proposal: import("../src/index.js").AuthLoginProposal) => void;
    const delayed = new Promise<import("../src/index.js").AuthLoginProposal>((resolve) => { resolveProposal = resolve; });
    const drivers = new AuthDriverRegistry([{
      id: "xai-grok",
      async proposeLogin() { return delayed; },
      async refresh() { throw new Error("not used"); },
      async send() { throw new Error("not used"); },
      async *stream() { throw new Error("not used"); },
    }]);
    const store = createMemoryAuthTokenStore();
    const client = createRegistryClient({
      profile: grokProfile,
      target: { authId: "grok-main", modelId: "grok-build-0.1" },
      tokenStore: store,
      drivers,
      authLock: { stateHome: lockHome() },
    });
    const start = client.loginStart();
    expect(await client.logout()).toBe(false);
    expect(client.loginCancel()).toBe(false);
    resolveProposal({
      verificationUri: "https://auth.mock.invalid/activate",
      expiresAt: "2099-01-01T00:00:00.000Z",
      intervalMs: 1,
      async complete() { throw new Error("must not poll"); },
    });
    await expect(start).rejects.toMatchObject({ name: "AbortError" });
    expect(await client.status()).toEqual({ authId: "grok-main", exists: false });
    expect(await store.read("grok-main")).toBeUndefined();
  });

  it("logout cancels a blocked login commit and leaves the auth source logged out", async () => {
    const grokProfile = profile("grok-main", "xai-grok", "grok-build-0.1");
    const digest = computeAuthConfigDigest(grokProfile.auth![0]!.config);
    const stateHome = lockHome();
    let releaseLock!: () => void;
    let enteredLock!: () => void;
    let exchangeComplete!: () => void;
    const lockGate = new Promise<void>((resolve) => { releaseLock = resolve; });
    const lockEntered = new Promise<void>((resolve) => { enteredLock = resolve; });
    const exchanged = new Promise<void>((resolve) => { exchangeComplete = resolve; });
    const heldLock = withAuthIdLock("grok-main", async () => {
      enteredLock();
      await lockGate;
    }, { stateHome, retryDelayMs: 1 });
    await lockEntered;
    const drivers = new AuthDriverRegistry([{
      id: "xai-grok",
      async proposeLogin() {
        return {
          verificationUri: "https://auth.mock.invalid/activate",
          expiresAt: "2099-01-01T00:00:00.000Z",
          intervalMs: 1,
          async complete() {
            exchangeComplete();
            return {
              version: 1,
              authId: "grok-main",
              driver: "xai-grok",
              configDigest: digest,
              generation: 1,
              credentials: { accessToken: "would-be-logged-out", expiresAt: "2099-01-01T00:00:00.000Z" },
            };
          },
        };
      },
      async refresh() { throw new Error("not used"); },
      async send() { throw new Error("not used"); },
      async *stream() { throw new Error("not used"); },
    }]);
    const store = createMemoryAuthTokenStore();
    const client = createRegistryClient({
      profile: grokProfile,
      target: { authId: "grok-main", modelId: "grok-build-0.1" },
      tokenStore: store,
      drivers,
      authLock: { stateHome, retryDelayMs: 1 },
    });
    const challenge = await client.loginStart();
    const mkdirSpy = vi.spyOn(fs, "mkdirSync");
    const poll = client.loginPoll(challenge);
    await exchanged;
    await vi.waitFor(() => expect(mkdirSpy).toHaveBeenCalled());
    const logout = client.logout();
    releaseLock();
    await heldLock;
    await expect(poll).rejects.toMatchObject({ name: "AbortError" });
    expect(await logout).toBe(false);
    expect(await client.status()).toEqual({ authId: "grok-main", exists: false });
    await expect(client.refresh()).rejects.toMatchObject<AuthError>({ code: "AUTH_LOGIN_REQUIRED" });
    expect(await store.read("grok-main")).toBeUndefined();
    await expect(client.loginPoll(challenge)).rejects.toMatchObject<AuthError>({ code: "AUTH_OPERATION_FAILED" });
  });
});
