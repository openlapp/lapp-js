import type {
  CredentialAuthBinding,
  CredentialBinding,
  CredentialVault,
  ProviderConfig,
  VaultCredentialStatus,
  VaultEnvelopeV1,
  VaultPutOptions,
} from "../types.js";
import { CredentialError } from "../types.js";
import { isValidProviderId } from "../validate/constants.js";

export const LAPP_VAULT_SERVICE = "dev.lapp.vault.v1";
export const VAULT_SECRET_PATTERN = /^vault:\/\/([a-z0-9][a-z0-9._-]{0,63})\/([a-z0-9][a-z0-9._-]{0,63})$/;

export interface VaultReference {
  providerId: string;
  credentialId: string;
}

interface AsyncKeyringEntry {
  setPassword(password: string, signal?: AbortSignal | null): Promise<void>;
  getPassword(signal?: AbortSignal | null): Promise<string | undefined | null>;
  deleteCredential(signal?: AbortSignal | null): Promise<boolean>;
}

interface KeyringModule {
  AsyncEntry: new (service: string, username: string) => AsyncKeyringEntry;
}

function invalidReference(message = "invalid credential reference"): CredentialError {
  return new CredentialError("INVALID_SECRET_REFERENCE", message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

export function parseVaultSecretRef(reference: string): VaultReference {
  const match = VAULT_SECRET_PATTERN.exec(reference);
  if (!match || !isValidProviderId(match[1]!) || !isValidProviderId(match[2]!)) {
    throw invalidReference("invalid vault credential reference");
  }
  return { providerId: match[1]!, credentialId: match[2]! };
}

export function formatVaultSecretRef(providerId: string, credentialId = "default"): string {
  const reference = `vault://${providerId}/${credentialId}`;
  parseVaultSecretRef(reference);
  return reference;
}

/** Normalize a base URL to the exact origin that a credential may be sent to. */
export function normalizeCredentialOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalidReference("provider base URL is invalid");
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:")
    || url.username
    || url.password
    || url.origin === "null"
  ) {
    throw invalidReference("provider base URL cannot be bound to a credential");
  }
  return url.origin;
}

function normalizeAuthBinding(auth: CredentialAuthBinding): CredentialAuthBinding {
  const value = auth as unknown;
  if (!isRecord(value) || typeof value.type !== "string") {
    throw invalidReference("credential authentication binding is invalid");
  }
  if (value.type === "bearer") return { type: "bearer" };
  if (
    (value.type !== "header" && value.type !== "query")
    || typeof value.name !== "string"
    || value.name.length === 0
    || /[\r\n]/.test(value.name)
    || (value.type === "header" && !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(value.name))
  ) {
    throw invalidReference("credential authentication name is invalid");
  }
  return {
    type: value.type,
    name: value.type === "header" ? value.name.toLowerCase() : value.name,
  };
}

function normalizeBinding(binding: CredentialBinding): CredentialBinding {
  const value = binding as unknown;
  if (
    !isRecord(value)
    || typeof value.providerId !== "string"
    || typeof value.origin !== "string"
    || !isRecord(value.auth)
    || !isValidProviderId(value.providerId)
  ) {
    throw invalidReference("credential provider id is invalid");
  }
  return {
    providerId: value.providerId,
    origin: normalizeCredentialOrigin(value.origin),
    auth: normalizeAuthBinding(value.auth as CredentialAuthBinding),
  };
}

/** Build the canonical Vault binding from a final provider configuration. */
export function credentialBindingForProvider(config: ProviderConfig): CredentialBinding | undefined {
  if (config.auth.type === "none") return undefined;
  const auth: CredentialAuthBinding = config.auth.type === "bearer"
    ? { type: "bearer" }
    : { type: config.auth.type, name: config.auth.name };
  return normalizeBinding({
    providerId: config.id,
    origin: normalizeCredentialOrigin(config.baseUrl),
    auth,
  });
}

export function credentialBindingsEqual(
  left: CredentialBinding,
  right: CredentialBinding,
): boolean {
  const a = normalizeBinding(left);
  const b = normalizeBinding(right);
  return a.providerId === b.providerId
    && a.origin === b.origin
    && a.auth.type === b.auth.type
    && (a.auth.type === "bearer"
      || (b.auth.type !== "bearer" && a.auth.name === b.auth.name));
}

/** Refuse to send an already-resolved credential to any other origin. */
export function assertCredentialRequestOrigin(binding: CredentialBinding, requestUrl: string): void {
  const actual = normalizeCredentialOrigin(requestUrl);
  if (actual !== normalizeBinding(binding).origin) {
    throw new CredentialError(
      "VAULT_BINDING_MISMATCH",
      "credential is not authorized for the request origin",
    );
  }
}

function envelopeAuth(value: unknown): CredentialAuthBinding | undefined {
  if (!isRecord(value) || typeof value.type !== "string") return undefined;
  if (value.type === "bearer" && hasExactKeys(value, ["type"])) return { type: "bearer" };
  if (
    (value.type === "header" || value.type === "query")
    && typeof value.name === "string"
    && hasExactKeys(value, ["type", "name"])
  ) {
    return { type: value.type, name: value.name };
  }
  return undefined;
}

function parseEnvelope(raw: string, reference: VaultReference): VaultEnvelopeV1 {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new CredentialError("VAULT_RECORD_INVALID", "vault credential record is invalid");
  }
  if (
    !isRecord(value)
    || !hasExactKeys(value, ["version", "providerId", "credentialId", "origin", "auth", "secret"])
    || value.version !== 1
    || value.providerId !== reference.providerId
    || value.credentialId !== reference.credentialId
    || typeof value.origin !== "string"
    || typeof value.secret !== "string"
    || value.secret.length === 0
    || /[\r\n]/.test(value.secret)
  ) {
    throw new CredentialError("VAULT_RECORD_INVALID", "vault credential record is invalid");
  }
  const auth = envelopeAuth(value.auth);
  if (!auth) {
    throw new CredentialError("VAULT_RECORD_INVALID", "vault credential record is invalid");
  }
  let normalized: CredentialBinding;
  try {
    normalized = normalizeBinding({
      providerId: value.providerId,
      origin: value.origin,
      auth,
    });
  } catch {
    throw new CredentialError("VAULT_RECORD_INVALID", "vault credential record is invalid");
  }
  if (
    normalized.origin !== value.origin
    || normalized.auth.type !== auth.type
    || (
      normalized.auth.type !== "bearer"
      && auth.type !== "bearer"
      && normalized.auth.name !== auth.name
    )
  ) {
    throw new CredentialError("VAULT_RECORD_INVALID", "vault credential record is invalid");
  }
  return {
    version: 1,
    providerId: value.providerId,
    credentialId: value.credentialId,
    origin: value.origin,
    auth,
    secret: value.secret,
  };
}

function envelopeBinding(envelope: VaultEnvelopeV1): CredentialBinding {
  return {
    providerId: envelope.providerId,
    origin: envelope.origin,
    auth: envelope.auth,
  };
}

function nativeText(error: unknown): string {
  if (error instanceof Error) return `${error.name} ${error.message}`;
  return typeof error === "string" ? error : "";
}

function isNativeMissing(error: unknown): boolean {
  return /no\s*entry|not\s*found|credential.*missing/i.test(nativeText(error));
}

function mapNativeError(error: unknown): CredentialError {
  const text = nativeText(error);
  if (/access|denied|permission|unauthori[sz]ed/i.test(text)) {
    return new CredentialError("VAULT_ACCESS_DENIED", "vault access was denied");
  }
  if (/backend|platform|secret service|d-?bus|not supported|unavailable/i.test(text)) {
    return new CredentialError("VAULT_BACKEND_UNAVAILABLE", "vault backend is unavailable");
  }
  return new CredentialError("VAULT_OPERATION_FAILED", "vault operation failed");
}

class SystemCredentialVault implements CredentialVault {
  constructor(private readonly Entry: KeyringModule["AsyncEntry"]) {}

  private entry(reference: VaultReference): AsyncKeyringEntry {
    return new this.Entry(
      LAPP_VAULT_SERVICE,
      `${reference.providerId}/${reference.credentialId}`,
    );
  }

  private async readRaw(reference: VaultReference, signal?: AbortSignal): Promise<string | undefined> {
    try {
      return (await this.entry(reference).getPassword(signal)) ?? undefined;
    } catch (error) {
      if (isNativeMissing(error)) return undefined;
      throw mapNativeError(error);
    }
  }

  async put(
    rawReference: string,
    secret: string,
    binding: CredentialBinding,
    options: VaultPutOptions = {},
  ): Promise<void> {
    const reference = parseVaultSecretRef(rawReference);
    const normalized = normalizeBinding(binding);
    if (
      reference.providerId !== normalized.providerId
      || typeof secret !== "string"
      || secret.length === 0
      || /[\r\n]/.test(secret)
    ) {
      throw invalidReference();
    }
    if (!options.overwrite && await this.readRaw(reference, options.signal) !== undefined) {
      throw new CredentialError("VAULT_CREDENTIAL_EXISTS", "vault credential already exists");
    }
    const envelope: VaultEnvelopeV1 = {
      version: 1,
      providerId: reference.providerId,
      credentialId: reference.credentialId,
      origin: normalized.origin,
      auth: normalized.auth,
      secret,
    };
    try {
      await this.entry(reference).setPassword(JSON.stringify(envelope), options.signal);
    } catch (error) {
      throw mapNativeError(error);
    }
  }

  async resolve(
    rawReference: string,
    expectedBinding: CredentialBinding,
    options: { signal?: AbortSignal } = {},
  ): Promise<string> {
    const reference = parseVaultSecretRef(rawReference);
    const normalized = normalizeBinding(expectedBinding);
    if (reference.providerId !== normalized.providerId) throw invalidReference();
    const raw = await this.readRaw(reference, options.signal);
    if (raw === undefined) {
      throw new CredentialError("VAULT_CREDENTIAL_NOT_FOUND", "vault credential was not found");
    }
    const envelope = parseEnvelope(raw, reference);
    if (!credentialBindingsEqual(envelopeBinding(envelope), normalized)) {
      throw new CredentialError(
        "VAULT_BINDING_MISMATCH",
        "vault credential does not match the provider binding",
      );
    }
    return envelope.secret;
  }

  async status(
    rawReference: string,
    expectedBinding: CredentialBinding,
    options: { signal?: AbortSignal } = {},
  ): Promise<VaultCredentialStatus> {
    const reference = parseVaultSecretRef(rawReference);
    const normalized = normalizeBinding(expectedBinding);
    if (reference.providerId !== normalized.providerId) throw invalidReference();
    const raw = await this.readRaw(reference, options.signal);
    if (raw === undefined) return { reference: rawReference, exists: false };
    const envelope = parseEnvelope(raw, reference);
    return {
      reference: rawReference,
      exists: true,
      bindingMatches: credentialBindingsEqual(envelopeBinding(envelope), normalized),
    };
  }

  async delete(rawReference: string, options: { signal?: AbortSignal } = {}): Promise<boolean> {
    const reference = parseVaultSecretRef(rawReference);
    try {
      return await this.entry(reference).deleteCredential(options.signal);
    } catch (error) {
      if (isNativeMissing(error)) return false;
      throw mapNativeError(error);
    }
  }
}

/** @internal Test seam for the native keyring adapter. */
export function createCredentialVaultFromKeyring(
  Entry: new (service: string, username: string) => AsyncKeyringEntry,
): CredentialVault {
  return new SystemCredentialVault(Entry);
}

/** Open the current-user operating-system credential store. No fallback is used. */
export async function openSystemCredentialVault(): Promise<CredentialVault> {
  try {
    // Keep this dependency outside the SDK bundle and load it only for vault://.
    const moduleName = "@napi-rs/keyring";
    const loaded = await import(moduleName) as unknown as Partial<KeyringModule> & {
      default?: Partial<KeyringModule>;
    };
    const Entry = loaded.AsyncEntry ?? loaded.default?.AsyncEntry;
    if (typeof Entry !== "function") throw new Error("missing AsyncEntry");
    return createCredentialVaultFromKeyring(Entry);
  } catch {
    throw new CredentialError("VAULT_BACKEND_UNAVAILABLE", "vault backend is unavailable");
  }
}
