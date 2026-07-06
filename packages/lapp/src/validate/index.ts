/**
 * Profile validation.
 *
 * Two layers:
 *   1. JSON Schema validation via ajv against the LAPP schemas (provider /
 *      models / global / manifest), loaded from the schema directory.
 *   2. Custom semantic rules ported from the reference validator
 *      `../lapp/tools/validator/lapp-validate.mjs` (alias duplicates, global
 *      reference existence, secret URI scheme warnings, sensitive headers,
 *      core-protocol warnings).
 *
 * Custom rules are layered on top of ajv because JSON Schemas intentionally
 * use `additionalProperties: true` for forward compatibility (spec: "safely
 * ignore unknown fields"), so semantic checks live in code.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { ErrorObject } from "ajv";
import type {
  Diagnostic,
  LappProfile,
  LappProvider,
  ValidationResult,
} from "../types.js";
import { findConfigFile, relativeLocation } from "../config/jsonc.js";
import { parseSecretRef } from "../secret/index.js";
import { CORE_PROTOCOLS, SENSITIVE_HEADERS, MODEL_REF_KEYS, isObject } from "./constants.js";

export { CORE_PROTOCOLS as LAPP_CORE_PROTOCOLS, CORE_PROTOCOLS } from "./constants.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Resolve the schema directory: copied `packages/lapp/schema/` first, sibling `../lapp/schema` fallback. */
function resolveSchemaDir(): string {
  const candidates = [
    path.resolve(__dirname, "..", "..", "schema"),
    path.resolve(__dirname, "..", "..", "..", "..", "lapp", "schema"),
    path.resolve(__dirname, "..", "..", "..", "lapp", "schema"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.readdirSync(c).some((f) => f.endsWith(".schema.json"))) {
      return c;
    }
  }
  return candidates[0]!;
}

let ajvInstance: Ajv2020 | null = null;

function getAjv(): Ajv2020 {
  if (!ajvInstance) {
    const ajv = new Ajv2020({ allErrors: true, strict: false, allowUnionTypes: true });
    const schemaDir = resolveSchemaDir();
    if (fs.existsSync(schemaDir)) {
      for (const file of fs.readdirSync(schemaDir)) {
        if (!file.endsWith(".schema.json")) continue;
        const schema = JSON.parse(fs.readFileSync(path.join(schemaDir, file), "utf8"));
        ajv.addSchema(schema);
      }
    }
    ajvInstance = ajv;
  }
  return ajvInstance;
}

function ajvValidate(schemaId: string, data: unknown): { ok: boolean; messages: string[] } {
  const ajv = getAjv();
  const validate = ajv.getSchema(schemaId);
  if (!validate) return { ok: true, messages: [] };
  const ok = validate(data) as boolean;
  if (ok) return { ok: true, messages: [] };
  const errors = (validate as { errors: ErrorObject[] | null }).errors ?? [];
  const messages = errors.map(
    (e: ErrorObject) => `${e.instancePath || "/"} ${e.message ?? "invalid"}`,
  );
  return { ok: false, messages };
}

function validateSecret(
  secret: unknown,
  location: string,
  diagnostics: Diagnostic[],
): void {
  if (typeof secret !== "string" || secret.trim() === "") {
    diagnostics.push({ level: "WARN", location, message: "auth.secret is missing or empty" });
    return;
  }
  const ref = parseSecretRef(secret);
  if (ref.plaintext) {
    diagnostics.push({
      level: "WARN",
      location,
      message: "auth.secret is a plain secret; prefer env:// or keychain://",
    });
  }
}

function validateRequestHeaders(
  headers: unknown,
  location: string,
  diagnostics: Diagnostic[],
): void {
  if (!isObject(headers)) return;
  for (const header of Object.keys(headers)) {
    if (SENSITIVE_HEADERS.has(header.toLowerCase())) {
      diagnostics.push({
        level: "WARN",
        location,
        message: `requestHeaders contains sensitive header "${header}"`,
      });
    }
  }
}

function validateProvider(
  provider: LappProvider,
  root: string,
  diagnostics: Diagnostic[],
): void {
  const config = provider.config;
  const location = config.__file ? relativeLocation(root, config.__file) : `providers/${config.id}`;

  // Run the JSON-Schema check regardless of whether the provider has a backing
  // file. In-memory profiles (createProfile + upsertProvider) must still be
  // subject to enum/format/pattern constraints from the schema — otherwise
  // writeProfileAtomic() would persist profiles a stricter downstream
  // validator would reject.
  const schemaCheck = ajvValidate(
    "https://lapp.dev/schema/provider.schema.json",
    config as unknown as Record<string, unknown>,
  );
  if (!schemaCheck.ok) {
    for (const m of schemaCheck.messages) {
      diagnostics.push({ level: "ERROR", location, message: `provider.json schema: ${m}` });
    }
  }

  for (const field of ["id", "protocol", "baseUrl"] as const) {
    if (typeof config[field] !== "string" || (config[field] as string).trim() === "") {
      diagnostics.push({ level: "ERROR", location, message: `missing required field "${field}"` });
    }
  }

  if (typeof config.baseUrl === "string" && config.baseUrl.endsWith("/")) {
    diagnostics.push({ level: "WARN", location, message: "baseUrl should not end with /" });
  }

  if (typeof config.protocol === "string" && !CORE_PROTOCOLS.has(config.protocol)) {
    diagnostics.push({
      level: "WARN",
      location,
      message: `protocol "${config.protocol}" is not a core LAPP v1 protocol`,
    });
  }

  validateSecret(config.auth?.secret, location, diagnostics);
  validateRequestHeaders(config.requestHeaders, location, diagnostics);

  if (provider.models) {
    const modelsFile = findConfigFile(provider.dir, "models");
    const modelsLoc = modelsFile ? relativeLocation(root, modelsFile) : `providers/${config.id}/models.json`;
    const schemaCheck = ajvValidate(
      "https://lapp.dev/schema/models.schema.json",
      provider.models as unknown as Record<string, unknown>,
    );
    if (!schemaCheck.ok) {
      for (const m of schemaCheck.messages) {
        diagnostics.push({ level: "ERROR", location: modelsLoc, message: `models.json schema: ${m}` });
      }
    }

    const aliasOwner = new Map<string, string>();
    const knownIds = new Set<string>();
    for (const [index, model] of provider.models.models.entries()) {
      const modelLoc = `${modelsLoc}#models[${index}]`;
      if (typeof model.id !== "string" || model.id.trim() === "") {
        diagnostics.push({ level: "ERROR", location: modelLoc, message: 'model is missing required field "id"' });
        continue;
      }
      knownIds.add(model.id);
      if (typeof model.type !== "string" || model.type.trim() === "") {
        diagnostics.push({ level: "WARN", location: modelLoc, message: "model is missing type" });
      }
      if (typeof model.source !== "string" || model.source.trim() === "") {
        diagnostics.push({ level: "WARN", location: modelLoc, message: "model source is missing; treat as manual" });
      } else if (!["provider", "manual"].includes(model.source)) {
        diagnostics.push({ level: "WARN", location: modelLoc, message: `model source "${model.source}" is not provider or manual` });
      }
      if (Array.isArray(model.aliases)) {
        for (const alias of model.aliases) {
          if (typeof alias !== "string" || alias.trim() === "") continue;
          if (aliasOwner.has(alias)) {
            diagnostics.push({
              level: "WARN",
              location: modelLoc,
              message: `duplicate alias "${alias}" also used by "${aliasOwner.get(alias)}"`,
            });
          } else if (knownIds.has(alias)) {
            // An alias colliding with a real model id resolves ambiguously at
            // runtime (resolveModelId matches id before alias), so surface it
            // the same way as a duplicate alias.
            diagnostics.push({
              level: "WARN",
              location: modelLoc,
              message: `alias "${alias}" duplicates an existing model id`,
            });
          } else {
            aliasOwner.set(alias, model.id);
          }
        }
      }
    }
  }
}

function validateGlobal(profile: LappProfile, diagnostics: Diagnostic[]): void {
  const global = profile.global;
  if (!global) return;
  const root = profile.rootDir;
  const globalFile = findConfigFile(root, "global");
  const location = globalFile ? relativeLocation(root, globalFile) : "global.json";

  const schemaCheck = ajvValidate(
    "https://lapp.dev/schema/global.schema.json",
    global as unknown as Record<string, unknown>,
  );
  if (!schemaCheck.ok) {
    for (const m of schemaCheck.messages) {
      diagnostics.push({ level: "ERROR", location, message: `global.json schema: ${m}` });
    }
  }

  const providerMap = new Map(profile.providers.map((p) => [p.config.id, p]));
  for (const key of MODEL_REF_KEYS) {
    const ref = (global as unknown as Record<string, unknown>)[key] as
      | { providerId?: unknown; model?: unknown }
      | undefined;
    if (!isObject(ref)) continue;

    if (typeof ref.providerId !== "string" || ref.providerId.trim() === "") {
      diagnostics.push({ level: "ERROR", location: `${location}#${key}`, message: "missing providerId" });
      continue;
    }

    const provider = providerMap.get(ref.providerId);
    if (!provider) {
      diagnostics.push({
        level: "ERROR",
        location: `${location}#${key}`,
        message: `providerId "${ref.providerId}" does not exist`,
      });
      continue;
    }

    if (typeof ref.model !== "string" || ref.model.trim() === "") {
      diagnostics.push({ level: "WARN", location: `${location}#${key}`, message: "model is missing or empty" });
      continue;
    }

    if (provider.models) {
      const knownIds = new Set(provider.models.models.map((m) => m.id));
      const knownAliases = new Set(provider.models.models.flatMap((m) => m.aliases ?? []));
      if (!knownIds.has(ref.model) && !knownAliases.has(ref.model)) {
        diagnostics.push({
          level: "WARN",
          location: `${location}#${key}`,
          message: `model "${ref.model}" was not found in provider "${ref.providerId}" models.json`,
        });
      }
    } else {
      // Provider has no models.json at all. A global default pointing at
      // it can never resolve at runtime (resolveModelId throws "no model
      // specified and provider has no enabled models"), so warn here
      // instead of passing a profile that will only break at call time.
      diagnostics.push({
        level: "WARN",
        location: `${location}#${key}`,
        message: `provider "${ref.providerId}" has no models.json; default model "${ref.model}" cannot be resolved`,
      });
    }
  }
}

/**
 * Validate a loaded profile. Does not re-read from disk; works on the
 * in-memory `LappProfile`.
 */
export function validateProfile(profile: LappProfile): ValidationResult {
  const diagnostics: Diagnostic[] = [];

  if (profile.manifest) {
    const schemaCheck = ajvValidate(
      "https://lapp.dev/schema/manifest.schema.json",
      profile.manifest as unknown as Record<string, unknown>,
    );
    if (!schemaCheck.ok) {
      const manifestFile = findConfigFile(profile.rootDir, "manifest");
      const location = manifestFile ? relativeLocation(profile.rootDir, manifestFile) : "manifest.json";
      for (const m of schemaCheck.messages) {
        diagnostics.push({ level: "ERROR", location, message: `manifest.json schema: ${m}` });
      }
    }
  }

  for (const provider of profile.providers) {
    validateProvider(provider, profile.rootDir, diagnostics);
  }
  validateGlobal(profile, diagnostics);

  if (profile.providers.length === 0) {
    diagnostics.push({ level: "WARN", location: "providers", message: "no providers loaded" });
  } else {
    const enabledCount = profile.providers.filter((p) => p.config.enabled !== false).length;
    if (enabledCount === 0) {
      diagnostics.push({ level: "WARN", location: "providers", message: "no enabled providers loaded" });
    }
  }

  // Surface any diagnostics already collected during load (parse errors etc.).
  for (const d of profile.diagnostics) {
    if (!diagnostics.some((x) => x.level === d.level && x.location === d.location && x.message === d.message)) {
      diagnostics.push(d);
    }
  }

  const rank: Record<string, number> = { ERROR: 0, WARN: 1, INFO: 2 };
  diagnostics.sort((a, b) => (rank[a.level] ?? 9) - (rank[b.level] ?? 9));

  const errors = diagnostics.filter((d) => d.level === "ERROR").length;
  const warnings = diagnostics.filter((d) => d.level === "WARN").length;
  const infos = diagnostics.filter((d) => d.level === "INFO").length;

  return { valid: errors === 0, diagnostics, errors, warnings, infos };
}