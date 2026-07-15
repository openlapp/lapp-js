import {
  createCredentialResolver,
  credentialBindingForProvider,
  resolveAuthConfig,
} from "./secret/index.js";
import {
  ProfileValidationError,
  TargetResolutionError,
  type ConnectionPlan,
  type CredentialResolver,
  type CredentialVault,
  type LappProfile,
  type LappProvider,
  type ModelDescriptor,
  type ModelEntry,
  type ModelSelector,
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
  return { providerId: ref.providerId, model: ref.modelId };
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
  ConnectionPlan,
  ModelDescriptor,
  ModelSelector,
  ResolvedConnection,
} from "./types.js";
