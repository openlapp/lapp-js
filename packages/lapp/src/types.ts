/** Public LAPP v1 profile and SDK types. */

export type SchemaVersion = "1.0";

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

export interface ModelRef {
  providerId: string;
  modelId: string;
}

export interface GlobalConfig {
  schemaVersion: SchemaVersion;
  defaults: Record<string, ModelRef>;
  extensions?: Extensions;
}

/** A validated, normalized LAPP profile. */
export interface LappProfile {
  global?: GlobalConfig;
  providers: LappProvider[];
}

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

/** A deliberately redacted credential failure. Native error text is never exposed. */
export class CredentialError extends Error {
  override name = "CredentialError";
  constructor(
    public readonly code: CredentialErrorCode,
    message: string,
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
  | "PROTOCOL_NOT_SUPPORTED";

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
