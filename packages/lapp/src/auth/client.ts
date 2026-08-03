import { createLappClient, type LappClient, type TestConnectionResult } from "../client/index.js";
import type { ChatInput, LappResponse, LappStreamEventUnion } from "../client/adapter.js";
import { listModelTargets, resolveModelTarget } from "../connection.js";
import { copyProfileRoot, profileRoot } from "../profile-location.js";
import { commitRegistryTransaction } from "../manager/transaction.js";
import { computeRegistryRevision } from "../manager/revision.js";
import type { WriterLockOptions } from "../writer/lock.js";
import { isValidModelId } from "../validate/constants.js";
import { validateProfile } from "../validate/index.js";
import {
  AuthError,
  type AuthModelDescriptor,
  type AuthEnvelopeV1,
  type AuthTokenStatus,
  type AuthTokenStore,
  type CredentialResolver,
  type CredentialVault,
  type Diagnostic,
  type LappProfile,
  type RegistryModelRef,
} from "../types.js";
import { AuthDriverRegistry, collectAuthStream, computeAuthConfigDigest, type AuthDriverContext, type AuthLoginProposal, type AuthLoginVerification } from "./driver.js";
import { openaiCodexAuthDriver } from "./drivers/openai-codex.js";
import { xaiGrokAuthDriver } from "./drivers/xai-grok.js";
import { credentialString } from "./drivers/shared.js";
import { withAuthIdLock, type AuthIdLockOptions } from "./lock.js";
import { openSystemAuthTokenStore } from "./store.js";

export interface CreateRegistryClientOptions {
  profile: LappProfile;
  target?: RegistryModelRef;
  default?: string;
  tokenStore?: AuthTokenStore;
  drivers?: AuthDriverRegistry;
  authLock?: AuthIdLockOptions;
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
  vault?: CredentialVault;
  resolver?: CredentialResolver;
  redactSuccessfulSecrets?: boolean;
}

export interface AuthLoginOptions {
  signal?: AbortSignal;
  onVerification?: (verification: AuthLoginVerification) => void | Promise<void>;
}

/** A redacted, in-process handle for one device-login attempt. */
export interface AuthLoginChallenge extends AuthLoginVerification {
  /** Opaque client-local identifier. It is not an OAuth device code or token. */
  readonly id: string;
}

export interface AuthModelsRefreshApplyOptions {
  /** Required registry-v2 revision captured when the user approves this proposal. */
  expectedRevision: string;
  /** Required when the profile was constructed in memory rather than loaded from disk. */
  rootDir?: string;
  /** Test/embedding override for the registry writer lock state home. */
  lock?: WriterLockOptions;
}

export interface AuthModelsRefreshApplyResult {
  profile: LappProfile;
  revision: string;
  profileChanged: boolean;
}

/** Read-only Auth model-catalog proposal. It never writes registry files until `apply`. */
export interface AuthModelsRefreshProposal {
  authId: string;
  nextProfile: LappProfile;
  added: AuthModelDescriptor[];
  diagnostics: Diagnostic[];
  apply(options: AuthModelsRefreshApplyOptions): Promise<AuthModelsRefreshApplyResult>;
}

export interface RegistryClient {
  readonly source: "provider" | "auth";
  readonly sourceId: string;
  readonly model: string;
  readonly protocol: string;
  chat(input: ChatInput): Promise<LappResponse>;
  rawChat(input: ChatInput): Promise<unknown>;
  stream(input: ChatInput): AsyncIterable<LappStreamEventUnion>;
  testConnection(): Promise<TestConnectionResult>;
  proposeLogin(options?: { signal?: AbortSignal }): Promise<AuthLoginProposal>;
  loginStart(options?: { signal?: AbortSignal }): Promise<AuthLoginChallenge>;
  loginPoll(challenge: AuthLoginChallenge, options?: { signal?: AbortSignal }): Promise<AuthTokenStatus>;
  loginCancel(challenge?: AuthLoginChallenge): boolean;
  login(options?: AuthLoginOptions): Promise<AuthTokenStatus>;
  status(options?: { signal?: AbortSignal }): Promise<AuthTokenStatus>;
  logout(options?: { signal?: AbortSignal }): Promise<boolean>;
  refresh(options?: { signal?: AbortSignal }): Promise<AuthTokenStatus>;
  refreshAuthModels(options?: { signal?: AbortSignal }): Promise<AuthModelsRefreshProposal>;
}

export function createBuiltinAuthDriverRegistry(): AuthDriverRegistry {
  return new AuthDriverRegistry([xaiGrokAuthDriver, openaiCodexAuthDriver]);
}

function providerRegistryClient(client: LappClient): RegistryClient {
  const unsupported = async (): Promise<never> => {
    throw new AuthError("AUTH_OPERATION_UNSUPPORTED", "provider targets do not support Auth session operations");
  };
  return {
    source: "provider",
    sourceId: client.providerId,
    model: client.model,
    protocol: client.protocol,
    chat: (input) => client.chat(input),
    rawChat: (input) => client.rawChat(input),
    stream: (input) => client.stream(input),
    testConnection: () => client.testConnection(),
    proposeLogin: unsupported,
    loginStart: unsupported,
    loginPoll: unsupported,
    loginCancel: () => false,
    login: unsupported,
    status: unsupported,
    logout: unsupported,
    refresh: unsupported,
    refreshAuthModels: unsupported,
  };
}

interface PendingLogin {
  controller: AbortController;
  epoch: number;
  proposal?: AuthLoginProposal;
  polling?: Promise<AuthTokenStatus>;
}

function combinedAbortSignal(
  first: AbortSignal | undefined,
  second: AbortSignal | undefined,
): { signal: AbortSignal | undefined; dispose(): void } {
  if (!first) return { signal: second, dispose() {} };
  if (!second || first === second) return { signal: first, dispose() {} };
  const controller = new AbortController();
  const forward = (signal: AbortSignal) => () => controller.abort(signal.reason);
  const firstAbort = forward(first);
  const secondAbort = forward(second);
  if (first.aborted) firstAbort();
  else first.addEventListener("abort", firstAbort, { once: true });
  if (second.aborted) secondAbort();
  else second.addEventListener("abort", secondAbort, { once: true });
  return {
    signal: controller.signal,
    dispose() {
      first.removeEventListener("abort", firstAbort);
      second.removeEventListener("abort", secondAbort);
    },
  };
}

function configuredModelsUrl(context: AuthDriverContext): string {
  const value = context.config.modelsUrl;
  if (typeof value !== "string") {
    throw new AuthError("AUTH_DRIVER_NOT_SUPPORTED", "auth model discovery is not configured");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AuthError("AUTH_DRIVER_NOT_SUPPORTED", "auth model discovery URL is invalid");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new AuthError("AUTH_DRIVER_NOT_SUPPORTED", "auth model discovery URL must be HTTPS without credentials or fragment");
  }
  return url.toString();
}

function containsSensitiveValue(value: string | undefined, sensitive: string): boolean {
  if (!value || !sensitive) return false;
  const encoded = new Set([sensitive]);
  try { encoded.add(encodeURIComponent(sensitive)); } catch { /* literal remains protected */ }
  try { encoded.add(new URLSearchParams({ value: sensitive }).toString().slice("value=".length)); } catch { /* literal remains protected */ }
  return [...encoded].some((candidate) => candidate.length > 0 && value.includes(candidate));
}

/** Create one client that can target either a provider credential or an Auth subscription. */
export function createRegistryClient(options: CreateRegistryClientOptions): RegistryClient {
  if (options.target !== undefined && options.default !== undefined) {
    throw new TypeError("target cannot be combined with default");
  }
  const selector = options.target ?? { default: options.default ?? "chat" };
  const resolved = resolveModelTarget(options.profile, selector);
  if (resolved.source === "provider") {
    return providerRegistryClient(createLappClient({
      profile: options.profile,
      provider: resolved.ref.providerId,
      model: resolved.ref.modelId,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      ...(options.env ? { env: options.env } : {}),
      ...(options.vault ? { vault: options.vault } : {}),
      ...(options.resolver ? { resolver: options.resolver } : {}),
      ...(options.redactSuccessfulSecrets !== undefined
        ? { redactSuccessfulSecrets: options.redactSuccessfulSecrets }
        : {}),
    }));
  }

  const authTarget = resolved;
  const source = options.profile.auth?.find((entry) => entry.config.id === authTarget.authId);
  if (!source) throw new AuthError("AUTH_NOT_FOUND", `auth source not found: ${authTarget.authId}`);
  const configDigest = computeAuthConfigDigest(source.config);
  const drivers = options.drivers ?? createBuiltinAuthDriverRegistry();
  const driver = drivers.get(authTarget.driver);
  const context: AuthDriverContext = {
    source,
    modelId: authTarget.modelId,
    protocol: authTarget.protocol,
    config: authTarget.config,
    fetchImpl: options.fetchImpl ?? globalThis.fetch,
  };
  const pendingLogins = new WeakMap<AuthLoginChallenge, PendingLogin>();
  let activeLogin: PendingLogin | undefined;
  let loginEpoch = 0;
  let systemStore: Promise<AuthTokenStore> | undefined;
  function tokenStore(): Promise<AuthTokenStore> {
    if (options.tokenStore) return Promise.resolve(options.tokenStore);
    systemStore ??= openSystemAuthTokenStore();
    return systemStore;
  }

  function refreshSkewMs(): number {
    const value = context.config.refreshSkewSeconds;
    return (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 300) * 1_000;
  }

  function needsRefresh(envelope: AuthEnvelopeV1): boolean {
    const expiresAt = credentialString(envelope, "expiresAt");
    return expiresAt !== undefined
      && Date.parse(expiresAt) <= Date.now() + refreshSkewMs();
  }

  function assertBinding(envelope: AuthEnvelopeV1): void {
    if (
      envelope.authId !== authTarget.authId
      || envelope.driver !== authTarget.driver
      || envelope.configDigest !== configDigest
    ) {
      throw new AuthError("AUTH_CONFIG_CHANGED", "auth configuration changed after this grant was issued");
    }
  }

  async function refreshEnvelope(
    force: boolean,
    signal?: AbortSignal,
    expectedGeneration?: number,
  ): Promise<AuthEnvelopeV1> {
    const store = await tokenStore();
    return withAuthIdLock(authTarget.authId, async () => {
      // The lock protects rotating refresh tokens across applications. Always
      // re-read inside it so a faster process wins without being overwritten.
      const current = await store.read(authTarget.authId, { signal });
      if (!current) throw new AuthError("AUTH_LOGIN_REQUIRED", `auth source is not logged in: ${authTarget.authId}`);
      assertBinding(current);
      if (expectedGeneration !== undefined && current.generation !== expectedGeneration) return current;
      if (!force && !needsRefresh(current)) return current;
      const proposed = await driver.refresh(context, current, { signal });
      assertBinding(proposed);
      const next = { ...proposed, generation: current.generation + 1 };
      await store.write(next, { signal });
      return next;
    }, options.authLock);
  }

  async function envelope(signal?: AbortSignal): Promise<AuthEnvelopeV1> {
    const store = await tokenStore();
    const current = await store.read(authTarget.authId, { signal });
    if (!current) throw new AuthError("AUTH_LOGIN_REQUIRED", `auth source is not logged in: ${authTarget.authId}`);
    assertBinding(current);
    return needsRefresh(current) ? refreshEnvelope(false, signal, current.generation) : current;
  }

  async function* stream(input: ChatInput): AsyncIterable<LappStreamEventUnion> {
    let token = await envelope(input.signal);
    let emitted = false;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        for await (const event of driver.stream(context, token, input)) {
          emitted = true;
          yield event;
        }
        return;
      } catch (error) {
        if (
          attempt === 0
          && !emitted
          && error instanceof AuthError
          && error.status === 401
          && credentialString(token, "refreshToken")
        ) {
          token = await refreshEnvelope(true, input.signal, token.generation);
          continue;
        }
        throw error;
      }
    }
  }

  async function proposeLogin(proposalOptions: { signal?: AbortSignal } = {}): Promise<AuthLoginProposal> {
    const proposal = await driver.proposeLogin(context, proposalOptions);
    return {
      verificationUri: proposal.verificationUri,
      ...(proposal.userCode ? { userCode: proposal.userCode } : {}),
      expiresAt: proposal.expiresAt,
      intervalMs: proposal.intervalMs,
      async complete(completeOptions = {}) {
        const signal = completeOptions.signal ?? proposalOptions.signal;
        const proposed = await proposal.complete({ signal });
        signal?.throwIfAborted();
        assertBinding(proposed);
        const store = await tokenStore();
        const next = await withAuthIdLock(authTarget.authId, async () => {
          signal?.throwIfAborted();
          const current = await store.read(authTarget.authId, {
            signal,
          });
          const replacement = { ...proposed, generation: (current?.generation ?? 0) + 1 };
          signal?.throwIfAborted();
          await store.write(replacement, {
            signal,
          });
          return replacement;
        }, options.authLock);
        return next;
      },
    };
  }

  async function loginStart(startOptions: { signal?: AbortSignal } = {}): Promise<AuthLoginChallenge> {
    // One device authorization is meaningful for an Auth source at a time.
    // Register the new epoch before awaiting the driver: a driver may ignore
    // AbortSignal, so an older proposal must still be unable to become active
    // when it finishes after a newer loginStart call.
    activeLogin?.controller.abort(new DOMException("auth login was superseded", "AbortError"));
    const pending: PendingLogin = {
      controller: new AbortController(),
      epoch: ++loginEpoch,
    };
    activeLogin = pending;
    const combined = combinedAbortSignal(pending.controller.signal, startOptions.signal);
    try {
      const proposal = await proposeLogin({ signal: combined.signal });
      combined.signal?.throwIfAborted();
      if (activeLogin !== pending || pending.epoch !== loginEpoch) {
        throw new DOMException("auth login was superseded", "AbortError");
      }
      pending.proposal = proposal;
      const challenge: AuthLoginChallenge = {
        id: crypto.randomUUID(),
        verificationUri: proposal.verificationUri,
        ...(proposal.userCode ? { userCode: proposal.userCode } : {}),
        expiresAt: proposal.expiresAt,
        intervalMs: proposal.intervalMs,
      };
      pendingLogins.set(challenge, pending);
      return challenge;
    } catch (error) {
      if (activeLogin === pending) activeLogin = undefined;
      throw error;
    } finally {
      combined.dispose();
    }
  }

  async function loginPoll(
    challenge: AuthLoginChallenge,
    pollOptions: { signal?: AbortSignal } = {},
  ): Promise<AuthTokenStatus> {
    const pending = pendingLogins.get(challenge);
    if (!pending) {
      throw new AuthError("AUTH_OPERATION_FAILED", "auth login challenge is not active");
    }
    if (
      pending.epoch !== loginEpoch
      || activeLogin !== pending
      || pending.controller.signal.aborted
    ) {
      throw new AuthError("AUTH_OPERATION_FAILED", "auth login challenge is not active");
    }
    if (pending.polling) {
      throw new AuthError("AUTH_OPERATION_FAILED", "auth login challenge is already being polled");
    }
    const combined = combinedAbortSignal(pending.controller.signal, pollOptions.signal);
    const proposal = pending.proposal;
    if (!proposal) {
      throw new AuthError("AUTH_OPERATION_FAILED", "auth login challenge is not ready");
    }
    pending.polling = (async () => {
      try {
        combined.signal?.throwIfAborted();
        await proposal.complete({ signal: combined.signal });
        // A cancel racing a successful HTTP exchange must prevent the subsequent
        // Vault write in `complete` from being treated as a successful login.
        combined.signal?.throwIfAborted();
        return (await tokenStore()).status(authTarget.authId, { signal: combined.signal });
      } finally {
        combined.dispose();
        pendingLogins.delete(challenge);
        if (activeLogin === pending) activeLogin = undefined;
      }
    })();
    return pending.polling;
  }

  function loginCancel(challenge?: AuthLoginChallenge): boolean {
    const pending = challenge ? pendingLogins.get(challenge) : activeLogin;
    if (!pending || pending.controller.signal.aborted) return false;
    pending.controller.abort(new DOMException("auth login was cancelled", "AbortError"));
    return true;
  }

  async function fetchAuthModels(token: AuthEnvelopeV1, signal?: AbortSignal): Promise<Array<{ id: string; name?: string }>> {
    const accessToken = credentialString(token, "accessToken");
    if (!accessToken) throw new AuthError("AUTH_LOGIN_REQUIRED", "auth model discovery requires an access token");
    let response: Response;
    try {
      signal?.throwIfAborted();
      response = await context.fetchImpl(configuredModelsUrl(context), {
        method: "GET",
        headers: { accept: "application/json", authorization: `Bearer ${accessToken}` },
        redirect: "error",
        signal,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new AuthError("AUTH_HTTP_ERROR", "auth model discovery request failed");
    }
    if (!response.ok) {
      throw new AuthError("AUTH_HTTP_ERROR", `auth model discovery returned HTTP ${response.status}`, response.status);
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new AuthError("AUTH_HTTP_ERROR", "auth model discovery returned invalid JSON");
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new AuthError("AUTH_HTTP_ERROR", "auth model discovery response is invalid");
    }
    const data = (payload as { data?: unknown }).data;
    if (!Array.isArray(data)) {
      throw new AuthError("AUTH_HTTP_ERROR", "auth model discovery response is invalid");
    }
    const ids = new Set<string>();
    return data.map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw new AuthError("AUTH_HTTP_ERROR", "auth model discovery response is invalid");
      }
      const object = entry as { id?: unknown; name?: unknown; display_name?: unknown };
      const id = typeof object.id === "string" ? object.id : "";
      const rawName = object.name ?? object.display_name;
      const name = typeof rawName === "string" ? rawName : undefined;
      if (!isValidModelId(id) || (name !== undefined && !isValidModelId(name)) || ids.has(id)) {
        throw new AuthError("AUTH_HTTP_ERROR", "auth model discovery response is invalid");
      }
      if (containsSensitiveValue(id, accessToken) || containsSensitiveValue(name, accessToken)) {
        throw new AuthError("AUTH_HTTP_ERROR", "auth model discovery response contains credential data");
      }
      ids.add(id);
      return { id, ...(name ? { name } : {}) };
    });
  }

  function authModelsProposal(remote: Array<{ id: string; name?: string }>): AuthModelsRefreshProposal {
    const nextProfile = copyProfileRoot(options.profile, structuredClone(options.profile));
    const nextSource = nextProfile.auth?.find((entry) => entry.config.id === authTarget.authId);
    if (!nextSource) throw new AuthError("AUTH_NOT_FOUND", `auth source not found: ${authTarget.authId}`);
    const canonical = new Set(nextSource.models.models.map((model) => model.id));
    const aliases = new Set(nextSource.models.models.flatMap((model) => model.aliases ?? []));
    if (remote.some((model) => aliases.has(model.id) && !canonical.has(model.id))) {
      throw new AuthError("AUTH_HTTP_ERROR", "auth model discovery conflicts with a local alias");
    }
    const byId = new Map(remote.map((model) => [model.id, model]));
    const additions = remote
      .filter((model) => !canonical.has(model.id))
      .sort((left, right) => Buffer.compare(Buffer.from(left.id), Buffer.from(right.id)));
    nextSource.models.models = [
      ...nextSource.models.models.map((model) => {
        const discovered = byId.get(model.id);
        return !model.name && discovered?.name ? { ...model, name: discovered.name } : model;
      }),
      ...additions.map((model) => ({ id: model.id, ...(model.name ? { name: model.name } : {}) })),
    ];
    const validation = validateProfile(nextProfile);
    if (!validation.valid) {
      throw new AuthError("AUTH_OPERATION_FAILED", "auth model discovery produced an invalid registry proposal");
    }
    const addedIds = new Set(additions.map((model) => model.id));
    const added = listModelTargets(nextProfile, { authId: authTarget.authId, includeDisabled: true })
      .filter((entry): entry is { source: "auth" } & AuthModelDescriptor =>
        entry.source === "auth" && addedIds.has(entry.modelId));
    return {
      authId: authTarget.authId,
      nextProfile,
      added,
      diagnostics: [],
      async apply(applyOptions) {
        if (typeof applyOptions.expectedRevision !== "string") {
          throw new TypeError("expectedRevision is required to apply an auth model refresh proposal");
        }
        const rootDir = profileRoot(options.profile, applyOptions.rootDir);
        const committed = await commitRegistryTransaction({
          rootDir,
          before: options.profile,
          next: nextProfile,
          expectedRevision: applyOptions.expectedRevision,
          ...(applyOptions.lock ? { lock: applyOptions.lock } : {}),
        });
        return {
          profile: nextProfile,
          revision: computeRegistryRevision(rootDir),
          profileChanged: committed.profileChanged,
        };
      },
    };
  }

  async function chat(input: ChatInput): Promise<LappResponse> {
    if (input.stream) throw new Error("chat() does not support stream: true; use client.stream()");
    return collectAuthStream(context, input, stream(input));
  }

  return {
    source: "auth",
    sourceId: authTarget.authId,
    model: authTarget.modelId,
    protocol: authTarget.protocol,
    chat,
    async rawChat(input) { return (await chat(input)).raw; },
    stream,
    async testConnection() {
      try {
        await envelope();
        return {
          ok: true,
          provider: authTarget.authId,
          model: authTarget.modelId,
          protocol: authTarget.protocol,
        };
      } catch (error) {
        return {
          ok: false,
          provider: authTarget.authId,
          model: authTarget.modelId,
          protocol: authTarget.protocol,
          ...(error instanceof AuthError ? { code: error.code, message: error.message } : {}),
        };
      }
    },
    proposeLogin,
    loginStart,
    loginPoll,
    loginCancel,
    async login(loginOptions = {}) {
      const challenge = await loginStart({ signal: loginOptions.signal });
      await loginOptions.onVerification?.({
        verificationUri: challenge.verificationUri,
        ...(challenge.userCode ? { userCode: challenge.userCode } : {}),
        expiresAt: challenge.expiresAt,
        intervalMs: challenge.intervalMs,
      });
      return loginPoll(challenge, { signal: loginOptions.signal });
    },
    async status(statusOptions = {}) {
      const status = await (await tokenStore()).status(authTarget.authId, statusOptions);
      if (status.exists) {
        const current = await (await tokenStore()).read(authTarget.authId, statusOptions);
        if (current) assertBinding(current);
      }
      return status;
    },
    async logout(logoutOptions = {}) {
      // Invalidate before awaiting the store or entering the shared auth-ID
      // lock. A poll that has not crossed its commit barrier will observe the
      // abort; one that already holds the barrier completes before this delete.
      const pending = activeLogin;
      activeLogin = undefined;
      loginEpoch += 1;
      pending?.controller.abort(new DOMException("auth login was logged out", "AbortError"));
      const store = await tokenStore();
      return withAuthIdLock(
        authTarget.authId,
        () => store.delete(authTarget.authId, logoutOptions),
        options.authLock,
      );
    },
    async refresh(refreshOptions = {}) {
      await refreshEnvelope(true, refreshOptions.signal);
      return (await tokenStore()).status(authTarget.authId, refreshOptions);
    },
    async refreshAuthModels(refreshOptions = {}) {
      let token = await envelope(refreshOptions.signal);
      let remote: Array<{ id: string; name?: string }>;
      try {
        remote = await fetchAuthModels(token, refreshOptions.signal);
      } catch (error) {
        if (
          error instanceof AuthError
          && error.status === 401
          && credentialString(token, "refreshToken")
        ) {
          token = await refreshEnvelope(true, refreshOptions.signal, token.generation);
          remote = await fetchAuthModels(token, refreshOptions.signal);
        } else {
          throw error;
        }
      }
      return authModelsProposal(remote);
    },
  };
}

/** Free-function form of `RegistryClient.refreshAuthModels()`. */
export function refreshAuthModels(
  client: RegistryClient,
  options?: { signal?: AbortSignal },
): Promise<AuthModelsRefreshProposal> {
  return client.refreshAuthModels(options);
}
