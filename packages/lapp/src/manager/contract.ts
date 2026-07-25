import type {
  CredentialErrorCode,
  Diagnostic,
  GlobalConfig,
  ModelDiscoveryConfig,
  ModelEntry,
  ModelSelector,
} from "../types.js";
import type {
  CredentialWarning,
  ManagedProviderInput,
  ModelInput,
  ModelTarget,
} from "../manage/index.js";

/** Version of the structured-clone-safe manager bridge contract. */
export const LAPP_MANAGER_BRIDGE_PROTOCOL_VERSION = 1 as const;

export type ManagerPhase =
  | "idle"
  | "loading"
  | "ready"
  | "saving"
  | "conflict"
  | "error";

export type ManagerFeature =
  | "write-profile"
  | "vault"
  | "test-connection"
  | "refresh-models"
  | "events";

export interface ManagerHandshake {
  protocolVersion: typeof LAPP_MANAGER_BRIDGE_PROTOCOL_VERSION;
  features: ManagerFeature[];
}

export interface ManagerCredentialView {
  scheme: "plaintext" | "env" | "vault";
  /** env:// or vault:// reference. Plaintext values are never returned. */
  reference?: string;
  available: boolean;
  bindingMatches?: boolean;
  plaintextWarning: boolean;
  errorCode?: CredentialErrorCode;
}

export type ManagerAuthView =
  | { type: "none" }
  | { type: "bearer"; credential: ManagerCredentialView }
  | { type: "header"; name: string; credential: ManagerCredentialView }
  | { type: "query"; name: string; credential: ManagerCredentialView };

export interface ManagerProviderView {
  id: string;
  name?: string;
  providerType?: string;
  enabled: boolean;
  baseUrl: string;
  protocols: string[];
  auth: ManagerAuthView;
  requestHeaders?: Record<string, string>;
  modelDiscovery?: ModelDiscoveryConfig;
  models: ModelEntry[];
}

/** Sanitized profile data safe to retain in a renderer. */
export interface ManagerProfileView {
  global?: GlobalConfig;
  providers: ManagerProviderView[];
}

export interface ManagerSnapshot {
  /** Opaque revision. Callers must only compare it for equality. */
  revision: string;
  profile: ManagerProfileView;
  diagnostics: Diagnostic[];
}

export type ManagerOperation =
  | { type: "provider.set"; input: ManagedProviderInput }
  | { type: "provider.delete"; providerId: string }
  | { type: "model.set"; input: ModelInput }
  | { type: "model.delete"; target: ModelTarget }
  | { type: "default.set"; task: string; target: ModelTarget }
  | { type: "default.delete"; task: string }
  | {
      type: "credential.set";
      providerId: string;
      credentialId?: string;
      secret: string;
      overwrite?: boolean;
    }
  | { type: "credential.delete"; providerId: string; credentialId?: string }
  | { type: "models.refresh"; providerId: string };

export interface ManagerTransactionRequest {
  expectedRevision: string;
  operation: ManagerOperation;
}

export interface ManagerTransactionResult {
  revision: string;
  snapshot: ManagerSnapshot;
  warnings: CredentialWarning[];
}

export type ManagerErrorCode =
  | CredentialErrorCode
  | "PROFILE_LOCKED"
  | "PROFILE_LOCK_INVALID"
  | "PROFILE_READ_UNSTABLE"
  | "PROFILE_PATH_INVALID"
  | "PROFILE_CONFLICT"
  | "PROFILE_UPDATE_PARTIAL_FAILURE"
  | "PROFILE_INVALID"
  | "PROFILE_NOT_FOUND"
  | "PROFILE_OPERATION_FAILED"
  | "MANAGER_OPERATION_UNSUPPORTED"
  | "BRIDGE_PROTOCOL_MISMATCH";

/** Serializable, redacted error returned across the host bridge. */
export interface ManagerErrorView {
  code: ManagerErrorCode;
  message: string;
  diagnostics?: Diagnostic[];
  currentRevision?: string;
  causes?: Array<{ code: "PROFILE_UPDATE_PARTIAL_FAILURE"; message: string }>;
}

export type ManagerResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: ManagerErrorView };

export interface ManagerTestConnectionRequest {
  selector: ModelSelector;
}

export interface ManagerTestConnectionView {
  ok: boolean;
  providerId: string;
  modelId: string;
  protocol: string;
  code?: string;
  message?: string;
}

export interface ManagerInvalidatedEvent {
  type: "invalidated";
  revision?: string;
}

/**
 * Narrow host API consumed by renderer integrations. Implementations must not
 * expose raw filesystem, IPC, Vault resolve/export, or arbitrary network APIs.
 */
export interface LappManagerBridgeV1 {
  handshake(): Promise<ManagerResult<ManagerHandshake>>;
  getSnapshot(): Promise<ManagerResult<ManagerSnapshot>>;
  transact(
    request: ManagerTransactionRequest,
  ): Promise<ManagerResult<ManagerTransactionResult>>;
  testConnection(
    request: ManagerTestConnectionRequest,
  ): Promise<ManagerResult<ManagerTestConnectionView>>;
  subscribe?(listener: (event: ManagerInvalidatedEvent) => void): () => void;
}

export type {
  CredentialWarning,
  ManagedProviderInput,
  ModelInput,
  ModelSelector,
  ModelTarget,
};
