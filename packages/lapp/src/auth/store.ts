import { AuthError, type AuthEnvelopeV1, type AuthTokenStatus, type AuthTokenStore } from "../types.js";
import { inspectIJsonValue } from "../json/ijson.js";
import { isValidProviderId } from "../validate/constants.js";

export const LAPP_AUTH_VAULT_SERVICE = "dev.lapp.auth.v1";

interface AsyncKeyringEntry {
  getPassword(signal?: AbortSignal): Promise<string | null>;
  setPassword(password: string, signal?: AbortSignal): Promise<void>;
  deleteCredential(signal?: AbortSignal): Promise<boolean>;
}

interface KeyringModule {
  AsyncEntry: new (service: string, username: string) => AsyncKeyringEntry;
}

const ENVELOPE_KEYS = new Set([
  "version",
  "authId",
  "driver",
  "configDigest",
  "generation",
  "credentials",
]);

function validEnvelope(value: unknown, expectedAuthId?: string): value is AuthEnvelopeV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !ENVELOPE_KEYS.has(key))) return false;
  if (Object.keys(record).length !== ENVELOPE_KEYS.size) return false;
  if (record.version !== 1 || typeof record.authId !== "string" || !isValidProviderId(record.authId)) return false;
  if (expectedAuthId !== undefined && record.authId !== expectedAuthId) return false;
  if (typeof record.driver !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(record.driver)) return false;
  if (typeof record.configDigest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(record.configDigest)) return false;
  if (typeof record.generation !== "number" || !Number.isSafeInteger(record.generation) || record.generation < 1) return false;
  if (typeof record.credentials !== "object" || record.credentials === null || Array.isArray(record.credentials)) return false;
  return inspectIJsonValue(value).length === 0;
}

function parseEnvelope(raw: string, authId: string): AuthEnvelopeV1 {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { /* mapped below */ }
  if (!validEnvelope(value, authId)) {
    throw new AuthError("AUTH_RECORD_INVALID", "auth token record is invalid");
  }
  return value;
}

function nativeText(error: unknown): string {
  return error instanceof Error ? `${error.name} ${error.message}` : String(error ?? "");
}

function isMissing(error: unknown): boolean {
  return /no\s*entry|not\s*found|credential.*missing/i.test(nativeText(error));
}

function mapNative(error: unknown): AuthError {
  const text = nativeText(error);
  if (/access|denied|permission|unauthori[sz]ed/i.test(text)) {
    return new AuthError("AUTH_ACCESS_DENIED", "auth token store access was denied");
  }
  if (/backend|platform|secret service|d-?bus|not supported|unavailable/i.test(text)) {
    return new AuthError("AUTH_TOKEN_STORE_ERROR", "auth token store is unavailable");
  }
  return new AuthError("AUTH_TOKEN_STORE_ERROR", "auth token store operation failed");
}

class SystemAuthTokenStore implements AuthTokenStore {
  constructor(private readonly Entry: KeyringModule["AsyncEntry"]) {}

  private entry(authId: string): AsyncKeyringEntry {
    if (!isValidProviderId(authId)) throw new TypeError("invalid auth id");
    return new this.Entry(LAPP_AUTH_VAULT_SERVICE, authId);
  }

  async read(authId: string, options: { signal?: AbortSignal } = {}): Promise<AuthEnvelopeV1 | undefined> {
    try {
      const raw = await this.entry(authId).getPassword(options.signal);
      return raw === null ? undefined : parseEnvelope(raw, authId);
    } catch (error) {
      if (error instanceof AuthError) throw error;
      if (isMissing(error)) return undefined;
      throw mapNative(error);
    }
  }

  async write(envelope: AuthEnvelopeV1, options: { signal?: AbortSignal } = {}): Promise<void> {
    if (!validEnvelope(envelope)) {
      throw new AuthError("AUTH_RECORD_INVALID", "auth token record is invalid");
    }
    try {
      await this.entry(envelope.authId).setPassword(JSON.stringify(envelope), options.signal);
    } catch (error) {
      throw mapNative(error);
    }
  }

  async status(authId: string, options: { signal?: AbortSignal } = {}): Promise<AuthTokenStatus> {
    const envelope = await this.read(authId, options);
    if (!envelope) return { authId, exists: false };
    const rawExpiresAt = envelope.credentials.expiresAt;
    const expiresAt = typeof rawExpiresAt === "string" && Number.isFinite(Date.parse(rawExpiresAt))
      ? rawExpiresAt
      : undefined;
    return {
      authId,
      exists: true,
      driver: envelope.driver,
      ...(expiresAt ? { expiresAt, expired: Date.parse(expiresAt) <= Date.now() } : {}),
    };
  }

  async delete(authId: string, options: { signal?: AbortSignal } = {}): Promise<boolean> {
    try {
      return await this.entry(authId).deleteCredential(options.signal);
    } catch (error) {
      if (isMissing(error)) return false;
      throw mapNative(error);
    }
  }
}

/** @internal Test seam for the native keyring adapter. */
export function createAuthTokenStoreFromKeyring(
  Entry: new (service: string, username: string) => AsyncKeyringEntry,
): AuthTokenStore {
  return new SystemAuthTokenStore(Entry);
}

export function createMemoryAuthTokenStore(initial: readonly AuthEnvelopeV1[] = []): AuthTokenStore {
  const records = new Map(initial.map((entry) => [entry.authId, structuredClone(entry)]));
  return {
    async read(authId) {
      const value = records.get(authId);
      return value ? structuredClone(value) : undefined;
    },
    async write(envelope) {
      if (!validEnvelope(envelope)) throw new AuthError("AUTH_RECORD_INVALID", "auth token record is invalid");
      records.set(envelope.authId, structuredClone(envelope));
    },
    async status(authId) {
      const value = records.get(authId);
      return value
        ? {
          authId,
          exists: true,
          driver: value.driver,
          ...(typeof value.credentials.expiresAt === "string"
            ? {
              expiresAt: value.credentials.expiresAt,
              expired: Date.parse(value.credentials.expiresAt) <= Date.now(),
            }
            : {}),
        }
        : { authId, exists: false };
    },
    async delete(authId) { return records.delete(authId); },
  };
}

export async function openSystemAuthTokenStore(): Promise<AuthTokenStore> {
  try {
    const moduleName = "@napi-rs/keyring";
    const loaded = await import(moduleName) as unknown as Partial<KeyringModule> & {
      default?: Partial<KeyringModule>;
    };
    const Entry = loaded.AsyncEntry ?? loaded.default?.AsyncEntry;
    if (typeof Entry !== "function") throw new Error("missing AsyncEntry");
    return createAuthTokenStoreFromKeyring(Entry);
  } catch {
    throw new AuthError("AUTH_TOKEN_STORE_ERROR", "auth token store is unavailable");
  }
}
