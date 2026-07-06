/**
 * Core types for LAPP profiles.
 *
 * These values mirror the JSON Schemas in `../lapp/schema/*.schema.json` and
 * the field semantics in `../lapp/spec.en.md`. Unknown fields are intentionally
 * preserved (extra fields map into `metadata`) rather than dropped, because the
 * LAPP spec requires applications to tolerate unknown fields for forward
 * compatibility.
 */

export type Protocol = string;

export type SecretScheme = "plaintext" | "env" | "keychain" | "file" | "unknown";

/** A parsed secret reference. */
export interface SecretRef {
  /** Raw value as written in the profile. */
  raw: string;
  scheme: SecretScheme;
  /** For `env://NAME`, `keychain://namespace/item`, `file://path`: the part after `://`. */
  reference?: string;
  /** True for plain strings (no `scheme://` prefix). */
  plaintext: boolean;
}

export interface AuthConfig {
  /** Optional auth type, e.g. `bearer`. Missing defaults to bearer. */
  type?: string;
  /** Secret string or reference (`plaintext`, `env://NAME`, `keychain://`, `file://`). */
  secret?: string;
  /** Optional custom header name carrying the credential. */
  header?: string;
  /** Optional query param name carrying the credential. */
  queryParam?: string;
  [extra: string]: unknown;
}

export interface LinkMap {
  [name: string]: string;
}

export interface ProviderConfig {
  schemaVersion?: string;
  id: string;
  name?: string;
  enabled?: boolean;
  protocol: Protocol;
  baseUrl: string;
  links?: LinkMap;
  auth?: AuthConfig;
  requestHeaders?: Record<string, string>;
  /** Absolute path of the source provider.json/jsonc file. */
  __file?: string;
  /** Directory name under `providers/`. */
  __dirName?: string;
  [extra: string]: unknown;
}

export interface ModelEntry {
  id: string;
  source?: "provider" | "manual";
  name?: string;
  aliases?: string[];
  type?: string;
  inputModalities?: string[];
  outputModalities?: string[];
  capabilities?: string[];
  contextWindow?: number;
  maxOutputTokens?: number;
  enabled?: boolean;
  protocol?: Protocol;
  links?: LinkMap;
  metadata?: Record<string, unknown>;
  [extra: string]: unknown;
}

export interface ModelsConfig {
  schemaVersion?: string;
  updatedAt?: string;
  models: ModelEntry[];
  [extra: string]: unknown;
}

export interface ModelRef {
  providerId: string;
  /** Always a string; LAPP does not parse `/` inside model IDs. */
  model: string;
  [extra: string]: unknown;
}

export interface GlobalConfig {
  schemaVersion?: string;
  defaultModel?: ModelRef;
  defaultEmbeddingModel?: ModelRef;
  defaultImageModel?: ModelRef;
  defaultTextToSpeechModel?: ModelRef;
  defaultVideoModel?: ModelRef;
  [extra: string]: unknown;
}

export interface ManifestConfig {
  schemaVersion?: string;
  name?: string;
  createdAt?: string;
  updatedAt?: string;
  license?: string;
  [extra: string]: unknown;
}

/** A fully-loaded LAPP profile, normalized from disk. */
export interface LappProfile {
  /** Absolute root directory of the `.lapp` tree. */
  rootDir: string;
  manifest?: ManifestConfig;
  global?: GlobalConfig;
  providers: LappProvider[];
  /** Diagnostics collected during read (warnings about non-core protocols, etc.). */
  diagnostics: Diagnostic[];
}

export interface LappProvider {
  config: ProviderConfig;
  /** Null when the provider has no models.json/jsonc. */
  models: ModelsConfig | null;
  /** Absolute directory path under `providers/`. */
  dir: string;
}

export type DiagnosticLevel = "ERROR" | "WARN" | "INFO";

export interface Diagnostic {
  level: DiagnosticLevel;
  /** File-relative location, e.g. `providers/deepseek/provider.json#auth`. */
  location?: string;
  message: string;
}

/** Result of validation. */
export interface ValidationResult {
  valid: boolean;
  diagnostics: Diagnostic[];
  errors: number;
  warnings: number;
  infos: number;
}

/** Lightweight summary for inspection, secrets redacted by default. */
export interface ProfileSummary {
  rootDir: string;
  providers: Array<{
    id: string;
    name?: string;
    enabled: boolean;
    protocol: Protocol;
    baseUrl: string;
    coreProtocol: boolean;
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

export interface SecretSummary {
  scheme: SecretScheme;
  /** Redacted placeholder; never the resolved secret. */
  redacted: string;
  /** True when the scheme is supported for runtime resolution in v1. */
  resolvable: boolean;
  /** Whether the secret is a plain string (warned about by the validator). */
  plaintextWarning: boolean;
}

/** File-level change plan produced by `planChanges`. */
export interface ChangePlan {
  changes: Array<
    | { kind: "create"; path: string }
    | { kind: "modify"; path: string }
    | { kind: "delete"; path: string }
  >;
}

/** Error thrown when a runtime secret scheme is not supported for resolution. */
export class UnsupportedSecretSchemeError extends Error {
  override name = "UnsupportedSecretSchemeError";
  constructor(public scheme: SecretScheme, message?: string) {
    super(message ?? `unsupported secret scheme: ${scheme}`);
    this.name = "UnsupportedSecretSchemeError";
  }
}

/** Error thrown when a protocol adapter is not supported. */
export class UnsupportedProtocolError extends Error {
  override name = "UnsupportedProtocolError";
  constructor(public protocol: string, message?: string) {
    super(message ?? `unsupported protocol: ${protocol}`);
    this.name = "UnsupportedProtocolError";
  }
}

/** Error thrown when resolving `env://NAME` and the variable is missing. */
export class MissingEnvSecretError extends Error {
  override name = "MissingEnvSecretError";
  readonly envName: string;
  constructor(envName: string, message?: string) {
    super(message ?? `missing environment variable: ${envName}`);
    this.name = "MissingEnvSecretError";
    this.envName = envName;
  }
}

/** Error thrown when target resolution cannot find a provider/model. */
export class TargetResolutionError extends Error {
  override name = "TargetResolutionError";
  constructor(message: string) {
    super(message);
    this.name = "TargetResolutionError";
  }
}