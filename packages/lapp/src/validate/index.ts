import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { ErrorObject, ValidateFunction } from "ajv";
import { parseSecretRef, parseVaultSecretRef } from "../secret/index.js";
import { inspectIJsonValue } from "../json/ijson.js";
import { authDirectory, providerDirectory } from "../profile-location.js";
import type {
  AuthSource,
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
  global11: "https://lapp.dev/schema/1.1/global.schema.json",
  auth: "https://lapp.dev/schema/1.1/auth.schema.json",
} as const;
const SCHEMA_FILES: Record<keyof typeof SCHEMA_IDS, string> = {
  provider: "provider.schema.json",
  models: "models.schema.json",
  global: "global.schema.json",
  global11: "global-1.1.schema.json",
  auth: "auth.schema.json",
};
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SENSITIVE_AUTH_CONFIG_FAMILIES = [
  "token",
  "apikey",
  "secret",
  "password",
  "passphrase",
  "privatekey",
  "accesskey",
  "sessionkey",
  "signingkey",
  "credential",
  "cookie",
  "authorization",
  "authorizationcode",
  "devicecode",
  "codeverifier",
  "deviceauthid",
  "usercode",
];
const PUBLIC_AUTH_CONFIG_KEYS = new Set([
  "tokenendpoint",
  "devicecodeurl",
  "clientid",
  "discoveryurl",
  "modelsurl",
  "inferencebaseurl",
  "issuer",
  "scope",
  "reasoningeffort",
  "accountid",
]);

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
    const schema = JSON.parse(fs.readFileSync(path.join(dir, SCHEMA_FILES[name]), "utf8"));
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
): boolean {
  const validate = getValidators()[name];
  if (validate(value)) return true;
  for (const error of (validate.errors ?? []) as ErrorObject[]) {
    let pointer = error.instancePath || "";
    const propertyName = error.propertyName
      ?? (error.params as { propertyName?: string }).propertyName;
    const missingProperty = (error.params as { missingProperty?: string }).missingProperty;
    const additionalProperty = (error.params as { additionalProperty?: string }).additionalProperty;
    if (propertyName) pointer = pointerJoin(pointer, propertyName);
    else if (error.keyword === "required" && missingProperty) {
      pointer = pointerJoin(pointer, missingProperty);
    } else if (error.keyword === "additionalProperties" && additionalProperty) {
      pointer = pointerJoin(pointer, additionalProperty);
    }
    diagnostics.push({
      level: "ERROR",
      code: `SCHEMA_${name === "global11" ? "GLOBAL" : name.toUpperCase()}`,
      location: pointer ? `${location}#${pointer}` : location,
      message: `${name}.json schema: ${error.message ?? "invalid"}`,
    });
  }
  return false;
}

function escapePointerSegment(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function pointerJoin(pointer: string, segment: string | number): string {
  return `${pointer}/${escapePointerSegment(String(segment))}`;
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
    diagnostics.push({ level: "ERROR", code: "INVALID_URL", location, message: "URL is invalid" });
    return undefined;
  }
  const authority = value.match(/^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/?#]*)/)?.[1];
  if (url.username || url.password || authority?.includes("@")) {
    diagnostics.push({ level: "ERROR", code: "URL_CREDENTIALS", location, message: "URL must not contain credentials" });
  }
  if (value.includes("#")) {
    diagnostics.push({ level: "ERROR", code: "URL_FRAGMENT", location, message: "URL must not contain a fragment" });
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHostname(url.hostname))) {
    diagnostics.push({ level: "ERROR", code: "INSECURE_URL", location, message: "remote URLs must use HTTPS" });
  }
  return url;
}

function validateSecret(provider: LappProvider, location: string, diagnostics: Diagnostic[]): void {
  const auth = provider.config.auth as unknown;
  if (!auth || typeof auth !== "object" || !("type" in auth)) return;
  if ((auth as { type?: unknown }).type === "none") return;
  const secret = (auth as { secret?: unknown }).secret;
  if (typeof secret !== "string") return;
  const ref = parseSecretRef(secret);
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
      const vault = parseVaultSecretRef(secret);
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
    const headerLocation = `${location}/${escapePointerSegment(name)}`;
    const lower = name.toLowerCase();
    const previous = seen.get(lower);
    if (previous) {
      diagnostics.push({
        level: "ERROR",
        code: "DUPLICATE_REQUEST_HEADER",
        location: headerLocation,
        message: `requestHeaders contains case-insensitive duplicates "${previous}" and "${name}"`,
      });
    } else {
      seen.set(lower, name);
    }
    if (isSensitiveHeaderName(name)) {
      diagnostics.push({
        level: "ERROR",
        code: "SENSITIVE_REQUEST_HEADER",
        location: headerLocation,
        message: `requestHeaders must not contain sensitive header "${name}"`,
      });
    }
    if (/[\r\n]/.test(value)) {
      diagnostics.push({
        level: "ERROR",
        code: "INVALID_REQUEST_HEADER_VALUE",
        location: headerLocation,
        message: `header "${name}" contains CR/LF`,
      });
    }
  }
  if (provider.config.auth.type === "header") {
    const authName = provider.config.auth.name.toLowerCase();
    const conflict = Object.keys(provider.config.requestHeaders ?? {})
      .find((name) => name.toLowerCase() === authName);
    if (conflict) {
      diagnostics.push({
        level: "ERROR",
        code: "DUPLICATE_AUTH_HEADER",
        location: `${location}/${escapePointerSegment(conflict)}`,
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
  if (
    value === null
    || typeof value === "string"
    || typeof value === "boolean"
    || typeof value === "number"
  ) return undefined;
  if (typeof value !== "object") return location;
  if (ancestors.has(value)) return location;
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return location;
  if (Object.getOwnPropertySymbols(value).length > 0) return location;
  ancestors.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!(index in value)) return `${location}.${index}`;
      const invalid = nonJsonLocation(value[index], `${location}.${index}`, ancestors);
      if (invalid) return invalid;
    }
  } else {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      const invalid = nonJsonLocation(entry, `${location}.${key}`, ancestors);
      if (invalid) return invalid;
    }
  }
  ancestors.delete(value);
  return undefined;
}

function profileIJsonLocation(profile: LappProfile, pointer: string): string {
  const global = pointer.match(/^\/global(\/.*)?$/);
  if (global) return global[1] ? `global.json#${global[1]}` : "global.json";

  const provider = pointer.match(/^\/providers\/([0-9]+)\/(config|models)(\/.*)?$/);
  if (provider) {
    const index = Number(provider[1]);
    const id = profile.providers[index]?.config?.id;
    const directory = typeof id === "string" && isValidProviderId(id) ? id : `provider-${index}`;
    const file = provider[2] === "config" ? "provider.json" : "models.json";
    return `providers/${directory}/${file}${provider[3] ? `#${provider[3]}` : ""}`;
  }
  const auth = pointer.match(/^\/auth\/([0-9]+)\/(config|models)(\/.*)?$/);
  if (auth) {
    const index = Number(auth[1]);
    const id = profile.auth?.[index]?.config?.id;
    const directory = typeof id === "string" && isValidProviderId(id) ? id : `auth-${index}`;
    const file = auth[2] === "config" ? "auth.json" : "models.json";
    return `auth/${directory}/${file}${auth[3] ? `#${auth[3]}` : ""}`;
  }
  return pointer ? `#${pointer}` : ".";
}

function normalizeAuthConfigKey(key: string): string {
  return key.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
}

function isSensitiveAuthConfigKey(key: string): boolean {
  const normalized = normalizeAuthConfigKey(key);
  // These are reviewed public driver metadata names. Any derivative such as
  // `tokenEndpointSecret` falls through to the family check below.
  if (PUBLIC_AUTH_CONFIG_KEYS.has(normalized)) return false;
  return SENSITIVE_AUTH_CONFIG_FAMILIES.some((family) => normalized.includes(family));
}

function validateAuthConfig(
  value: unknown,
  location: string,
  diagnostics: Diagnostic[],
  container = "auth.config",
): void {
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      validateAuthConfig(entry, `${location}/${index}`, diagnostics, container);
    }
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const keyLocation = `${location}/${escapePointerSegment(key)}`;
    if (isSensitiveAuthConfigKey(key)) {
      diagnostics.push({
        level: "ERROR",
        code: "SENSITIVE_AUTH_CONFIG_KEY",
        location: keyLocation,
        message: `${container} must not contain credential-bearing key "${key}"`,
      });
    }
    validateAuthConfig(entry, keyLocation, diagnostics, container);
  }
}

function validateAuthSource(source: AuthSource, diagnostics: Diagnostic[]): void {
  const directory = authDirectory(source);
  const location = `auth/${directory}/auth.json`;
  const schemaValid = schemaDiagnostics("auth", source.config, location, diagnostics);
  const modelsLocation = `auth/${directory}/models.json`;
  const modelsValid = schemaDiagnostics("models", source.models, modelsLocation, diagnostics);
  if (!schemaValid || !modelsValid) return;
  if (source.config.config !== undefined) {
    validateAuthConfig(source.config.config, `${location}#/config`, diagnostics);
  }
  if (source.models.extensions !== undefined) {
    validateAuthConfig(source.models.extensions, `${modelsLocation}#/extensions`, diagnostics, "Auth models.json extensions");
  }
  if (!isValidProviderId(source.config.id)) {
    diagnostics.push({
      level: "ERROR",
      code: "INVALID_AUTH_ID",
      location: `${location}#/id`,
      message: `invalid auth id "${source.config.id}"`,
    });
  }
  const protocols = new Set(source.config.protocols);
  const owners = new Map<string, string>();
  for (const [modelIndex, model] of source.models.models.entries()) {
    const modelLocation = `${modelsLocation}#/models/${modelIndex}`;
    if (model.extensions !== undefined) {
      validateAuthConfig(model.extensions, `${modelLocation}/extensions`, diagnostics, "Auth model extensions");
    }
    for (const [identityIndex, identity] of [model.id, ...(model.aliases ?? [])].entries()) {
      const previous = owners.get(identity);
      if (previous) {
        diagnostics.push({
          level: "ERROR",
          code: "DUPLICATE_AUTH_MODEL_IDENTITY",
          location: identityIndex === 0
            ? `${modelLocation}/id`
            : `${modelLocation}/aliases/${identityIndex - 1}`,
          message: `model id or alias "${identity}" is already owned by "${previous}"`,
        });
      } else {
        owners.set(identity, model.id);
      }
    }
    for (const [protocolIndex, protocol] of (model.protocols ?? []).entries()) {
      if (!protocols.has(protocol)) {
        diagnostics.push({
          level: "ERROR",
          code: "AUTH_MODEL_PROTOCOL_NOT_DECLARED",
          location: `${modelLocation}/protocols/${protocolIndex}`,
          message: `model protocol "${protocol}" is not declared by auth source`,
        });
      }
    }
  }
}

function validateProvider(provider: LappProvider, diagnostics: Diagnostic[]): void {
  const id = provider.config.id;
  const directory = providerDirectory(provider);
  const location = `providers/${directory}/provider.json`;
  const schemaValid = schemaDiagnostics("provider", provider.config, location, diagnostics);
  if (provider.config.auth && typeof provider.config.auth === "object") {
    validateSecret(provider, `${location}#/auth/secret`, diagnostics);
  }
  if (!schemaValid) return;
  if (!isValidProviderId(id)) {
    diagnostics.push({
      level: "ERROR",
      code: "INVALID_PROVIDER_ID",
      location: `${location}#/id`,
      message: `invalid provider id "${id}"`,
    });
  }
  const baseUrl = checkedUrl(provider.config.baseUrl, `${location}#/baseUrl`, diagnostics);
  if (provider.config.modelDiscovery) {
    const discoveryUrl = checkedUrl(
      provider.config.modelDiscovery.url,
      `${location}#/modelDiscovery/url`,
      diagnostics,
    );
    if (baseUrl && discoveryUrl && baseUrl.origin !== discoveryUrl.origin) {
      diagnostics.push({
        level: "ERROR",
        code: "CROSS_ORIGIN_DISCOVERY",
        location: `${location}#/modelDiscovery/url`,
        message: "modelDiscovery.url must have the same origin as baseUrl",
      });
    }
  }
  validateHeaders(provider, `${location}#/requestHeaders`, diagnostics);

  const modelsLocation = `providers/${directory}/models.json`;
  if (!schemaDiagnostics("models", provider.models, modelsLocation, diagnostics)) return;
  const providerProtocols = new Set(provider.config.protocols);
  const owners = new Map<string, string>();
  for (const [modelIndex, model] of provider.models.models.entries()) {
    const modelLocation = `${modelsLocation}#/models/${modelIndex}`;
    const identities = [model.id, ...(model.aliases ?? [])];
    for (const [identityIndex, identity] of identities.entries()) {
      const previous = owners.get(identity);
      if (previous) {
        diagnostics.push({
          level: "ERROR",
          code: "DUPLICATE_MODEL_IDENTITY",
          location: identityIndex === 0
            ? `${modelLocation}/id`
            : `${modelLocation}/aliases/${identityIndex - 1}`,
          message: `model id or alias "${identity}" is already owned by "${previous}"`,
        });
      } else {
        owners.set(identity, model.id);
      }
    }
    for (const [protocolIndex, protocol] of (model.protocols ?? []).entries()) {
      if (!providerProtocols.has(protocol)) {
        diagnostics.push({
          level: "ERROR",
          code: "MODEL_PROTOCOL_NOT_DECLARED",
          location: `${modelLocation}/protocols/${protocolIndex}`,
          message: `model protocol "${protocol}" is not declared by provider`,
        });
      }
    }
  }
}

function validateGlobal(profile: LappProfile, diagnostics: Diagnostic[]): void {
  if (!profile.global) return;
  const schemaName = profile.global.schemaVersion === "1.1" ? "global11" : "global";
  if (!schemaDiagnostics(schemaName, profile.global, "global.json", diagnostics)) return;
  for (const [task, ref] of Object.entries(profile.global.defaults)) {
    const location = `global.json#/defaults/${escapePointerSegment(task)}`;
    if ("authId" in ref) {
      const source = profile.auth?.find((entry) => entry.config.id === ref.authId);
      if (!source) {
        diagnostics.push({
          level: "ERROR",
          code: "DEFAULT_AUTH_NOT_FOUND",
          location: `${location}/authId`,
          message: `auth source "${ref.authId}" does not exist`,
        });
        continue;
      }
      if (source.config.enabled === false) {
        diagnostics.push({
          level: "ERROR",
          code: "DEFAULT_AUTH_DISABLED",
          location: `${location}/authId`,
          message: `auth source "${ref.authId}" is disabled`,
        });
      }
      const model = source.models.models.find((entry) => entry.id === ref.modelId);
      if (!model) {
        diagnostics.push({
          level: "ERROR",
          code: "DEFAULT_MODEL_NOT_FOUND",
          location: `${location}/modelId`,
          message: `model "${ref.modelId}" does not exist`,
        });
      } else if (model.enabled === false) {
        diagnostics.push({
          level: "ERROR",
          code: "DEFAULT_MODEL_DISABLED",
          location: `${location}/modelId`,
          message: `model "${ref.modelId}" is disabled`,
        });
      }
      continue;
    }
    const provider = profile.providers.find((entry) => entry.config.id === ref.providerId);
    if (!provider) {
      diagnostics.push({
        level: "ERROR",
        code: "DEFAULT_PROVIDER_NOT_FOUND",
        location: `${location}/providerId`,
        message: `provider "${ref.providerId}" does not exist`,
      });
      continue;
    }
    if (provider.config.enabled === false) {
      diagnostics.push({
        level: "ERROR",
        code: "DEFAULT_PROVIDER_DISABLED",
        location: `${location}/providerId`,
        message: `provider "${ref.providerId}" is disabled`,
      });
    }
    const model = provider.models.models.find((entry) => entry.id === ref.modelId);
    if (!model) {
      diagnostics.push({
        level: "ERROR",
        code: "DEFAULT_MODEL_NOT_FOUND",
        location: `${location}/modelId`,
        message: `model "${ref.modelId}" does not exist`,
      });
    } else if (model.enabled === false) {
      diagnostics.push({
        level: "ERROR",
        code: "DEFAULT_MODEL_DISABLED",
        location: `${location}/modelId`,
        message: `model "${ref.modelId}" is disabled`,
      });
    }
  }
}

export function validateProfile(profile: LappProfile): ValidationResult {
  const diagnostics: Diagnostic[] = [];
  const invalidJson = nonJsonLocation(profile);
  if (invalidJson) {
    diagnostics.push({
      level: "ERROR",
      code: "IJSON_NON_JSON_VALUE",
      location: invalidJson,
      message: "profile contains a value that cannot be represented in JSON",
    });
  } else try {
    for (const finding of inspectIJsonValue(profile)) {
      diagnostics.push({
        level: "ERROR",
        code: finding.code,
        location: profileIJsonLocation(profile, finding.pointer),
        message: finding.message,
      });
    }
    const seenProviders = new Set<string>();
    for (const provider of profile.providers) {
      if (seenProviders.has(provider.config.id)) {
        diagnostics.push({
          level: "ERROR",
          code: "DUPLICATE_PROVIDER_ID",
          location: `providers/${provider.config.id}`,
          message: `duplicate provider id "${provider.config.id}"`,
        });
      }
      seenProviders.add(provider.config.id);
      validateProvider(provider, diagnostics);
    }
    const seenAuth = new Set<string>();
    for (const source of profile.auth ?? []) {
      if (seenAuth.has(source.config.id)) {
        diagnostics.push({
          level: "ERROR",
          code: "DUPLICATE_AUTH_ID",
          location: `auth/${source.config.id}`,
          message: `duplicate auth id "${source.config.id}"`,
        });
      }
      seenAuth.add(source.config.id);
      validateAuthSource(source, diagnostics);
    }
    validateGlobal(profile, diagnostics);
  } catch {
    diagnostics.push({
      level: "ERROR",
      code: "VALIDATION_UNAVAILABLE",
      location: ".",
      message: "profile validation unavailable",
    });
  }
  const rank: Record<Diagnostic["level"], number> = { ERROR: 0, WARN: 1, INFO: 2 };
  diagnostics.sort((a, b) => rank[a.level] - rank[b.level]);
  const errors = diagnostics.filter((entry) => entry.level === "ERROR").length;
  const warnings = diagnostics.filter((entry) => entry.level === "WARN").length;
  const infos = diagnostics.filter((entry) => entry.level === "INFO").length;
  return { valid: errors === 0, diagnostics, errors, warnings, infos };
}
