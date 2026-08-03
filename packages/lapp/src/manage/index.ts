import path from "node:path";
import { CredentialError, ProfileValidationError, TargetResolutionError } from "../types.js";
import type {
  AuthConfig,
  AuthSource,
  CredentialBinding,
  Extensions,
  LappProfile,
  ModelDiscoveryConfig,
  ModelEntry,
  ProviderConfig,
} from "../types.js";
import { isValidModelId, isValidProviderId } from "../validate/constants.js";
import { validateProfile } from "../validate/index.js";
import { attachProfileRoot, copyProfileRoot } from "../profile-location.js";
import {
  credentialBindingForProvider,
  formatVaultSecretRef,
} from "../secret/index.js";

export interface CreateProfileInput {
  rootDir: string;
}

export interface ProviderInput {
  id: string;
  name?: string;
  providerType?: string;
  enabled?: boolean;
  baseUrl?: string;
  protocols?: string[];
  auth?: AuthConfig;
  requestHeaders?: Record<string, string>;
  modelDiscovery?: ModelDiscoveryConfig;
  extensions?: Extensions;
  models?: ModelEntry[];
}

export type CredentialInput =
  | {
    secret: string;
    storage?: "vault";
    credentialId?: string;
    overwrite?: boolean;
  }
  | { secret: string; storage: "plaintext" }
  | { storage: "env"; name: string };

export type ManagedAuthConfig =
  | { type: "none" }
  | { type: "bearer"; credential: CredentialInput }
  | { type: "header"; name: string; credential: CredentialInput }
  | { type: "query"; name: string; credential: CredentialInput };

/** Provider input whose raw credentials are stored according to an explicit policy. */
export type ManagedProviderInput = Omit<ProviderInput, "auth"> & {
  auth?: ManagedAuthConfig;
};

export interface CredentialWarning {
  code: "PLAINTEXT_SECRET_IN_USE";
  message: string;
}

export interface PendingVaultWrite {
  ref: string;
  secret: string;
  binding: CredentialBinding;
  overwrite: boolean;
}

export interface PrepareProviderUpdateResult {
  profile: LappProfile;
  credentialRef?: string;
  vaultWrite?: PendingVaultWrite;
  warnings: CredentialWarning[];
}

export interface ModelInput {
  providerId: string;
  id: string;
  name?: string;
  aliases?: string[];
  enabled?: boolean;
  protocols?: string[];
  type?: string;
  inputModalities?: string[];
  outputModalities?: string[];
  capabilities?: string[];
  contextWindow?: number;
  maxOutputTokens?: number;
  extensions?: Extensions;
}

export interface ModelTarget {
  providerId: string;
  model: string;
}

export interface AuthSourceInput {
  id: string;
  driver: string;
  protocols: string[];
  name?: string;
  enabled?: boolean;
  config?: Record<string, import("../types.js").JsonValue>;
  extensions?: Extensions;
  models?: ModelEntry[];
}

export interface AuthModelTarget {
  authId: string;
  modelId: string;
}

function clone(profile: LappProfile): LappProfile {
  return copyProfileRoot(profile, structuredClone(profile));
}

function requireProvider(profile: LappProfile, providerId: string) {
  const provider = profile.providers.find((entry) => entry.config.id === providerId);
  if (!provider) {
    throw new TargetResolutionError(`provider not found: ${providerId}`, "PROVIDER_NOT_FOUND");
  }
  return provider;
}

function canonicalModelId(profile: LappProfile, target: ModelTarget): string {
  const provider = requireProvider(profile, target.providerId);
  const matches = provider.models.models.filter(
    (model) => model.id === target.model || model.aliases?.includes(target.model),
  );
  if (matches.length === 0) {
    throw new TargetResolutionError(
      `model not found: ${target.providerId}/${target.model}`,
      "MODEL_NOT_FOUND",
    );
  }
  if (matches.length > 1) {
    throw new TargetResolutionError(
      `model is ambiguous: ${target.providerId}/${target.model}`,
      "MODEL_AMBIGUOUS",
    );
  }
  return matches[0]!.id;
}

export function createProfile(input: CreateProfileInput): LappProfile {
  return attachProfileRoot({ providers: [] }, path.resolve(input.rootDir));
}

/** Add or patch a provider. Omitted fields are preserved on updates. */
export function upsertProvider(profile: LappProfile, input: ProviderInput): LappProfile {
  if (!isValidProviderId(input.id)) throw new Error(`invalid provider id: ${input.id}`);
  const next = clone(profile);
  const index = next.providers.findIndex((entry) => entry.config.id === input.id);
  const existing = index >= 0 ? next.providers[index]! : undefined;
  if (!existing && (!input.baseUrl || !input.protocols || !input.auth)) {
    throw new Error("new provider requires baseUrl, protocols, and auth");
  }
  const config: ProviderConfig = {
    ...(existing?.config ?? {}),
    schemaVersion: "1.0",
    id: input.id,
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.providerType !== undefined ? { providerType: input.providerType } : {}),
    ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
    ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl } : {}),
    ...(input.protocols !== undefined ? { protocols: [...input.protocols] } : {}),
    ...(input.auth !== undefined ? { auth: structuredClone(input.auth) } : {}),
    ...(input.requestHeaders !== undefined
      ? { requestHeaders: { ...input.requestHeaders } }
      : {}),
    ...(input.modelDiscovery !== undefined
      ? { modelDiscovery: { ...input.modelDiscovery } }
      : {}),
    ...(input.extensions !== undefined
      ? { extensions: structuredClone(input.extensions) }
      : {}),
  } as ProviderConfig;
  const models = input.models !== undefined
    ? { schemaVersion: "1.0" as const, models: structuredClone(input.models) }
    : existing?.models ?? { schemaVersion: "1.0" as const, models: [] };
  const provider = { config, models };
  if (index >= 0) next.providers[index] = provider;
  else next.providers.push(provider);
  return next;
}

/**
 * Prepare a provider update and an optional Vault write without side effects.
 * Pass both to `commitProfileTransaction()` for locked CAS + rollback.
 */
export function prepareProviderUpdate(
  profile: LappProfile,
  input: ManagedProviderInput,
): PrepareProviderUpdateResult {
  const { auth: managedAuth, ...providerFields } = input;
  if (managedAuth === undefined) {
    return { profile: upsertProvider(profile, providerFields), warnings: [] };
  }
  if (managedAuth.type === "none") {
    return {
      profile: upsertProvider(profile, { ...providerFields, auth: { type: "none" } }),
      warnings: [],
    };
  }

  const credential = managedAuth.credential;
  let secretReference: string;
  let credentialRef: string | undefined;
  let vaultWrite: { secret: string; overwrite: boolean } | undefined;
  const warnings: CredentialWarning[] = [];

  if (credential.storage === "env") {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(credential.name)) {
      throw new CredentialError("INVALID_SECRET_REFERENCE", "invalid env credential reference");
    }
    secretReference = `env://${credential.name}`;
  } else if (credential.storage === "plaintext") {
    if (!credential.secret || /[\r\n]/.test(credential.secret)) {
      throw new CredentialError("INVALID_SECRET_REFERENCE", "credential cannot be empty");
    }
    secretReference = credential.secret;
    warnings.push({
      code: "PLAINTEXT_SECRET_IN_USE",
      message: "credential is stored as plaintext",
    });
  } else if (credential.storage === undefined || credential.storage === "vault") {
    if (!credential.secret || /[\r\n]/.test(credential.secret)) {
      throw new CredentialError("INVALID_SECRET_REFERENCE", "credential cannot be empty");
    }
    credentialRef = formatVaultSecretRef(input.id, credential.credentialId ?? "default");
    secretReference = credentialRef;
    vaultWrite = { secret: credential.secret, overwrite: credential.overwrite ?? false };
  } else {
    throw new CredentialError("INVALID_SECRET_REFERENCE", "unsupported credential storage mode");
  }

  const auth: AuthConfig = managedAuth.type === "bearer"
    ? { type: "bearer", secret: secretReference }
    : { type: managedAuth.type, name: managedAuth.name, secret: secretReference };
  const nextProfile = upsertProvider(profile, { ...providerFields, auth });
  const validation = validateProfile(nextProfile);
  if (!validation.valid) {
    throw new ProfileValidationError(
      validation.diagnostics,
      "refusing to store a credential for an invalid profile",
    );
  }

  let pendingVaultWrite: PendingVaultWrite | undefined;
  if (credentialRef && vaultWrite) {
    const config = nextProfile.providers.find((entry) => entry.config.id === input.id)!.config;
    const binding = credentialBindingForProvider(config);
    if (!binding) {
      throw new CredentialError("INVALID_SECRET_REFERENCE", "credential binding is missing");
    }
    pendingVaultWrite = {
      ref: credentialRef,
      secret: vaultWrite.secret,
      binding,
      overwrite: vaultWrite.overwrite,
    };
  }

  return {
    profile: nextProfile,
    ...(credentialRef ? { credentialRef } : {}),
    ...(pendingVaultWrite ? { vaultWrite: pendingVaultWrite } : {}),
    warnings,
  };
}

export function removeProvider(profile: LappProfile, providerId: string): LappProfile {
  const referenced = Object.entries(profile.global?.defaults ?? {})
    .find(([, ref]) => "providerId" in ref && ref.providerId === providerId);
  if (referenced) throw new Error(`provider is referenced by default "${referenced[0]}"`);
  const next = clone(profile);
  next.providers = next.providers.filter((entry) => entry.config.id !== providerId);
  return next;
}

/** Add or patch a model. Omitted fields are preserved on updates. */
export function upsertModel(profile: LappProfile, input: ModelInput): LappProfile {
  if (!isValidModelId(input.id)) throw new Error(`invalid model id: ${input.id}`);
  const next = clone(profile);
  const provider = requireProvider(next, input.providerId);
  const models = provider.models;
  const index = models.models.findIndex((entry) => entry.id === input.id);
  const existing = index >= 0 ? models.models[index]! : undefined;
  const entry: ModelEntry = {
    ...(existing ?? {}),
    id: input.id,
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.aliases !== undefined ? { aliases: [...input.aliases] } : {}),
    ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
    ...(input.protocols !== undefined ? { protocols: [...input.protocols] } : {}),
    ...(input.type !== undefined ? { type: input.type } : {}),
    ...(input.inputModalities !== undefined ? { inputModalities: [...input.inputModalities] } : {}),
    ...(input.outputModalities !== undefined ? { outputModalities: [...input.outputModalities] } : {}),
    ...(input.capabilities !== undefined ? { capabilities: [...input.capabilities] } : {}),
    ...(input.contextWindow !== undefined ? { contextWindow: input.contextWindow } : {}),
    ...(input.maxOutputTokens !== undefined ? { maxOutputTokens: input.maxOutputTokens } : {}),
    ...(input.extensions !== undefined ? { extensions: structuredClone(input.extensions) } : {}),
  };
  if (index >= 0) models.models[index] = entry;
  else models.models.push(entry);
  provider.models = models;
  return next;
}

export function removeModel(profile: LappProfile, target: ModelTarget): LappProfile {
  const modelId = canonicalModelId(profile, target);
  const referenced = Object.entries(profile.global?.defaults ?? {}).find(
    ([, ref]) => "providerId" in ref && ref.providerId === target.providerId && ref.modelId === modelId,
  );
  if (referenced) throw new Error(`model is referenced by default "${referenced[0]}"`);
  const next = clone(profile);
  const provider = requireProvider(next, target.providerId);
  provider.models.models = provider.models.models.filter((entry) => entry.id !== modelId);
  return next;
}

/** Add or replace one portable LAPP 1.1 Auth source and its model document. */
export function upsertAuthSource(profile: LappProfile, input: AuthSourceInput): LappProfile {
  if (!isValidProviderId(input.id)) throw new Error(`invalid auth id: ${input.id}`);
  const next = clone(profile);
  // Auth is a LAPP 1.1 registry feature. Upgrade (or create) global.json in
  // the same proposed profile so the subsequent atomic writer commits the
  // global and auth files together. Provider-only defaults preserve their
  // frozen 1.0 meaning inside the additive 1.1 document.
  if (!next.global) {
    next.global = { schemaVersion: "1.1", defaults: {} };
  } else if (next.global.schemaVersion === "1.0") {
    next.global = {
      schemaVersion: "1.1",
      defaults: structuredClone(next.global.defaults),
      ...(next.global.extensions ? { extensions: structuredClone(next.global.extensions) } : {}),
    };
  }
  next.auth ??= [];
  const index = next.auth.findIndex((entry) => entry.config.id === input.id);
  const existing = index >= 0 ? next.auth[index]! : undefined;
  const source: AuthSource = {
    config: {
      ...(existing?.config ?? {}),
      schemaVersion: "1.1",
      id: input.id,
      driver: input.driver,
      protocols: [...input.protocols],
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      ...(input.config !== undefined ? { config: structuredClone(input.config) } : {}),
      ...(input.extensions !== undefined ? { extensions: structuredClone(input.extensions) } : {}),
    },
    models: input.models !== undefined
      ? { schemaVersion: "1.0", models: structuredClone(input.models) }
      : existing?.models ?? { schemaVersion: "1.0", models: [] },
  };
  if (index >= 0) next.auth[index] = source;
  else next.auth.push(source);
  return next;
}

export function removeAuthSource(profile: LappProfile, authId: string): LappProfile {
  const referenced = Object.entries(profile.global?.defaults ?? {})
    .find(([, ref]) => "authId" in ref && ref.authId === authId);
  if (referenced) throw new Error(`auth source is referenced by default "${referenced[0]}"`);
  const next = clone(profile);
  if (next.auth) next.auth = next.auth.filter((entry) => entry.config.id !== authId);
  return next;
}

export function setAuthDefault(
  profile: LappProfile,
  task: string,
  target: AuthModelTarget,
): LappProfile {
  const source = profile.auth?.find((entry) => entry.config.id === target.authId);
  if (!source) {
    throw new TargetResolutionError(`auth source not found: ${target.authId}`, "AUTH_NOT_FOUND");
  }
  if (source.config.enabled === false) {
    throw new TargetResolutionError(`auth source is disabled: ${target.authId}`, "AUTH_DISABLED");
  }
  const matches = source.models.models.filter(
    (model) => model.id === target.modelId || model.aliases?.includes(target.modelId),
  );
  if (matches.length !== 1) {
    throw new TargetResolutionError(
      `model ${matches.length === 0 ? "not found" : "is ambiguous"}: ${target.authId}/${target.modelId}`,
      matches.length === 0 ? "AUTH_MODEL_NOT_FOUND" : "MODEL_AMBIGUOUS",
    );
  }
  const model = matches[0]!;
  if (model.enabled === false) {
    throw new TargetResolutionError(`model is disabled: ${target.authId}/${model.id}`, "MODEL_DISABLED");
  }
  const next = clone(profile);
  if (!next.global) {
    next.global = { schemaVersion: "1.1", defaults: {} };
  } else if (next.global.schemaVersion === "1.0") {
    next.global = {
      schemaVersion: "1.1",
      defaults: structuredClone(next.global.defaults),
      ...(next.global.extensions ? { extensions: structuredClone(next.global.extensions) } : {}),
    };
  }
  next.global.defaults[task] = { authId: target.authId, modelId: model.id };
  return next;
}

export function setDefault(
  profile: LappProfile,
  task: string,
  target: ModelTarget,
): LappProfile {
  const modelId = canonicalModelId(profile, target);
  const provider = requireProvider(profile, target.providerId);
  const model = provider.models.models.find((entry) => entry.id === modelId)!;
  if (provider.config.enabled === false) {
    throw new TargetResolutionError(`provider is disabled: ${target.providerId}`, "PROVIDER_DISABLED");
  }
  if (model.enabled === false) {
    throw new TargetResolutionError(`model is disabled: ${target.providerId}/${modelId}`, "MODEL_DISABLED");
  }
  const next = clone(profile);
  next.global ??= { schemaVersion: "1.0", defaults: {} };
  next.global.defaults[task] = { providerId: target.providerId, modelId };
  return next;
}
