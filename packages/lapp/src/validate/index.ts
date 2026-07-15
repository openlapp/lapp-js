import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { ErrorObject, ValidateFunction } from "ajv";
import { parseSecretRef, parseVaultSecretRef } from "../secret/index.js";
import type {
  Diagnostic,
  LappProfile,
  LappProvider,
  ValidationResult,
} from "../types.js";
import {
  CORE_PROTOCOLS,
  isLoopbackHostname,
  isSensitiveHeaderName,
  isValidProviderId,
} from "./constants.js";

export { CORE_PROTOCOLS as LAPP_CORE_PROTOCOLS, CORE_PROTOCOLS } from "./constants.js";

const SCHEMA_IDS = {
  provider: "https://lapp.dev/schema/1.0/provider.schema.json",
  models: "https://lapp.dev/schema/1.0/models.schema.json",
  global: "https://lapp.dev/schema/1.0/global.schema.json",
} as const;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

let validators: Record<keyof typeof SCHEMA_IDS, ValidateFunction> | undefined;

function schemaDirectory(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, "..", "..", "schema"),
    path.resolve(here, "..", "schema"),
  ];
  const found = candidates.find((candidate) =>
    fs.existsSync(path.join(candidate, "provider.schema.json")),
  );
  if (!found) throw new Error("LAPP v1 schemas are missing from the package");
  return found;
}

function getValidators(): Record<keyof typeof SCHEMA_IDS, ValidateFunction> {
  if (validators) return validators;
  const dir = schemaDirectory();
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  for (const name of Object.keys(SCHEMA_IDS) as Array<keyof typeof SCHEMA_IDS>) {
    const schema = JSON.parse(fs.readFileSync(path.join(dir, `${name}.schema.json`), "utf8"));
    ajv.addSchema(schema);
  }
  validators = Object.fromEntries(
    (Object.keys(SCHEMA_IDS) as Array<keyof typeof SCHEMA_IDS>).map((name) => {
      const validate = ajv.getSchema(SCHEMA_IDS[name]);
      if (!validate) throw new Error(`LAPP schema is not registered: ${name}`);
      return [name, validate];
    }),
  ) as Record<keyof typeof SCHEMA_IDS, ValidateFunction>;
  return validators;
}

/** Internal test hook; intentionally not exported from the package root. */
export function _resetAjvForTest(): void {
  validators = undefined;
}

function schemaDiagnostics(
  name: keyof typeof SCHEMA_IDS,
  value: unknown,
  location: string,
  diagnostics: Diagnostic[],
): void {
  const validate = getValidators()[name];
  if (validate(value)) return;
  for (const error of (validate.errors ?? []) as ErrorObject[]) {
    diagnostics.push({
      level: "ERROR",
      location: `${location}${error.instancePath}`,
      message: `${name}.json schema: ${error.message ?? "invalid"}`,
    });
  }
}

function checkedUrl(
  value: string,
  location: string,
  diagnostics: Diagnostic[],
): URL | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    diagnostics.push({ level: "ERROR", location, message: "URL is invalid" });
    return undefined;
  }
  if (url.username || url.password) {
    diagnostics.push({ level: "ERROR", location, message: "URL must not contain credentials" });
  }
  if (url.hash) {
    diagnostics.push({ level: "ERROR", location, message: "URL must not contain a fragment" });
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHostname(url.hostname))) {
    diagnostics.push({ level: "ERROR", location, message: "remote URLs must use HTTPS" });
  }
  return url;
}

function validateSecret(provider: LappProvider, location: string, diagnostics: Diagnostic[]): void {
  if (provider.config.auth.type === "none") return;
  const ref = parseSecretRef(provider.config.auth.secret);
  if (ref.scheme === "plaintext") {
    diagnostics.push({
      level: "WARN",
      code: "PLAINTEXT_SECRET",
      location,
      message: "auth.secret is plaintext",
    });
  } else if (ref.scheme === "env") {
    if (!ref.reference || !ENV_NAME.test(ref.reference)) {
      diagnostics.push({
        level: "ERROR",
        code: "INVALID_ENV_SECRET",
        location,
        message: "env credential reference is invalid",
      });
    }
  } else if (ref.scheme === "vault") {
    try {
      const vault = parseVaultSecretRef(provider.config.auth.secret);
      if (vault.providerId !== provider.config.id) {
        diagnostics.push({
          level: "ERROR",
          code: "VAULT_PROVIDER_MISMATCH",
          location,
          message: "vault credential provider id must match the provider",
        });
      }
    } catch {
      diagnostics.push({
        level: "ERROR",
        code: "INVALID_VAULT_SECRET",
        location,
        message: "vault credential reference is invalid",
      });
    }
  } else {
    diagnostics.push({
      level: "ERROR",
      code: "UNSUPPORTED_SECRET_SCHEME",
      location,
      message: "only plaintext, env://NAME, and vault://provider/credential secrets are supported",
    });
  }
}

function validateHeaders(provider: LappProvider, location: string, diagnostics: Diagnostic[]): void {
  const seen = new Map<string, string>();
  for (const [name, value] of Object.entries(provider.config.requestHeaders ?? {})) {
    const lower = name.toLowerCase();
    const previous = seen.get(lower);
    if (previous) {
      diagnostics.push({
        level: "ERROR",
        location,
        message: `requestHeaders contains case-insensitive duplicates "${previous}" and "${name}"`,
      });
    } else {
      seen.set(lower, name);
    }
    if (isSensitiveHeaderName(name)) {
      diagnostics.push({
        level: "ERROR",
        location,
        message: `requestHeaders must not contain sensitive header "${name}"`,
      });
    }
    if (/[\r\n]/.test(value)) {
      diagnostics.push({ level: "ERROR", location, message: `header "${name}" contains CR/LF` });
    }
  }
  if (provider.config.auth.type === "header") {
    const authName = provider.config.auth.name.toLowerCase();
    const conflict = Object.keys(provider.config.requestHeaders ?? {})
      .find((name) => name.toLowerCase() === authName);
    if (conflict) {
      diagnostics.push({
        level: "ERROR",
        location,
        message: `requestHeaders must not duplicate authentication header "${conflict}"`,
      });
    }
  }
}

function nonJsonLocation(
  value: unknown,
  location = "$",
  ancestors = new WeakSet<object>(),
): string | undefined {
  if (value === null || typeof value === "string" || typeof value === "boolean") return undefined;
  if (typeof value === "number") return Number.isFinite(value) ? undefined : location;
  if (typeof value !== "object") return location;
  if (ancestors.has(value)) return location;
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return location;
  ancestors.add(value);
  const entries = Array.isArray(value)
    ? value.map((entry, index) => [String(index), entry] as const)
    : Object.entries(value as Record<string, unknown>);
  for (const [key, entry] of entries) {
    const invalid = nonJsonLocation(entry, `${location}.${key}`, ancestors);
    if (invalid) return invalid;
  }
  ancestors.delete(value);
  return undefined;
}

function validateProvider(provider: LappProvider, diagnostics: Diagnostic[]): void {
  const id = provider.config.id;
  const location = `providers/${id}/provider.json`;
  schemaDiagnostics("provider", provider.config, location, diagnostics);
  if (!isValidProviderId(id)) {
    diagnostics.push({ level: "ERROR", location, message: `invalid provider id "${id}"` });
  }
  const baseUrl = checkedUrl(provider.config.baseUrl, `${location}#baseUrl`, diagnostics);
  if (provider.config.modelDiscovery) {
    const discoveryUrl = checkedUrl(
      provider.config.modelDiscovery.url,
      `${location}#modelDiscovery.url`,
      diagnostics,
    );
    if (baseUrl && discoveryUrl && baseUrl.origin !== discoveryUrl.origin) {
      diagnostics.push({
        level: "ERROR",
        location: `${location}#modelDiscovery.url`,
        message: "modelDiscovery.url must have the same origin as baseUrl",
      });
    }
  }
  validateSecret(provider, `${location}#auth.secret`, diagnostics);
  validateHeaders(provider, `${location}#requestHeaders`, diagnostics);

  const modelsLocation = `providers/${id}/models.json`;
  schemaDiagnostics("models", provider.models, modelsLocation, diagnostics);
  const providerProtocols = new Set(provider.config.protocols);
  const owners = new Map<string, string>();
  for (const model of provider.models.models) {
    const modelLocation = `${modelsLocation}#${model.id}`;
    const previous = owners.get(model.id);
    if (previous) {
      diagnostics.push({ level: "ERROR", location: modelLocation, message: `duplicate model id "${model.id}"` });
    } else {
      owners.set(model.id, model.id);
    }
    for (const protocol of model.protocols ?? []) {
      if (!providerProtocols.has(protocol)) {
        diagnostics.push({
          level: "ERROR",
          location: modelLocation,
          message: `model protocol "${protocol}" is not declared by provider`,
        });
      }
    }
  }
  for (const model of provider.models.models) {
    const modelLocation = `${modelsLocation}#${model.id}`;
    for (const alias of model.aliases ?? []) {
      const previous = owners.get(alias);
      if (previous) {
        diagnostics.push({
          level: "ERROR",
          location: modelLocation,
          message: `model id or alias "${alias}" is already owned by "${previous}"`,
        });
      } else {
        owners.set(alias, model.id);
      }
    }
  }
}

function validateGlobal(profile: LappProfile, diagnostics: Diagnostic[]): void {
  if (!profile.global) return;
  schemaDiagnostics("global", profile.global, "global.json", diagnostics);
  for (const [task, ref] of Object.entries(profile.global.defaults)) {
    const location = `global.json#defaults.${task}`;
    const provider = profile.providers.find((entry) => entry.config.id === ref.providerId);
    if (!provider) {
      diagnostics.push({ level: "ERROR", location, message: `provider "${ref.providerId}" does not exist` });
      continue;
    }
    if (provider.config.enabled === false) {
      diagnostics.push({ level: "ERROR", location, message: `provider "${ref.providerId}" is disabled` });
      continue;
    }
    const model = provider.models.models.find((entry) => entry.id === ref.modelId);
    if (!model) {
      diagnostics.push({ level: "ERROR", location, message: `model "${ref.modelId}" does not exist` });
    } else if (model.enabled === false) {
      diagnostics.push({ level: "ERROR", location, message: `model "${ref.modelId}" is disabled` });
    }
  }
}

export function validateProfile(profile: LappProfile): ValidationResult {
  const diagnostics: Diagnostic[] = [];
  const invalidJson = nonJsonLocation(profile);
  if (invalidJson) {
    diagnostics.push({
      level: "ERROR",
      location: invalidJson,
      message: "profile contains a value that cannot be represented in JSON",
    });
  } else try {
    const seenProviders = new Set<string>();
    for (const provider of profile.providers) {
      if (seenProviders.has(provider.config.id)) {
        diagnostics.push({
          level: "ERROR",
          location: `providers/${provider.config.id}`,
          message: `duplicate provider id "${provider.config.id}"`,
        });
      }
      seenProviders.add(provider.config.id);
      validateProvider(provider, diagnostics);
    }
    validateGlobal(profile, diagnostics);
  } catch (error) {
    diagnostics.push({
      level: "ERROR",
      location: ".",
      message: `profile validation unavailable: ${(error as Error).message}`,
    });
  }
  if (profile.providers.length === 0) {
    diagnostics.push({ level: "WARN", location: "providers", message: "no providers loaded" });
  }
  const rank: Record<Diagnostic["level"], number> = { ERROR: 0, WARN: 1, INFO: 2 };
  diagnostics.sort((a, b) => rank[a.level] - rank[b.level]);
  const errors = diagnostics.filter((entry) => entry.level === "ERROR").length;
  const warnings = diagnostics.filter((entry) => entry.level === "WARN").length;
  const infos = diagnostics.filter((entry) => entry.level === "INFO").length;
  return { valid: errors === 0, diagnostics, errors, warnings, infos };
}
