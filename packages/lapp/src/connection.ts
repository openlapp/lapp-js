import {
  createCredentialResolver,
  credentialBindingForProvider,
  resolveAuthConfig,
} from "./secret/index.js";
import {
  ProfileValidationError,
  TargetResolutionError,
  type ConnectionPlan,
  type AuthModelDescriptor,
  type CredentialResolver,
  type CredentialVault,
  type LappProfile,
  type LappProvider,
  type ModelDescriptor,
  type ModelEntry,
  type ModelSelector,
  type RegistryModelDescriptor,
  type RegistryModelRef,
  type RegistryModelSelector,
  type ResolvedModelTarget,
  type ResolvedConnection,
} from "./types.js";
import { validateProfile } from "./validate/index.js";

export interface ListModelsOptions {
  providerId?: string;
  /** Include disabled providers and models. */
  includeDisabled?: boolean;
}

function descriptor(provider: LappProvider, model: ModelEntry): ModelDescriptor {
  return {
    providerId: provider.config.id,
    ...(provider.config.name !== undefined ? { providerName: provider.config.name } : {}),
    ...(provider.config.providerType !== undefined
      ? { providerType: provider.config.providerType }
      : {}),
    providerEnabled: provider.config.enabled !== false,
    modelId: model.id,
    ...(model.name !== undefined ? { modelName: model.name } : {}),
    modelEnabled: model.enabled !== false,
    protocols: [...(model.protocols ?? provider.config.protocols)],
    baseUrl: provider.config.baseUrl,
    ...(model.aliases !== undefined ? { aliases: [...model.aliases] } : {}),
    ...(model.type !== undefined ? { type: model.type } : {}),
    ...(model.inputModalities !== undefined ? { inputModalities: [...model.inputModalities] } : {}),
    ...(model.outputModalities !== undefined ? { outputModalities: [...model.outputModalities] } : {}),
    ...(model.capabilities !== undefined ? { capabilities: [...model.capabilities] } : {}),
    ...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
    ...(model.maxOutputTokens !== undefined ? { maxOutputTokens: model.maxOutputTokens } : {}),
    ...(model.extensions !== undefined ? { extensions: structuredClone(model.extensions) } : {}),
  };
}

/** Pure in-memory model listing. It never resolves secrets or performs I/O. */
export function listModels(
  profile: LappProfile,
  options: ListModelsOptions = {},
): ModelDescriptor[] {
  const includeDisabled = options.includeDisabled ?? false;
  const result: ModelDescriptor[] = [];
  for (const provider of profile.providers) {
    if (options.providerId !== undefined && provider.config.id !== options.providerId) continue;
    if (!includeDisabled && provider.config.enabled === false) continue;
    for (const model of provider.models.models) {
      if (!includeDisabled && model.enabled === false) continue;
      result.push(descriptor(provider, model));
    }
  }
  return result;
}

export interface ResolveConnectionOptions {
  supportedProtocols?: readonly string[];
  env?: Record<string, string | undefined>;
  vault?: CredentialVault;
  resolver?: CredentialResolver;
}

export interface SelectConnectionOptions {
  supportedProtocols?: readonly string[];
}

function resolveSelector(profile: LappProfile, selector: ModelSelector): { providerId: string; model: string } {
  if ("providerId" in selector) return selector;
  const ref = profile.global?.defaults[selector.default];
  if (!ref) {
    throw new TargetResolutionError(
      `default not found: ${selector.default}`,
      "DEFAULT_NOT_FOUND",
    );
  }
  if ("authId" in ref) {
    throw new TargetResolutionError(
      `default targets an auth source: ${selector.default}`,
      "AUTH_NOT_FOUND",
    );
  }
  return { providerId: ref.providerId, model: ref.modelId };
}

export interface ListModelTargetsOptions {
  providerId?: string;
  authId?: string;
  includeDisabled?: boolean;
}

function authDescriptor(
  source: NonNullable<LappProfile["auth"]>[number],
  model: ModelEntry,
): AuthModelDescriptor {
  return {
    authId: source.config.id,
    ...(source.config.name !== undefined ? { authName: source.config.name } : {}),
    driver: source.config.driver,
    authEnabled: source.config.enabled !== false,
    modelId: model.id,
    ...(model.name !== undefined ? { modelName: model.name } : {}),
    modelEnabled: model.enabled !== false,
    protocols: [...(model.protocols ?? source.config.protocols)],
    ...(model.aliases !== undefined ? { aliases: [...model.aliases] } : {}),
    ...(model.type !== undefined ? { type: model.type } : {}),
    ...(model.inputModalities !== undefined ? { inputModalities: [...model.inputModalities] } : {}),
    ...(model.outputModalities !== undefined ? { outputModalities: [...model.outputModalities] } : {}),
    ...(model.capabilities !== undefined ? { capabilities: [...model.capabilities] } : {}),
    ...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
    ...(model.maxOutputTokens !== undefined ? { maxOutputTokens: model.maxOutputTokens } : {}),
    ...(model.extensions !== undefined ? { extensions: structuredClone(model.extensions) } : {}),
  };
}

/** Pure in-memory enumeration across Provider and Auth model sources. */
export function listModelTargets(
  profile: LappProfile,
  options: ListModelTargetsOptions = {},
): RegistryModelDescriptor[] {
  const includeDisabled = options.includeDisabled ?? false;
  const providers = options.authId === undefined
    ? listModels(profile, {
      ...(options.providerId ? { providerId: options.providerId } : {}),
      includeDisabled,
    }).map((entry): RegistryModelDescriptor => ({ source: "provider", ...entry }))
    : [];
  const auth: RegistryModelDescriptor[] = [];
  for (const source of options.providerId === undefined ? profile.auth ?? [] : []) {
    if (options.authId !== undefined && source.config.id !== options.authId) continue;
    if (!includeDisabled && source.config.enabled === false) continue;
    for (const model of source.models.models) {
      if (!includeDisabled && model.enabled === false) continue;
      auth.push({ source: "auth", ...authDescriptor(source, model) });
    }
  }
  return [...providers, ...auth];
}

function registryRef(profile: LappProfile, selector: RegistryModelSelector): RegistryModelRef {
  const keys = Object.keys(selector);
  if ("default" in selector) {
    if (keys.length !== 1 || typeof selector.default !== "string") {
      throw new TypeError("registry default selector must contain only default");
    }
  } else {
    const provider = "providerId" in selector;
    const auth = "authId" in selector;
    const expected = provider ? ["modelId", "providerId"] : ["authId", "modelId"];
    if (
      provider === auth
      || keys.length !== 2
      || keys.slice().sort().some((key, index) => key !== expected[index])
    ) {
      throw new TypeError("registry model reference must contain exactly one source ID and modelId");
    }
    return selector;
  }
  const ref = profile.global?.defaults[selector.default];
  if (!ref) {
    throw new TargetResolutionError(`default not found: ${selector.default}`, "DEFAULT_NOT_FOUND");
  }
  return ref;
}

/** Resolve a unified target without reading credentials or performing network I/O. */
export function resolveModelTarget(
  profile: LappProfile,
  selector: RegistryModelSelector,
  options: SelectConnectionOptions = {},
): ResolvedModelTarget {
  const ref = registryRef(profile, selector);
  if ("providerId" in ref) {
    const connection = selectConnection(
      profile,
      { providerId: ref.providerId, model: ref.modelId },
      options,
    );
    return {
      source: "provider",
      ref: { providerId: connection.providerId, modelId: connection.modelId },
      connection,
    };
  }
  const validation = validateProfile(profile);
  if (!validation.valid) {
    throw new ProfileValidationError(validation.diagnostics, "cannot resolve a target from an invalid registry");
  }
  const source = profile.auth?.find((entry) => entry.config.id === ref.authId);
  if (!source) {
    throw new TargetResolutionError(`auth source not found: ${ref.authId}`, "AUTH_NOT_FOUND");
  }
  if (source.config.enabled === false) {
    throw new TargetResolutionError(`auth source is disabled: ${ref.authId}`, "AUTH_DISABLED");
  }
  const matches = source.models.models.filter(
    (model) => model.id === ref.modelId || model.aliases?.includes(ref.modelId),
  );
  if (matches.length === 0) {
    throw new TargetResolutionError(`model not found: ${ref.authId}/${ref.modelId}`, "AUTH_MODEL_NOT_FOUND");
  }
  if (matches.length > 1) {
    throw new TargetResolutionError(`model is ambiguous: ${ref.authId}/${ref.modelId}`, "MODEL_AMBIGUOUS");
  }
  const model = matches[0]!;
  if (model.enabled === false) {
    throw new TargetResolutionError(`model is disabled: ${ref.authId}/${model.id}`, "MODEL_DISABLED");
  }
  const candidates = model.protocols ?? source.config.protocols;
  const protocol = options.supportedProtocols === undefined
    ? candidates[0]
    : candidates.find((candidate) => options.supportedProtocols!.includes(candidate));
  if (!protocol) {
    throw new TargetResolutionError(`no supported protocol for ${ref.authId}/${model.id}`, "PROTOCOL_NOT_SUPPORTED");
  }
  return {
    source: "auth",
    ref: { authId: source.config.id, modelId: model.id },
    authId: source.config.id,
    driver: source.config.driver,
    modelId: model.id,
    protocol,
    config: structuredClone(source.config.config ?? {}),
  };
}

export function selectConnection(
  profile: LappProfile,
  selector: ModelSelector,
  options: SelectConnectionOptions = {},
): ConnectionPlan {
  const validation = validateProfile(profile);
  if (!validation.valid) {
    const detail = validation.diagnostics.find((entry) => entry.level === "ERROR")?.message;
    throw new ProfileValidationError(
      validation.diagnostics,
      `cannot select a connection from an invalid profile${detail ? `: ${detail}` : ""}`,
    );
  }
  const target = resolveSelector(profile, selector);
  const provider = profile.providers.find((entry) => entry.config.id === target.providerId);
  if (!provider) {
    throw new TargetResolutionError(`provider not found: ${target.providerId}`, "PROVIDER_NOT_FOUND");
  }
  if (provider.config.enabled === false) {
    throw new TargetResolutionError(`provider is disabled: ${target.providerId}`, "PROVIDER_DISABLED");
  }

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
  const model = matches[0]!;
  if (model.enabled === false) {
    throw new TargetResolutionError(
      `model is disabled: ${target.providerId}/${model.id}`,
      "MODEL_DISABLED",
    );
  }

  const candidates = model.protocols ?? provider.config.protocols;
  const protocol = options.supportedProtocols === undefined
    ? candidates[0]
    : candidates.find((candidate) => options.supportedProtocols!.includes(candidate));
  if (!protocol) {
    throw new TargetResolutionError(
      `no supported protocol for ${target.providerId}/${model.id}`,
      "PROTOCOL_NOT_SUPPORTED",
    );
  }

  const credentialBinding = credentialBindingForProvider(provider.config);
  return {
    providerId: provider.config.id,
    modelId: model.id,
    protocol,
    baseUrl: provider.config.baseUrl,
    requestHeaders: { ...(provider.config.requestHeaders ?? {}) },
    auth: structuredClone(provider.config.auth),
    ...(credentialBinding ? { credentialBinding } : {}),
  };
}

export async function resolveConnection(
  profile: LappProfile,
  selector: ModelSelector,
  options: ResolveConnectionOptions = {},
): Promise<ResolvedConnection> {
  const plan = selectConnection(profile, selector, options);
  const resolver = options.resolver ?? createCredentialResolver({
    ...(options.env ? { env: options.env } : {}),
    ...(options.vault ? { vault: options.vault } : {}),
  });
  return {
    providerId: plan.providerId,
    modelId: plan.modelId,
    protocol: plan.protocol,
    baseUrl: plan.baseUrl,
    requestHeaders: plan.requestHeaders,
    auth: await resolveAuthConfig(plan.auth, plan.credentialBinding, { resolver }),
  };
}

export type {
  AuthModelDescriptor,
  ConnectionPlan,
  ModelDescriptor,
  ModelSelector,
  RegistryModelDescriptor,
  RegistryModelRef,
  RegistryModelSelector,
  ResolvedModelTarget,
  ResolvedConnection,
} from "./types.js";
