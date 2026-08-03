/** Public LAPP v1 profile and SDK types. */

export type SchemaVersion = "1.0";
export type RegistrySchemaVersion = "1.1";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type Extensions = Record<string, JsonValue>;

export type AuthConfig =
  | { type: "none" }
  | { type: "bearer"; secret: string }
  | { type: "header"; name: string; secret: string }
  | { type: "query"; name: string; secret: string };

export type ResolvedAuth = AuthConfig;

export interface ModelDiscoveryConfig {
  protocol: "openai-models" | "anthropic-models";
  url: string;
}

export interface ProviderConfig {
  schemaVersion: SchemaVersion;
  id: string;
  name?: string;
  /** Opaque provider-family metadata. Runtime protocol selection ignores it. */
  providerType?: string;
  enabled?: boolean;
  baseUrl: string;
  protocols: string[];
  auth: AuthConfig;
  requestHeaders?: Record<string, string>;
  modelDiscovery?: ModelDiscoveryConfig;
  extensions?: Extensions;
}

export interface ModelEntry {
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

export interface ModelsConfig {
  schemaVersion: SchemaVersion;
  models: ModelEntry[];
  extensions?: Extensions;
}

/** Provider-only reference retained for the LAPP 1.0 API surface. */
export interface ModelRef {
  providerId: string;
  modelId: string;
}

export type ProviderModelRef = ModelRef;

/** A model made available by a subscription/session-backed Auth source. */
export interface AuthModelRef {
  authId: string;
  modelId: string;
}

/** LAPP 1.1 model reference. Exactly one source discriminator is present. */
export type RegistryModelRef = ProviderModelRef | AuthModelRef;

export interface AuthSourceConfig {
  schemaVersion: RegistrySchemaVersion;
  id: string;
  name?: string;
  driver: string;
  enabled?: boolean;
  protocols: string[];
  /** Non-secret, driver-specific options. Token material never belongs here. */
  config?: Record<string, JsonValue>;
  extensions?: Extensions;
}

export interface AuthSource {
  config: AuthSourceConfig;
  /** Auth sources reuse the canonical 1.0 models document. */
  models: ModelsConfig;
}

export interface ProviderGlobalConfig {
  schemaVersion: SchemaVersion;
  defaults: Record<string, ProviderModelRef>;
  extensions?: Extensions;
}

export interface RegistryGlobalConfig {
  schemaVersion: RegistrySchemaVersion;
  defaults: Record<string, RegistryModelRef>;
  extensions?: Extensions;
}

export type GlobalConfig = ProviderGlobalConfig | RegistryGlobalConfig;

/** A validated, normalized LAPP profile. */
export interface LappProfile {
  global?: GlobalConfig;
  providers: LappProvider[];
  /** Optional for source compatibility with provider-only LAPP 1.0 objects. */
  auth?: AuthSource[];
}

/** A normalized LAPP 1.1 registry snapshot. */
export type LappRegistry = Omit<LappProfile, "auth"> & { auth: AuthSource[] };

export interface LappProvider {
  config: ProviderConfig;
  models: ModelsConfig;
}

export type DiagnosticLevel = "ERROR" | "WARN" | "INFO";

export interface Diagnostic {
  level: DiagnosticLevel;
  /** Stable machine-readable code when the diagnostic defines one. */
  code?: string;
  location?: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  diagnostics: Diagnostic[];
  errors: number;
  warnings: number;
  infos: number;
}

export type SecretScheme = "plaintext" | "env" | "vault" | "unknown";

export interface SecretRef {
  raw: string;
  scheme: SecretScheme;
  reference?: string;
  plaintext: boolean;
}

export interface SecretSummary {
  scheme: SecretScheme;
  redacted: string;
  resolvable: boolean;
  plaintextWarning: boolean;
}

export interface ProfileInspection {
  rootDir: string;
  providers: Array<{
    id: string;
    name?: string;
    providerType?: string;
    enabled: boolean;
    protocols: string[];
    baseUrl?: string;
    secret: SecretSummary;
    modelCount: number;
    models: Array<{
      id: string;
      name?: string;
      aliases?: string[];
      type?: string;
      enabled: boolean;
    }>;
  }>;
  auth?: Array<{
    id: string;
    name?: string;
    driver: string;
    enabled: boolean;
    protocols: string[];
    modelCount: number;
  }>;
  global?: GlobalConfig;
  diagnostics: Diagnostic[];
}

export interface ChangePlan {
  changes: Array<
    | { kind: "create"; path: string }
    | { kind: "modify"; path: string }
    | { kind: "delete"; path: string }
  >;
}

export type ModelSelector =
  | { providerId: string; model: string }
  | { default: string };

export interface ModelDescriptor {
  providerId: string;
  providerName?: string;
  providerType?: string;
  providerEnabled: boolean;
  modelId: string;
  modelName?: string;
  modelEnabled: boolean;
  protocols: string[];
  baseUrl: string;
  aliases?: string[];
  type?: string;
  inputModalities?: string[];
  outputModalities?: string[];
  capabilities?: string[];
  contextWindow?: number;
  maxOutputTokens?: number;
  extensions?: Extensions;
}

export interface AuthModelDescriptor {
  authId: string;
  authName?: string;
  driver: string;
  authEnabled: boolean;
  modelId: string;
  modelName?: string;
  modelEnabled: boolean;
  protocols: string[];
  aliases?: string[];
  type?: string;
  inputModalities?: string[];
  outputModalities?: string[];
  capabilities?: string[];
  contextWindow?: number;
  maxOutputTokens?: number;
  extensions?: Extensions;
}

export type RegistryModelDescriptor =
  | ({ source: "provider" } & ModelDescriptor)
  | ({ source: "auth" } & AuthModelDescriptor);

export type RegistryModelSelector = RegistryModelRef | { default: string };

export type ResolvedModelTarget =
  | {
    source: "provider";
    ref: ProviderModelRef;
    connection: ConnectionPlan;
  }
  | {
    source: "auth";
    ref: AuthModelRef;
    authId: string;
    driver: string;
    modelId: string;
    protocol: string;
    config: Record<string, JsonValue>;
  };

/** OS-vault payload for one subscription/session-backed Auth source. */
export interface AuthEnvelopeV1 {
  version: 1;
  authId: string;
  driver: string;
  /** Digest of the portable auth.json definition this grant was issued for. */
  configDigest: string;
  /** Monotonic whole-envelope replacement generation. */
  generation: number;
  /** Opaque, driver-defined JSON credentials. Never interpreted by the registry layer. */
  credentials: Record<string, JsonValue>;
}

export interface AuthTokenStatus {
  authId: string;
  exists: boolean;
  driver?: string;
  expiresAt?: string;
  expired?: boolean;
}

export interface AuthTokenStore {
  read(authId: string, options?: { signal?: AbortSignal }): Promise<AuthEnvelopeV1 | undefined>;
  write(envelope: AuthEnvelopeV1, options?: { signal?: AbortSignal }): Promise<void>;
  status(authId: string, options?: { signal?: AbortSignal }): Promise<AuthTokenStatus>;
  delete(authId: string, options?: { signal?: AbortSignal }): Promise<boolean>;
}

export type AuthErrorCode =
  | "AUTH_NOT_FOUND"
  | "AUTH_DISABLED"
  | "AUTH_MODEL_NOT_FOUND"
  | "AUTH_DRIVER_NOT_SUPPORTED"
  | "AUTH_LOGIN_REQUIRED"
  | "AUTH_CONFIG_CHANGED"
  | "AUTH_TOKEN_STORE_ERROR"
  | "AUTH_SOURCE_NOT_FOUND"
  | "AUTH_SOURCE_DISABLED"
  | "AUTH_DRIVER_NOT_FOUND"
  | "AUTH_NOT_LOGGED_IN"
  | "AUTH_RECORD_INVALID"
  | "AUTH_DRIVER_MISMATCH"
  | "AUTH_BACKEND_UNAVAILABLE"
  | "AUTH_ACCESS_DENIED"
  | "AUTH_OPERATION_FAILED"
  | "AUTH_LOGIN_FAILED"
  | "AUTH_REFRESH_FAILED"
  | "AUTH_HTTP_ERROR"
  | "AUTH_LOCKED"
  | "AUTH_LOCK_INVALID"
  | "AUTH_OPERATION_UNSUPPORTED";

/** Deliberately redacted Auth/session failure. */
export class AuthError extends Error {
  override name = "AuthError";
  constructor(
    public readonly code: AuthErrorCode,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
  }
}

export type CredentialAuthBinding =
  | { type: "bearer" }
  | { type: "header"; name: string }
  | { type: "query"; name: string };

/** Security-relevant provider properties bound into a Vault record. */
export interface CredentialBinding {
  providerId: string;
  /** Normalized URL origin, without a path, query, fragment, or credentials. */
  origin: string;
  auth: CredentialAuthBinding;
}

export interface VaultEnvelopeV1 {
  version: 1;
  providerId: string;
  credentialId: string;
  origin: string;
  auth: CredentialAuthBinding;
  secret: string;
}

export type CredentialErrorCode =
  | "INVALID_SECRET_REFERENCE"
  | "UNSUPPORTED_SECRET_SCHEME"
  | "ENV_SECRET_MISSING"
  | "VAULT_BACKEND_UNAVAILABLE"
  | "VAULT_CREDENTIAL_NOT_FOUND"
  | "VAULT_CREDENTIAL_EXISTS"
  | "VAULT_RECORD_INVALID"
  | "VAULT_BINDING_MISMATCH"
  | "VAULT_ACCESS_DENIED"
  | "VAULT_OPERATION_FAILED"
  | "CREDENTIAL_UPDATE_PARTIAL_FAILURE";

export interface PartialFailureCause {
  code: "PROFILE_UPDATE_PARTIAL_FAILURE";
  message: string;
}

/** A deliberately redacted credential failure. Native error text is never exposed. */
export class CredentialError extends Error {
  override name = "CredentialError";
  constructor(
    public readonly code: CredentialErrorCode,
    message: string,
    public readonly causes: readonly PartialFailureCause[] = [],
  ) {
    super(message);
  }
}

export interface VaultCredentialStatus {
  reference: string;
  exists: boolean;
  bindingMatches?: boolean;
}

export interface CredentialStatus {
  scheme: Exclude<SecretScheme, "unknown">;
  available: boolean;
  bindingMatches?: boolean;
}

export interface VaultPutOptions {
  overwrite?: boolean;
  signal?: AbortSignal;
}

export interface CredentialVault {
  put(
    reference: string,
    secret: string,
    binding: CredentialBinding,
    options?: VaultPutOptions,
  ): Promise<void>;
  resolve(
    reference: string,
    expectedBinding: CredentialBinding,
    options?: { signal?: AbortSignal },
  ): Promise<string>;
  status(
    reference: string,
    expectedBinding: CredentialBinding,
    options?: { signal?: AbortSignal },
  ): Promise<VaultCredentialStatus>;
  delete(reference: string, options?: { signal?: AbortSignal }): Promise<boolean>;
}

export interface CredentialResolver {
  resolve(raw: string, binding: CredentialBinding): Promise<string>;
  status(raw: string, binding: CredentialBinding): Promise<CredentialStatus>;
}

/** Target selection result that has not resolved a credential. */
export interface ConnectionPlan {
  providerId: string;
  modelId: string;
  protocol: string;
  baseUrl: string;
  requestHeaders: Record<string, string>;
  auth: AuthConfig;
  credentialBinding?: CredentialBinding;
}

export interface ResolvedConnection {
  providerId: string;
  modelId: string;
  protocol: string;
  baseUrl: string;
  requestHeaders: Record<string, string>;
  auth: ResolvedAuth;
}

export class ProfileValidationError extends Error {
  override name = "ProfileValidationError";
  constructor(public readonly diagnostics: Diagnostic[], message = "invalid LAPP profile") {
    super(message);
  }
}

export class MissingEnvSecretError extends CredentialError {
  override name = "MissingEnvSecretError";
  constructor(public readonly envName: string, message?: string) {
    super("ENV_SECRET_MISSING", message ?? `missing environment variable: ${envName}`);
  }
}

export type TargetResolutionErrorCode =
  | "PROVIDER_NOT_FOUND"
  | "PROVIDER_DISABLED"
  | "MODEL_NOT_FOUND"
  | "MODEL_DISABLED"
  | "MODEL_AMBIGUOUS"
  | "DEFAULT_NOT_FOUND"
  | "PROTOCOL_NOT_SUPPORTED"
  | "AUTH_SOURCE_NOT_FOUND"
  | "AUTH_SOURCE_DISABLED"
  | "AUTH_NOT_FOUND"
  | "AUTH_DISABLED"
  | "AUTH_MODEL_NOT_FOUND";

export class TargetResolutionError extends Error {
  override name = "TargetResolutionError";
  constructor(
    message: string,
    public readonly code: TargetResolutionErrorCode = "MODEL_NOT_FOUND",
  ) {
    super(message);
  }
}

export class ModelRefreshError extends Error {
  override name = "ModelRefreshError";
  constructor(
    message: string,
    public readonly code:
      | "DISCOVERY_NOT_CONFIGURED"
      | "INVALID_RESPONSE"
      | "HTTP_ERROR"
      | "PAGINATION_ERROR" = "INVALID_RESPONSE",
  ) {
    super(message);
  }
}
