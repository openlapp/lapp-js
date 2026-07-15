import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { redactSecret, parseSecretRef } from "../secret/index.js";
import {
  ProfileValidationError,
  type Diagnostic,
  type GlobalConfig,
  type LappProfile,
  type LappProvider,
  type ModelsConfig,
  type ProfileInspection,
  type ProviderConfig,
} from "../types.js";
import { validateProfile } from "../validate/index.js";
import { isObject } from "../validate/constants.js";
import { attachProfileRoot } from "../profile-location.js";

export interface LoadProfileOptions {
  path?: string;
}

export function resolveLappRoot(explicit?: string): string {
  if (explicit) return path.resolve(explicit);
  if (process.env.LAPP_HOME) return path.resolve(process.env.LAPP_HOME);
  return path.join(os.homedir(), ".lapp");
}

function relative(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join("/") || ".";
}

function parseJson(file: string, root: string, diagnostics: Diagnostic[]): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    diagnostics.push({
      level: "ERROR",
      location: relative(root, file),
      message: `invalid JSON: ${(error as Error).message}`,
    });
    return undefined;
  }
}

interface ReadResult {
  rootDir: string;
  profile: LappProfile;
  diagnostics: Diagnostic[];
}

function readProfile(options: LoadProfileOptions): ReadResult {
  const rootDir = resolveLappRoot(options.path);
  const diagnostics: Diagnostic[] = [];
  const profile: LappProfile = attachProfileRoot({ providers: [] }, rootDir);
  if (!fs.existsSync(rootDir) || !fs.statSync(rootDir).isDirectory()) {
    diagnostics.push({ level: "ERROR", location: ".", message: "target directory does not exist" });
    return { rootDir, profile, diagnostics };
  }

  const globalJsonc = path.join(rootDir, "global.jsonc");
  if (fs.existsSync(globalJsonc)) {
    diagnostics.push({ level: "ERROR", location: "global.jsonc", message: "JSONC is not supported in LAPP v1" });
  }
  const globalFile = path.join(rootDir, "global.json");
  if (fs.existsSync(globalFile)) {
    const raw = parseJson(globalFile, rootDir, diagnostics);
    if (isObject(raw)) profile.global = raw as unknown as GlobalConfig;
    else if (raw !== undefined) {
      diagnostics.push({ level: "ERROR", location: "global.json", message: "global.json must contain an object" });
    }
  }

  const providersDir = path.join(rootDir, "providers");
  if (!fs.existsSync(providersDir) || !fs.statSync(providersDir).isDirectory()) {
    diagnostics.push({ level: "ERROR", location: "providers", message: "missing providers directory" });
    return { rootDir, profile, diagnostics };
  }

  const entries = fs.readdirSync(providersDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const providerDir = path.join(providersDir, entry.name);
    const providerFile = path.join(providerDir, "provider.json");
    const providerJsonc = path.join(providerDir, "provider.jsonc");
    const modelsFile = path.join(providerDir, "models.json");
    const modelsJsonc = path.join(providerDir, "models.jsonc");
    if (fs.existsSync(providerJsonc) || fs.existsSync(modelsJsonc)) {
      diagnostics.push({
        level: "ERROR",
        location: `providers/${entry.name}`,
        message: "JSONC is not supported in LAPP v1",
      });
    }
    if (!fs.existsSync(providerFile)) {
      diagnostics.push({
        level: "ERROR",
        location: `providers/${entry.name}`,
        message: "missing provider.json",
      });
      continue;
    }
    const providerRaw = parseJson(providerFile, rootDir, diagnostics);
    if (!isObject(providerRaw)) {
      if (providerRaw !== undefined) {
        diagnostics.push({
          level: "ERROR",
          location: relative(rootDir, providerFile),
          message: "provider.json must contain an object",
        });
      }
      continue;
    }
    if (typeof providerRaw.id === "string" && providerRaw.id !== entry.name) {
      diagnostics.push({
        level: "ERROR",
        location: relative(rootDir, providerFile),
        message: `provider id "${providerRaw.id}" does not match directory "${entry.name}"`,
      });
    }

    let models: ModelsConfig = { schemaVersion: "1.0", models: [] };
    if (fs.existsSync(modelsFile)) {
      const modelsRaw = parseJson(modelsFile, rootDir, diagnostics);
      if (isObject(modelsRaw)) models = modelsRaw as unknown as ModelsConfig;
      else if (modelsRaw !== undefined) {
        diagnostics.push({
          level: "ERROR",
          location: relative(rootDir, modelsFile),
          message: "models.json must contain an object",
        });
      }
    } else {
      diagnostics.push({
        level: "ERROR",
        location: `providers/${entry.name}`,
        message: "missing models.json",
      });
    }
    profile.providers.push({
      config: providerRaw as unknown as ProviderConfig,
      models,
    });
  }
  return { rootDir, profile, diagnostics };
}

function mergeDiagnostics(...groups: Diagnostic[][]): Diagnostic[] {
  const seen = new Set<string>();
  return groups.flat().filter((entry) => {
    const key = `${entry.level}\0${entry.location ?? ""}\0${entry.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function loadProfile(options: LoadProfileOptions = {}): LappProfile {
  const read = readProfile(options);
  const validation = validateProfile(read.profile);
  const diagnostics = mergeDiagnostics(read.diagnostics, validation.diagnostics);
  if (diagnostics.some((entry) => entry.level === "ERROR")) {
    throw new ProfileValidationError(diagnostics);
  }
  return read.profile;
}

function providerInspection(provider: LappProvider): ProfileInspection["providers"][number] {
  const rawAuth = isObject(provider.config.auth) ? provider.config.auth : undefined;
  const secret = rawAuth && "secret" in rawAuth && typeof rawAuth.secret === "string"
    ? rawAuth.secret
    : undefined;
  const ref = parseSecretRef(secret ?? "");
  const models = Array.isArray(provider.models.models) ? provider.models.models : [];
  return {
    id: typeof provider.config.id === "string" ? provider.config.id : "<invalid>",
    ...(typeof provider.config.name === "string" ? { name: provider.config.name } : {}),
    enabled: provider.config.enabled !== false,
    protocols: Array.isArray(provider.config.protocols)
      ? provider.config.protocols.filter((value): value is string => typeof value === "string")
      : [],
    ...(typeof provider.config.baseUrl === "string" ? { baseUrl: provider.config.baseUrl } : {}),
    secret: {
      scheme: ref.scheme,
      redacted: redactSecret(secret),
      resolvable: Boolean(secret)
        && (ref.scheme === "plaintext" || ref.scheme === "env" || ref.scheme === "vault"),
      plaintextWarning: Boolean(secret) && ref.plaintext,
    },
    modelCount: models.length,
    models: models.filter(isObject).map((model) => ({
      id: typeof model.id === "string" ? model.id : "<invalid>",
      ...(typeof model.name === "string" ? { name: model.name } : {}),
      ...(Array.isArray(model.aliases)
        ? { aliases: model.aliases.filter((value): value is string => typeof value === "string") }
        : {}),
      ...(typeof model.type === "string" ? { type: model.type } : {}),
      enabled: model.enabled !== false,
    })),
  };
}

export function inspectProfile(options: LoadProfileOptions = {}): ProfileInspection {
  const read = readProfile(options);
  const validation = validateProfile(read.profile);
  return {
    rootDir: read.rootDir,
    providers: read.profile.providers.map(providerInspection),
    ...(read.profile.global ? { global: read.profile.global } : {}),
    diagnostics: mergeDiagnostics(read.diagnostics, validation.diagnostics),
  };
}
