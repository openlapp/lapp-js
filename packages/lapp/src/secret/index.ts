import process from "node:process";
import {
  CredentialError,
  MissingEnvSecretError,
  type AuthConfig,
  type CredentialBinding,
  type CredentialResolver,
  type CredentialStatus,
  type CredentialVault,
  type ResolvedAuth,
  type SecretRef,
} from "../types.js";
import {
  openSystemCredentialVault,
  parseVaultSecretRef,
} from "./vault.js";

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function parseSecretRef(raw: string): SecretRef {
  if (raw.startsWith("env:")) {
    return {
      raw,
      scheme: "env",
      ...(raw.startsWith("env://") ? { reference: raw.slice(6) } : {}),
      plaintext: false,
    };
  }
  if (raw.startsWith("vault:")) {
    return {
      raw,
      scheme: "vault",
      ...(raw.startsWith("vault://") ? { reference: raw.slice(8) } : {}),
      plaintext: false,
    };
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(raw)) {
    return { raw, scheme: "unknown", reference: raw.slice(raw.indexOf("://") + 3), plaintext: false };
  }
  return { raw, scheme: "plaintext", plaintext: true };
}

export function redactSecret(raw: string | undefined): string {
  if (!raw) return "<unset>";
  const ref = parseSecretRef(raw);
  if (ref.scheme === "env" && ref.reference) return `env://${ref.reference}`;
  if (ref.scheme === "vault") {
    try {
      const parsed = parseVaultSecretRef(raw);
      return `vault://${parsed.providerId}/${parsed.credentialId}`;
    } catch {
      return "vault://<invalid>";
    }
  }
  return "<redacted>";
}

export interface CredentialResolverOptions {
  env?: Record<string, string | undefined>;
  vault?: CredentialVault;
}

/** Create a scheme-aware resolver. vault:// is opened lazily and never falls back. */
export function createCredentialResolver(
  options: CredentialResolverOptions = {},
): CredentialResolver {
  let systemVault: Promise<CredentialVault> | undefined;
  const vault = (): Promise<CredentialVault> => {
    if (options.vault) return Promise.resolve(options.vault);
    systemVault ??= openSystemCredentialVault();
    return systemVault;
  };

  return {
    async resolve(raw: string, binding: CredentialBinding): Promise<string> {
      const ref = parseSecretRef(raw);
      if (ref.scheme === "plaintext") {
        if (raw.length === 0 || /[\r\n]/.test(raw)) {
          throw new CredentialError("INVALID_SECRET_REFERENCE", "invalid plaintext credential");
        }
        return raw;
      }
      if (ref.scheme === "env") {
        if (!ref.reference || !ENV_NAME.test(ref.reference)) {
          throw new CredentialError("INVALID_SECRET_REFERENCE", "invalid env credential reference");
        }
        const value = (options.env ?? process.env)[ref.reference];
        if (!value) throw new MissingEnvSecretError(ref.reference);
        return value;
      }
      if (ref.scheme === "vault") {
        parseVaultSecretRef(raw);
        return (await vault()).resolve(raw, binding);
      }
      throw new CredentialError("UNSUPPORTED_SECRET_SCHEME", "unsupported credential scheme");
    },

    async status(raw: string, binding: CredentialBinding): Promise<CredentialStatus> {
      const ref = parseSecretRef(raw);
      if (ref.scheme === "plaintext") {
        if (raw.length === 0 || /[\r\n]/.test(raw)) {
          throw new CredentialError("INVALID_SECRET_REFERENCE", "invalid plaintext credential");
        }
        return { scheme: "plaintext", available: true };
      }
      if (ref.scheme === "env") {
        if (!ref.reference || !ENV_NAME.test(ref.reference)) {
          throw new CredentialError("INVALID_SECRET_REFERENCE", "invalid env credential reference");
        }
        return {
          scheme: "env",
          available: Boolean((options.env ?? process.env)[ref.reference]),
        };
      }
      if (ref.scheme === "vault") {
        parseVaultSecretRef(raw);
        const status = await (await vault()).status(raw, binding);
        return {
          scheme: "vault",
          available: status.exists && status.bindingMatches === true,
          ...(status.exists ? { bindingMatches: status.bindingMatches === true } : {}),
        };
      }
      throw new CredentialError("UNSUPPORTED_SECRET_SCHEME", "unsupported credential scheme");
    },
  };
}

export interface ResolveSecretOptions extends CredentialResolverOptions {
  binding: CredentialBinding;
  resolver?: CredentialResolver;
}

/** Resolve plaintext, env://NAME, or vault://provider/credential. */
export async function resolveSecret(raw: string, options: ResolveSecretOptions): Promise<string> {
  return (options.resolver ?? createCredentialResolver(options)).resolve(raw, options.binding);
}

/** Resolve a validated auth config without mutating it. */
export async function resolveAuthConfig(
  auth: AuthConfig,
  binding: CredentialBinding | undefined,
  options: CredentialResolverOptions & { resolver?: CredentialResolver } = {},
): Promise<ResolvedAuth> {
  if (auth.type === "none") return { type: "none" };
  if (!binding) {
    throw new CredentialError("INVALID_SECRET_REFERENCE", "credential binding is missing");
  }
  const secret = await resolveSecret(auth.secret, { ...options, binding });
  if (auth.type === "bearer") return { type: "bearer", secret };
  return { type: auth.type, name: auth.name, secret };
}

export {
  LAPP_VAULT_SERVICE,
  VAULT_SECRET_PATTERN,
  assertCredentialRequestOrigin,
  credentialBindingForProvider,
  credentialBindingsEqual,
  formatVaultSecretRef,
  normalizeCredentialOrigin,
  openSystemCredentialVault,
  parseVaultSecretRef,
  type VaultReference,
} from "./vault.js";
