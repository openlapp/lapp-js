import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { redactSecret, parseSecretRef } from "../secret/index.js";
import {
  ProfileValidationError,
  type AuthSource,
  type AuthSourceConfig,
  type Diagnostic,
  type GlobalConfig,
  type LappProfile,
  type LappProvider,
  type LappRegistry,
  type ModelsConfig,
  type ProfileInspection,
  type ProviderConfig,
} from "../types.js";
import { validateProfile } from "../validate/index.js";
import { isObject } from "../validate/constants.js";
import { attachAuthDirectory, attachProfileRoot, attachProviderDirectory } from "../profile-location.js";
import { parseIJson } from "../json/ijson.js";
import { readStable, type StableReadOptions } from "../writer/stable-read.js";
import { computeRegistryRevision } from "../manager/revision.js";

export interface LoadProfileOptions {
  path?: string;
  /** Stable-read attempts and state-home overrides. Defaults to three attempts. */
  stableRead?: Omit<StableReadOptions, "lockHeld">;
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
  const location = relative(root, file);
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(file);
  } catch {
    diagnostics.push({
      level: "ERROR",
      code: "FILE_ACCESS_FAILED",
      location,
      message: "JSON file could not be read",
    });
    return undefined;
  }
  const parsed = parseIJson(bytes);
  for (const finding of parsed.findings) {
    diagnostics.push({
      level: "ERROR",
      code: finding.code,
      location: finding.pointer ? `${location}#${finding.pointer}` : location,
      message: finding.message,
    });
  }
  return parsed.ok ? parsed.value : undefined;
}

function addDiagnostic(
  diagnostics: Diagnostic[],
  level: Diagnostic["level"],
  code: string,
  location: string,
  message: string,
): void {
  diagnostics.push({ level, code, location, message });
}

function requireRegularFile(
  file: string,
  root: string,
  label: string,
  missingCode: string,
  diagnostics: Diagnostic[],
  optional = false,
): boolean {
  const location = relative(root, file);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      if (!optional) addDiagnostic(diagnostics, "ERROR", missingCode, location, `missing required ${label}`);
      return false;
    }
    addDiagnostic(diagnostics, "ERROR", "FILE_ACCESS_FAILED", location, `${label} could not be inspected`);
    return false;
  }
  if (!stat.isFile()) {
    addDiagnostic(
      diagnostics,
      "ERROR",
      "NON_REGULAR_FILE",
      location,
      `${label} must be a regular file and must not be a symbolic link`,
    );
    return false;
  }
  return true;
}

interface ReadResult {
  rootDir: string;
  profile: LappProfile;
  diagnostics: Diagnostic[];
}

function readProfile(options: LoadProfileOptions, includeAuth = false): ReadResult {
  const rootDir = resolveLappRoot(options.path);
  const diagnostics: Diagnostic[] = [];
  const profile: LappProfile = attachProfileRoot({ providers: [] }, rootDir);
  let rootStat: fs.Stats | undefined;
  try {
    rootStat = fs.statSync(rootDir);
  } catch {
    // Canonical INVALID_ROOT below covers absence and inaccessible roots.
  }
  if (!rootStat?.isDirectory()) {
    addDiagnostic(diagnostics, "ERROR", "INVALID_ROOT", ".", "target must be an existing directory");
    return { rootDir, profile, diagnostics };
  }

  const globalJsonc = path.join(rootDir, "global.jsonc");
  if (fs.existsSync(globalJsonc)) {
    addDiagnostic(diagnostics, "ERROR", "UNSUPPORTED_FILE", "global.jsonc", "JSONC is not supported in LAPP v1");
  }
  for (const name of ["manifest.json", "manifest.jsonc"]) {
    if (fs.existsSync(path.join(rootDir, name))) {
      addDiagnostic(diagnostics, "ERROR", "UNSUPPORTED_FILE", name, "LAPP v1 does not support this file");
    }
  }
  const globalFile = path.join(rootDir, "global.json");
  if (requireRegularFile(globalFile, rootDir, "global.json", "MISSING_GLOBAL", diagnostics, true)) {
    const raw = parseJson(globalFile, rootDir, diagnostics);
    if (isObject(raw)) profile.global = raw as unknown as GlobalConfig;
    else if (raw !== undefined) {
      addDiagnostic(diagnostics, "ERROR", "SCHEMA_GLOBAL", "global.json", "global.json must contain an object");
    }
  }

  const providersDir = path.join(rootDir, "providers");
  let providersStat: fs.Stats | undefined;
  try {
    providersStat = fs.lstatSync(providersDir);
  } catch {
    // Canonical MISSING_PROVIDERS below covers absence and inaccessible paths.
  }
  if (!providersStat?.isDirectory() || providersStat.isSymbolicLink()) {
    if (!includeAuth) {
      addDiagnostic(diagnostics, "ERROR", "MISSING_PROVIDERS", "providers", "missing providers directory");
      return { rootDir, profile, diagnostics };
    }
    if (providersStat !== undefined) {
      addDiagnostic(diagnostics, "ERROR", "INVALID_PROVIDERS_DIRECTORY", "providers", "providers must be a real directory");
    }
  } else {
    const entries = fs.readdirSync(providersDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .sort((a, b) => Buffer.compare(Buffer.from(a.name, "utf8"), Buffer.from(b.name, "utf8")));
    for (const entry of entries) {
    const providerDir = path.join(providersDir, entry.name);
    const providerFile = path.join(providerDir, "provider.json");
    const providerJsonc = path.join(providerDir, "provider.jsonc");
    const modelsFile = path.join(providerDir, "models.json");
    const modelsJsonc = path.join(providerDir, "models.jsonc");
    for (const unsupported of [providerJsonc, modelsJsonc]) {
      if (fs.existsSync(unsupported)) {
        addDiagnostic(
          diagnostics,
          "ERROR",
          "UNSUPPORTED_FILE",
          relative(rootDir, unsupported),
          "JSONC is not supported in LAPP v1",
        );
      }
    }
    if (!requireRegularFile(
      providerFile,
      rootDir,
      "provider.json",
      "MISSING_PROVIDER",
      diagnostics,
    )) {
      continue;
    }
    const providerRaw = parseJson(providerFile, rootDir, diagnostics);
    if (!isObject(providerRaw)) {
      if (providerRaw !== undefined) {
        addDiagnostic(
          diagnostics,
          "ERROR",
          "SCHEMA_PROVIDER",
          relative(rootDir, providerFile),
          "provider.json must contain an object",
        );
      }
      continue;
    }
    if (typeof providerRaw.id === "string" && providerRaw.id !== entry.name) {
      addDiagnostic(
        diagnostics,
        "ERROR",
        "PROVIDER_DIRECTORY_MISMATCH",
        `${relative(rootDir, providerFile)}#/id`,
        `provider id "${providerRaw.id}" does not match directory "${entry.name}"`,
      );
    }

    let models: ModelsConfig = { schemaVersion: "1.0", models: [] };
    if (requireRegularFile(modelsFile, rootDir, "models.json", "MISSING_MODELS", diagnostics)) {
      const modelsRaw = parseJson(modelsFile, rootDir, diagnostics);
      if (isObject(modelsRaw)) models = modelsRaw as unknown as ModelsConfig;
      else if (modelsRaw !== undefined) {
        addDiagnostic(
          diagnostics,
          "ERROR",
          "SCHEMA_MODELS",
          relative(rootDir, modelsFile),
          "models.json must contain an object",
        );
      }
    }
      profile.providers.push(attachProviderDirectory({
        config: providerRaw as unknown as ProviderConfig,
        models,
      }, entry.name));
    }
  }

  if (includeAuth) {
    const authDir = path.join(rootDir, "auth");
    let authStat: fs.Stats | undefined;
    try {
      authStat = fs.lstatSync(authDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        addDiagnostic(diagnostics, "ERROR", "FILE_ACCESS_FAILED", "auth", "auth directory could not be inspected");
      }
    }
    if (authStat !== undefined) {
      if (!authStat.isDirectory() || authStat.isSymbolicLink()) {
        addDiagnostic(diagnostics, "ERROR", "INVALID_AUTH_DIRECTORY", "auth", "auth must be a real directory");
      } else {
        profile.auth = [];
        const authEntries = fs.readdirSync(authDir, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .sort((a, b) => Buffer.compare(Buffer.from(a.name, "utf8"), Buffer.from(b.name, "utf8")));
        for (const entry of authEntries) {
          const sourceDir = path.join(authDir, entry.name);
          const authFile = path.join(sourceDir, "auth.json");
          const modelsFile = path.join(sourceDir, "models.json");
          for (const unsupported of [
            path.join(sourceDir, "auth.jsonc"),
            path.join(sourceDir, "models.jsonc"),
          ]) {
            if (fs.existsSync(unsupported)) {
              addDiagnostic(
                diagnostics,
                "ERROR",
                "UNSUPPORTED_FILE",
                relative(rootDir, unsupported),
                "JSONC is not supported in LAPP 1.1",
              );
            }
          }
          if (!requireRegularFile(authFile, rootDir, "auth.json", "MISSING_AUTH", diagnostics)) {
            continue;
          }
          const authRaw = parseJson(authFile, rootDir, diagnostics);
          if (!isObject(authRaw)) {
            if (authRaw !== undefined) {
              addDiagnostic(
                diagnostics,
                "ERROR",
                "SCHEMA_AUTH",
                relative(rootDir, authFile),
                "auth.json must contain an object",
              );
            }
            continue;
          }
          if (typeof authRaw.id === "string" && authRaw.id !== entry.name) {
            addDiagnostic(
              diagnostics,
              "ERROR",
              "AUTH_DIRECTORY_MISMATCH",
              `${relative(rootDir, authFile)}#/id`,
              `auth id "${authRaw.id}" does not match directory "${entry.name}"`,
            );
          }
          let models: ModelsConfig = { schemaVersion: "1.0", models: [] };
          if (requireRegularFile(modelsFile, rootDir, "models.json", "MISSING_AUTH_MODELS", diagnostics)) {
            const modelsRaw = parseJson(modelsFile, rootDir, diagnostics);
            if (isObject(modelsRaw)) models = modelsRaw as unknown as ModelsConfig;
            else if (modelsRaw !== undefined) {
              addDiagnostic(
                diagnostics,
                "ERROR",
                "SCHEMA_MODELS",
                relative(rootDir, modelsFile),
                "models.json must contain an object",
              );
            }
          }
          const source: AuthSource = {
            config: authRaw as unknown as AuthSourceConfig,
            models,
          };
          profile.auth.push(attachAuthDirectory(source, entry.name));
        }
      }
    }
    const hasProviders = providersStat?.isDirectory() === true && !providersStat.isSymbolicLink();
    const hasAuth = authStat?.isDirectory() === true && !authStat.isSymbolicLink();
    if (profile.global?.schemaVersion !== "1.1" && authStat !== undefined) {
      addDiagnostic(
        diagnostics,
        "ERROR",
        "AUTH_REQUIRES_GLOBAL_1_1",
        "auth",
        "auth/ requires a valid global.json with schemaVersion 1.1",
      );
    }
    if (profile.global?.schemaVersion === "1.1" && !hasProviders && !hasAuth) {
      addDiagnostic(
        diagnostics,
        "ERROR",
        "MISSING_REGISTRY",
        ".",
        "LAPP 1.1 requires providers/ or auth/ to be a directory",
      );
    }
  }
  return { rootDir, profile, diagnostics };
}

function mergeDiagnostics(...groups: Diagnostic[][]): Diagnostic[] {
  const seen = new Set<string>();
  return groups.flat().filter((entry) => {
    const key = entry.code
      ? `${entry.level}\0${entry.code}\0${entry.location ?? ""}`
      : `${entry.level}\0${entry.location ?? ""}\0${entry.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** @internal Perform exactly one unbracketed filesystem read. */
export function loadProfileOnce(options: LoadProfileOptions = {}): LappProfile {
  const read = readProfile(options, false);
  const validation = validateProfile(read.profile);
  const diagnostics = mergeDiagnostics(read.diagnostics, validation.diagnostics);
  if (diagnostics.some((entry) => entry.level === "ERROR")) {
    throw new ProfileValidationError(diagnostics);
  }
  return read.profile;
}

/** @internal Perform one unbracketed LAPP 1.1 registry read. */
export function loadRegistryOnce(options: LoadProfileOptions = {}): LappRegistry {
  const read = readProfile(options, true);
  const validation = validateProfile(read.profile);
  const diagnostics = mergeDiagnostics(read.diagnostics, validation.diagnostics);
  if (diagnostics.some((entry) => entry.level === "ERROR")) {
    throw new ProfileValidationError(diagnostics, "invalid LAPP registry");
  }
  read.profile.auth ??= [];
  return read.profile as LappRegistry;
}

export function loadProfile(options: LoadProfileOptions = {}): LappProfile {
  return readProfileStable(options).value;
}

/** Read and validate one normative stable Profile snapshot with its CAS revision. */
export function readProfileStable(
  options: LoadProfileOptions = {},
): { value: LappProfile; revision: string } {
  const rootDir = resolveLappRoot(options.path);
  return readStable(
    rootDir,
    () => loadProfileOnce(options),
    options.stableRead,
  );
}

/** Read and validate one complete Provider + Auth registry snapshot using revision-v2. */
export function readRegistryStable(
  options: LoadProfileOptions = {},
): { value: LappRegistry; revision: string } {
  const rootDir = resolveLappRoot(options.path);
  return readStable(
    rootDir,
    () => loadRegistryOnce(options),
    options.stableRead,
    computeRegistryRevision,
  );
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
    ...(typeof provider.config.providerType === "string"
      ? { providerType: provider.config.providerType }
      : {}),
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

/** @internal Perform exactly one unbracketed recovery inspection. */
export function inspectProfileOnce(options: LoadProfileOptions = {}): ProfileInspection {
  const read = readProfile(options);
  const validation = validateProfile(read.profile);
  return {
    rootDir: read.rootDir,
    providers: read.profile.providers.map(providerInspection),
    ...(read.profile.global ? { global: read.profile.global } : {}),
    diagnostics: mergeDiagnostics(read.diagnostics, validation.diagnostics),
  };
}

export function inspectProfile(options: LoadProfileOptions = {}): ProfileInspection {
  const rootDir = resolveLappRoot(options.path);
  return readStable(
    rootDir,
    () => inspectProfileOnce(options),
    options.stableRead,
  ).value;
}
