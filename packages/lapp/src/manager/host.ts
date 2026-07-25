import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { createLappClient } from "../client/index.js";
import { loadProfileOnce, resolveLappRoot } from "../config/discovery.js";
import {
  createProfile,
  removeModel,
  removeProvider,
  setDefault,
  upsertModel,
  prepareProviderUpdate,
  type CredentialWarning,
  type ManagedAuthConfig,
  type ManagedProviderInput,
} from "../manage/index.js";
import { redactErrorText } from "../redact.js";
import {
  createCredentialResolver,
  credentialBindingForProvider,
  formatVaultSecretRef,
  openSystemCredentialVault,
  parseSecretRef,
} from "../secret/index.js";
import { refreshModels } from "../sync/index.js";
import {
  CredentialError,
  ProfileValidationError,
  type CredentialVault,
  type Diagnostic,
  type LappProfile,
  type ProviderConfig,
} from "../types.js";
import { validateProfile } from "../validate/index.js";
import {
  LAPP_MANAGER_BRIDGE_PROTOCOL_VERSION,
  type LappManagerBridgeV1,
  type ManagerAuthView,
  type ManagerCredentialView,
  type ManagerErrorCode,
  type ManagerErrorView,
  type ManagerHandshake,
  type ManagerInvalidatedEvent,
  type ManagerOperation,
  type ManagerProfileView,
  type ManagerProviderView,
  type ManagerResult,
  type ManagerSnapshot,
  type ManagerTestConnectionRequest,
  type ManagerTestConnectionView,
  type ManagerTransactionRequest,
  type ManagerTransactionResult,
} from "./contract.js";
import { computeProfileRevision, ProfilePathInvalidError } from "./revision.js";
export { computeProfileRevision, ProfilePathInvalidError } from "./revision.js";
import {
  commitManagerTransaction,
  type ManagerPendingVaultWrite,
  ProfileRevisionConflictError,
} from "./transaction.js";
import {
  ProfileLockInvalidError,
  ProfileLockedError,
  resolveLappStateHome,
  withWriterLock,
  type WriterLockOptions,
} from "../writer/lock.js";
import {
  ProfileReadUnstableError,
  readStable,
} from "../writer/stable-read.js";

export {
  commitProfileTransaction,
  type CommitProfileTransactionOptions,
  type CommitProfileTransactionResult,
  ProfileRevisionConflictError,
} from "./transaction.js";

export interface CreateNodeLappManagerHostOptions {
  /** Fixed LAPP root owned by this host. Renderer calls cannot replace it. */
  path?: string;
  /** Test/embedding Vault. The system Vault is opened lazily when omitted. */
  vault?: CredentialVault;
  /** Environment source used by availability checks and provider operations. */
  env?: Record<string, string | undefined>;
  /** Fetch implementation used by connection tests and model discovery. */
  fetchImpl?: typeof fetch;
  /** Current-user global writer lock options, primarily useful for tests/embedding. */
  lock?: WriterLockOptions;
}

interface StableProfile {
  profile: LappProfile;
  profileRevision: string;
  revision: string;
  initialized: boolean;
}

interface AppliedOperation {
  nextProfile: LappProfile;
  warnings: CredentialWarning[];
  vaultWrite?: ManagerPendingVaultWrite;
  vaultDeleteRef?: string;
}

class ManagerHostError extends Error {
  constructor(
    readonly code: ManagerErrorCode,
    message: string,
    readonly currentRevision?: string,
  ) {
    super(message);
    this.name = "ManagerHostError";
  }
}

const MANAGER_REVISION_DOMAIN = Buffer.from("lapp-manager-revision-v1\0", "ascii");
const EMPTY_VAULT_REVISION = "00000000-0000-0000-0000-000000000000";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function managerVaultRevisionFile(root: string, lock: WriterLockOptions | undefined): string {
  const stateHome = resolveLappStateHome(lock?.stateHome, lock);
  const normalizedRoot = process.platform === "win32"
    ? path.resolve(root).toLowerCase()
    : path.resolve(root);
  const rootKey = createHash("sha256").update(normalizedRoot, "utf8").digest("hex");
  return path.join(stateHome, "revisions", "manager-vault-v1", `${rootKey}.revision`);
}

function readManagerVaultRevision(root: string, lock: WriterLockOptions | undefined): string {
  const target = managerVaultRevisionFile(root, lock);
  try {
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new ProfileLockInvalidError("manager Vault revision state is not a regular file");
    }
    const raw = fs.readFileSync(target, "utf8");
    const revision = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
    if (!UUID.test(revision)) {
      throw new ProfileLockInvalidError("manager Vault revision state is invalid");
    }
    return revision;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return EMPTY_VAULT_REVISION;
    throw error;
  }
}

function advanceManagerVaultRevision(root: string, lock: WriterLockOptions | undefined): void {
  const target = managerVaultRevisionFile(root, lock);
  const directory = path.dirname(target);
  fs.mkdirSync(directory, { recursive: true });
  const directoryStat = fs.lstatSync(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new ProfileLockInvalidError("manager Vault revision directory is invalid");
  }

  const revision = randomUUID();
  const temporary = `${target}.tmp-${revision}`;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(descriptor, `${revision}\n`, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, target);
  } catch (error) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch { /* preserve the primary error */ }
    }
    try { fs.rmSync(temporary, { force: true }); } catch { /* preserve the primary error */ }
    throw error;
  }
}

function computeManagerRevision(profileRevision: string, vaultRevision: string): string {
  const hash = createHash("sha256");
  hash.update(MANAGER_REVISION_DOMAIN);
  hash.update(profileRevision, "utf8");
  hash.update("\0", "ascii");
  hash.update(vaultRevision, "ascii");
  return `sha256:${hash.digest("hex")}`;
}

function hasManagedProfile(root: string): boolean {
  return fs.existsSync(path.join(root, "global.json"))
    || fs.existsSync(path.join(root, "providers"));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function modelTarget(value: unknown): boolean {
  return isRecord(value)
    && typeof value.providerId === "string"
    && typeof value.model === "string";
}

function isManagerOperation(value: unknown): value is ManagerOperation {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  switch (value.type) {
    case "provider.set":
      return isRecord(value.input) && typeof value.input.id === "string";
    case "provider.delete":
    case "models.refresh":
      return typeof value.providerId === "string";
    case "model.set":
      return isRecord(value.input)
        && typeof value.input.providerId === "string"
        && typeof value.input.id === "string";
    case "model.delete":
      return modelTarget(value.target);
    case "default.set":
      return typeof value.task === "string" && modelTarget(value.target);
    case "default.delete":
      return typeof value.task === "string";
    case "credential.set":
      return typeof value.providerId === "string"
        && typeof value.secret === "string"
        && (!hasOwn(value, "credentialId") || typeof value.credentialId === "string")
        && (!hasOwn(value, "overwrite") || typeof value.overwrite === "boolean");
    case "credential.delete":
      return typeof value.providerId === "string"
        && (!hasOwn(value, "credentialId") || typeof value.credentialId === "string");
    default:
      return false;
  }
}

function sensitiveValues(operation: unknown): string[] {
  if (!isRecord(operation) || typeof operation.type !== "string") return [];
  if (operation.type === "credential.set") {
    return typeof operation.secret === "string" ? [operation.secret] : [];
  }
  if (operation.type !== "provider.set" || !isRecord(operation.input)) return [];
  const auth = operation.input.auth;
  if (!isRecord(auth) || auth.type === "none" || !isRecord(auth.credential)) return [];
  if (auth.credential.storage === "env") return [];
  return typeof auth.credential.secret === "string" ? [auth.credential.secret] : [];
}

function transactionRequest(value: unknown): ManagerTransactionRequest {
  if (
    !isRecord(value)
    || typeof value.expectedRevision !== "string"
    || !isManagerOperation(value.operation)
  ) {
    throw new ManagerHostError(
      "MANAGER_OPERATION_UNSUPPORTED",
      "manager transaction request is malformed",
    );
  }
  return value as unknown as ManagerTransactionRequest;
}

function connectionRequest(value: unknown): ManagerTestConnectionRequest {
  if (!isRecord(value) || !isRecord(value.selector)) {
    throw new ManagerHostError(
      "MANAGER_OPERATION_UNSUPPORTED",
      "manager connection request is malformed",
    );
  }
  const selector = value.selector;
  const hasDefault = hasOwn(selector, "default");
  const hasProviderId = hasOwn(selector, "providerId");
  const hasModel = hasOwn(selector, "model");
  const validDefault = hasDefault
    && !hasProviderId
    && !hasModel
    && typeof selector.default === "string";
  const validExplicit = !hasDefault
    && hasProviderId
    && hasModel
    && typeof selector.providerId === "string"
    && typeof selector.model === "string";
  if (!validDefault && !validExplicit) {
    throw new ManagerHostError(
      "MANAGER_OPERATION_UNSUPPORTED",
      "manager connection selector is malformed",
    );
  }
  return validDefault
    ? { selector: { default: selector.default as string } }
    : {
        selector: {
          providerId: selector.providerId as string,
          model: selector.model as string,
        },
      };
}

function sanitizeDiagnostics(
  diagnostics: readonly Diagnostic[],
  sensitive: readonly string[],
): Diagnostic[] {
  return diagnostics.map((entry) => ({
    ...entry,
    message: redactErrorText(entry.message, sensitive),
    ...(entry.location
      ? { location: redactErrorText(entry.location, sensitive) }
      : {}),
  }));
}

function managerError(error: unknown, sensitive: readonly string[] = []): ManagerErrorView {
  if (error instanceof ManagerHostError) {
    return {
      code: error.code,
      message: redactErrorText(error.message, sensitive),
      ...(error.currentRevision ? { currentRevision: error.currentRevision } : {}),
    };
  }
  if (error instanceof CredentialError) {
    return {
      code: error.code,
      message: redactErrorText(error.message, sensitive),
      ...(error.causes.length > 0
        ? {
            causes: error.causes.map((cause) => ({
              code: cause.code,
              message: redactErrorText(cause.message, sensitive),
            })),
          }
        : {}),
    };
  }
  if (error instanceof ProfileLockedError) {
    return {
      code: "PROFILE_LOCKED",
      message: "timed out waiting for another profile writer",
    };
  }
  if (error instanceof ProfileLockInvalidError) {
    return {
      code: error.code,
      message: "the current-user writer lock could not be handled safely",
    };
  }
  if (error instanceof ProfileReadUnstableError) {
    return {
      code: error.code,
      message: "profile changed repeatedly while it was being read",
    };
  }
  if (error instanceof ProfilePathInvalidError) {
    return {
      code: error.code,
      message: "a managed provider directory name is not valid UTF-8",
    };
  }
  if (error instanceof ProfileRevisionConflictError) {
    return {
      code: "PROFILE_CONFLICT",
      message: "profile changed before the transaction could be committed",
      currentRevision: error.currentRevision,
    };
  }
  if (error instanceof ProfileValidationError) {
    return {
      code: "PROFILE_INVALID",
      message: redactErrorText(error.message, sensitive),
      diagnostics: sanitizeDiagnostics(error.diagnostics, sensitive),
    };
  }
  if (error instanceof Error && error.name === "ProfileUpdatePartialFailureError") {
    return {
      code: "PROFILE_UPDATE_PARTIAL_FAILURE",
      message: "profile update failed and the previous profile files could not be restored",
    };
  }
  const message = error instanceof Error ? error.message : "manager operation failed";
  return {
    code: "PROFILE_OPERATION_FAILED",
    message: redactErrorText(message, sensitive),
  };
}

function resultError<T>(error: unknown, sensitive: readonly string[] = []): ManagerResult<T> {
  return { ok: false, error: managerError(error, sensitive) };
}

function providerById(profile: LappProfile, providerId: string): ProviderConfig {
  const provider = profile.providers.find((entry) => entry.config.id === providerId);
  if (!provider) throw new Error(`provider not found: ${providerId}`);
  return provider.config;
}

function managedCredentialAuth(
  config: ProviderConfig,
  secret: string,
  credentialId: string,
  overwrite: boolean,
): ManagedAuthConfig {
  const credential = { secret, storage: "vault" as const, credentialId, overwrite };
  if (config.auth.type === "bearer") return { type: "bearer", credential };
  if (config.auth.type === "header") {
    return { type: "header", name: config.auth.name, credential };
  }
  if (config.auth.type === "query") {
    return { type: "query", name: config.auth.name, credential };
  }
  throw new CredentialError(
    "INVALID_SECRET_REFERENCE",
    "a provider without authentication cannot store a credential",
  );
}

function cloneWithoutDefault(profile: LappProfile, task: string): LappProfile {
  const next = structuredClone(profile);
  if (next.global) {
    delete next.global.defaults[task];
    if (Object.keys(next.global.defaults).length === 0) delete next.global;
  }
  return next;
}

function sanitizeHeaders(
  headers: Record<string, string> | undefined,
  sensitive: readonly string[],
): Record<string, string> | undefined {
  if (!headers) return undefined;
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [
      redactErrorText(name, sensitive),
      redactErrorText(value, sensitive),
    ]),
  );
}

function sanitizeModels(models: ManagerProviderView["models"], sensitive: readonly string[]) {
  return models.map((model) => ({
    id: redactErrorText(model.id, sensitive),
    ...(model.name !== undefined ? { name: redactErrorText(model.name, sensitive) } : {}),
    ...(model.aliases !== undefined
      ? { aliases: model.aliases.map((value) => redactErrorText(value, sensitive)) }
      : {}),
    ...(model.enabled !== undefined ? { enabled: model.enabled } : {}),
    ...(model.protocols !== undefined
      ? { protocols: model.protocols.map((value) => redactErrorText(value, sensitive)) }
      : {}),
    ...(model.type !== undefined ? { type: redactErrorText(model.type, sensitive) } : {}),
    ...(model.inputModalities !== undefined
      ? { inputModalities: model.inputModalities.map((value) => redactErrorText(value, sensitive)) }
      : {}),
    ...(model.outputModalities !== undefined
      ? { outputModalities: model.outputModalities.map((value) => redactErrorText(value, sensitive)) }
      : {}),
    ...(model.capabilities !== undefined
      ? { capabilities: model.capabilities.map((value) => redactErrorText(value, sensitive)) }
      : {}),
    ...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
    ...(model.maxOutputTokens !== undefined ? { maxOutputTokens: model.maxOutputTokens } : {}),
  }));
}

/**
 * Create a Node-owned manager host. The host owns the filesystem/Vault/network
 * authority; renderer integrations receive only the narrow result-union bridge.
 */
export function createNodeLappManagerHost(
  options: CreateNodeLappManagerHostOptions = {},
): LappManagerBridgeV1 {
  const root = resolveLappRoot(options.path);
  const listeners = new Set<(event: ManagerInvalidatedEvent) => void>();
  let tail: Promise<void> = Promise.resolve();
  let systemVault: Promise<CredentialVault> | undefined;

  const openVault = (): Promise<CredentialVault> => {
    if (options.vault) return Promise.resolve(options.vault);
    systemVault ??= openSystemCredentialVault();
    return systemVault;
  };

  const lazyVault: CredentialVault = {
    async put(ref, secret, binding, putOptions) {
      return (await openVault()).put(ref, secret, binding, putOptions);
    },
    async resolve(ref, binding, resolveOptions) {
      return (await openVault()).resolve(ref, binding, resolveOptions);
    },
    async status(ref, binding, statusOptions) {
      return (await openVault()).status(ref, binding, statusOptions);
    },
    async delete(ref, deleteOptions) {
      return (await openVault()).delete(ref, deleteOptions);
    },
  };

  function serialize<T>(work: () => Promise<T>): Promise<T> {
    const run = tail.then(work, work);
    tail = run.then(() => undefined, () => undefined);
    return run;
  }

  async function readStableProfile(lockHeld = false): Promise<StableProfile> {
    const stable = readStable(root, () => {
      const initialized = hasManagedProfile(root);
      const profile = initialized ? loadProfileOnce({ path: root }) : createProfile({ rootDir: root });
      const vaultRevision = readManagerVaultRevision(root, options.lock);
      return { profile, initialized, vaultRevision };
    }, { lockHeld, lock: options.lock });
    return {
      profile: stable.value.profile,
      initialized: stable.value.initialized,
      profileRevision: stable.revision,
      revision: computeManagerRevision(stable.revision, stable.value.vaultRevision),
    };
  }

  function ensureRevision(expected: string): void {
    const current = computeManagerRevision(
      computeProfileRevision(root),
      readManagerVaultRevision(root, options.lock),
    );
    if (current !== expected) {
      throw new ManagerHostError(
        "PROFILE_CONFLICT",
        "profile changed since the manager snapshot was read",
        current,
      );
    }
  }

  async function credentialView(
    config: ProviderConfig,
    sensitive: readonly string[],
  ): Promise<ManagerCredentialView> {
    if (config.auth.type === "none") {
      throw new Error("a provider without authentication has no credential view");
    }
    const raw = config.auth.secret;
    const reference = parseSecretRef(raw);
    const binding = credentialBindingForProvider(config);
    if (!binding) throw new Error("authenticated provider is missing a credential binding");
    if (reference.scheme === "unknown") {
      throw new CredentialError("UNSUPPORTED_SECRET_SCHEME", "unsupported credential scheme");
    }
    try {
      const status = await createCredentialResolver({
        ...(options.env ? { env: options.env } : {}),
        vault: lazyVault,
      }).status(raw, binding);
      return {
        scheme: status.scheme,
        ...(status.scheme !== "plaintext"
          ? { reference: redactErrorText(raw, sensitive) }
          : {}),
        available: status.available,
        ...(status.bindingMatches !== undefined
          ? { bindingMatches: status.bindingMatches }
          : {}),
        plaintextWarning: status.scheme === "plaintext",
      };
    } catch (error) {
      if (!(error instanceof CredentialError)) throw error;
      return {
        scheme: reference.scheme,
        ...(reference.scheme !== "plaintext"
          ? { reference: redactErrorText(raw, sensitive) }
          : {}),
        available: false,
        plaintextWarning: reference.scheme === "plaintext",
        errorCode: error.code,
      };
    }
  }

  async function authView(
    config: ProviderConfig,
    sensitive: readonly string[],
  ): Promise<ManagerAuthView> {
    if (config.auth.type === "none") return { type: "none" };
    const credential = await credentialView(config, sensitive);
    if (config.auth.type === "bearer") return { type: "bearer", credential };
    return {
      type: config.auth.type,
      name: redactErrorText(config.auth.name, sensitive),
      credential,
    };
  }

  async function snapshot(
    stable: StableProfile,
    additionalSensitive: readonly string[] = [],
  ): Promise<ManagerSnapshot> {
    const plaintext = stable.profile.providers.flatMap((provider) => {
      const auth = provider.config.auth;
      return auth.type !== "none" && parseSecretRef(auth.secret).scheme === "plaintext"
        ? [auth.secret]
        : [];
    });
    const sensitive = [...new Set([...plaintext, ...additionalSensitive].filter(Boolean))];
    const providers: ManagerProviderView[] = [];
    for (const provider of stable.profile.providers) {
      const config = provider.config;
      const requestHeaders = sanitizeHeaders(config.requestHeaders, sensitive);
      providers.push({
        id: redactErrorText(config.id, sensitive),
        ...(config.name !== undefined
          ? { name: redactErrorText(config.name, sensitive) }
          : {}),
        ...(config.providerType !== undefined
          ? { providerType: redactErrorText(config.providerType, sensitive) }
          : {}),
        enabled: config.enabled !== false,
        baseUrl: redactErrorText(config.baseUrl, sensitive),
        protocols: config.protocols.map((value) => redactErrorText(value, sensitive)),
        auth: await authView(config, sensitive),
        ...(requestHeaders ? { requestHeaders } : {}),
        ...(config.modelDiscovery
          ? {
              modelDiscovery: {
                protocol: config.modelDiscovery.protocol,
                url: redactErrorText(config.modelDiscovery.url, sensitive),
              },
            }
          : {}),
        models: sanitizeModels(provider.models.models, sensitive),
      });
    }
    const validation = validateProfile(stable.profile);
    const profile: ManagerProfileView = {
      ...(stable.profile.global
        ? {
            global: {
              schemaVersion: stable.profile.global.schemaVersion,
              defaults: Object.fromEntries(
                Object.entries(stable.profile.global.defaults).map(([task, target]) => [
                  redactErrorText(task, sensitive),
                  {
                    providerId: redactErrorText(target.providerId, sensitive),
                    modelId: redactErrorText(target.modelId, sensitive),
                  },
                ]),
              ),
            },
          }
        : {}),
      providers,
    };
    return {
      revision: stable.revision,
      profile,
      diagnostics: sanitizeDiagnostics(validation.diagnostics, sensitive),
    };
  }

  async function applyOperation(
    profile: LappProfile,
    operation: ManagerOperation,
  ): Promise<AppliedOperation> {
    if (operation.type === "provider.set") {
      const result = prepareProviderUpdate(profile, operation.input);
      return {
        nextProfile: result.profile,
        warnings: result.warnings,
        ...(result.vaultWrite ? { vaultWrite: result.vaultWrite } : {}),
      };
    }
    if (operation.type === "provider.delete") {
      return { nextProfile: removeProvider(profile, operation.providerId), warnings: [] };
    }
    if (operation.type === "model.set") {
      return { nextProfile: upsertModel(profile, operation.input), warnings: [] };
    }
    if (operation.type === "model.delete") {
      return { nextProfile: removeModel(profile, operation.target), warnings: [] };
    }
    if (operation.type === "default.set") {
      return {
        nextProfile: setDefault(profile, operation.task, operation.target),
        warnings: [],
      };
    }
    if (operation.type === "default.delete") {
      return { nextProfile: cloneWithoutDefault(profile, operation.task), warnings: [] };
    }
    if (operation.type === "credential.set") {
      const config = providerById(profile, operation.providerId);
      const input: ManagedProviderInput = {
        id: operation.providerId,
        auth: managedCredentialAuth(
          config,
          operation.secret,
          operation.credentialId ?? "default",
          operation.overwrite ?? false,
        ),
      };
      const result = prepareProviderUpdate(profile, input);
      if (!result.vaultWrite) throw new Error("credential operation did not stage a Vault write");
      return {
        nextProfile: result.profile,
        warnings: result.warnings,
        vaultWrite: result.vaultWrite,
      };
    }
    if (operation.type === "credential.delete") {
      providerById(profile, operation.providerId);
      return {
        nextProfile: profile,
        warnings: [],
        vaultDeleteRef: formatVaultSecretRef(
          operation.providerId,
          operation.credentialId ?? "default",
        ),
      };
    }
    if (operation.type === "models.refresh") {
      const result = await refreshModels(profile, operation.providerId, {
        ...(options.env ? { env: options.env } : {}),
        vault: lazyVault,
        ...(options.fetchImpl ? { fetch: options.fetchImpl } : {}),
      });
      return { nextProfile: result.nextProfile, warnings: [] };
    }
    throw new ManagerHostError(
      "MANAGER_OPERATION_UNSUPPORTED",
      "manager operation is not supported",
    );
  }

  function emit(revision: string): void {
    for (const listener of [...listeners]) {
      try {
        listener({ type: "invalidated", revision });
      } catch {
        // Renderer listeners are untrusted and cannot affect host transactions.
      }
    }
  }

  async function transact(
    rawRequest: unknown,
  ): Promise<ManagerResult<ManagerTransactionResult>> {
    let request: ManagerTransactionRequest;
    try {
      request = transactionRequest(rawRequest);
    } catch (error) {
      return resultError(error, sensitiveValues(
        isRecord(rawRequest) ? rawRequest.operation : undefined,
      ));
    }
    const operationSensitive = sensitiveValues(request.operation);
    try {
      const before = await readStableProfile(true);
      if (request.expectedRevision !== before.revision) {
        throw new ManagerHostError(
          "PROFILE_CONFLICT",
          "profile changed since the manager snapshot was read",
          before.revision,
        );
      }
      const applied = await applyOperation(before.profile, request.operation);
      ensureRevision(before.revision);
      const profileChanged = !isDeepStrictEqual(before.profile, applied.nextProfile);
      const committed = await commitManagerTransaction({
        rootDir: root,
        before: before.initialized ? before.profile : null,
        next: applied.nextProfile,
        profileChanged,
        vault: lazyVault,
        lockHeld: true,
        expectedRevision: before.profileRevision,
        beforeVaultMutation: () => advanceManagerVaultRevision(root, options.lock),
        ...(applied.vaultWrite ? { vaultWrite: applied.vaultWrite } : {}),
        ...(applied.vaultDeleteRef ? { vaultDeleteRef: applied.vaultDeleteRef } : {}),
      }).catch((error: unknown) => {
        if (error instanceof ProfileRevisionConflictError) {
          throw new ManagerHostError(
            "PROFILE_CONFLICT",
            "profile changed before the transaction could be committed",
            computeManagerRevision(
              error.currentRevision,
              readManagerVaultRevision(root, options.lock),
            ),
          );
        }
        throw error;
      });

      const after = await readStableProfile(true);
      const nextSnapshot = await snapshot(after, operationSensitive);
      if (committed.profileChanged || committed.vaultChanged) emit(after.revision);
      return {
        ok: true,
        value: {
          revision: after.revision,
          snapshot: nextSnapshot,
          warnings: applied.warnings.map((warning) => ({
            ...warning,
            message: redactErrorText(warning.message, operationSensitive),
          })),
        },
      };
    } catch (error) {
      return resultError(error, operationSensitive);
    }
  }

  const handshake: ManagerHandshake = {
    protocolVersion: LAPP_MANAGER_BRIDGE_PROTOCOL_VERSION,
    features: ["write-profile", "vault", "test-connection", "refresh-models", "events"],
  };

  return {
    async handshake() {
      return { ok: true, value: structuredClone(handshake) };
    },

    getSnapshot() {
      return serialize(async () => {
        try {
          const stable = await readStableProfile();
          return { ok: true, value: await snapshot(stable) } as const;
        } catch (error) {
          return resultError<ManagerSnapshot>(error);
        }
      });
    },

    transact(request) {
      return serialize(async () => {
        const operation = isRecord(request) ? request.operation : undefined;
        try {
          return await withWriterLock(
            () => transact(request),
            options.lock,
          );
        } catch (error) {
          return resultError<ManagerTransactionResult>(
            error,
            sensitiveValues(operation),
          );
        }
      });
    },

    testConnection(rawRequest: ManagerTestConnectionRequest) {
      return serialize(async () => {
        try {
          const request = connectionRequest(rawRequest);
          const stable = await readStableProfile();
          const selector = request.selector;
          const client = "default" in selector
            ? createLappClient({
                profile: stable.profile,
                default: selector.default,
                ...(options.env ? { env: options.env } : {}),
                vault: lazyVault,
                ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
                redactSuccessfulSecrets: true,
              })
            : createLappClient({
                profile: stable.profile,
                provider: selector.providerId,
                model: selector.model,
                ...(options.env ? { env: options.env } : {}),
                vault: lazyVault,
                ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
                redactSuccessfulSecrets: true,
              });
          const tested = await client.testConnection();
          const value: ManagerTestConnectionView = {
            ok: tested.ok,
            providerId: tested.provider,
            modelId: tested.model,
            protocol: tested.protocol,
            ...(tested.code ? { code: redactErrorText(tested.code) } : {}),
            ...(tested.message ? { message: redactErrorText(tested.message) } : {}),
          };
          return { ok: true, value } as const;
        } catch (error) {
          return resultError<ManagerTestConnectionView>(error);
        }
      });
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
