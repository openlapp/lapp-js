/**
 * LAPP path discovery and profile loading.
 *
 * Read order follows `../lapp/implementation.en.md`:
 *   1. Resolve root: explicit `path` > `LAPP_HOME` > `~/.lapp`.
 *   2. Scan `providers/<id>/provider.json` (or `.jsonc`).
 *   3. Keep providers with `enabled: false` in the profile (the client and
 *      env-export skip them at resolution time); emit an INFO diagnostic.
 *      Preserved so writes round-trip the on-disk file.
 *   4. Load `models.json`/`.jsonc` when present.
 *   5. Load `global.json`/`.jsonc` when present.
 *   6. Load `manifest.json`/`.jsonc` when present.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { findConfigFile, readJsonc, relativeLocation } from "./jsonc.js";
import { validateProfile } from "../validate/index.js";
import { redactSecret, parseSecretRef } from "../secret/index.js";
import { CORE_PROTOCOLS, isObject } from "../validate/constants.js";
import type {
  Diagnostic,
  GlobalConfig,
  LappProfile,
  LappProvider,
  ManifestConfig,
  ModelsConfig,
  ProfileSummary,
  ProviderConfig,
  SecretSummary,
} from "../types.js";

export interface LoadProfileOptions {
  /** Explicit `.lapp` root directory. Overrides `LAPP_HOME` and `~/.lapp`. */
  path?: string;
  /** Skip validation diagnostics (only parse). */
  skipValidate?: boolean;
}

/**
 * Resolve the LAPP root directory.
 * Order: explicit path > `LAPP_HOME` env > `~/.lapp`.
 */
export function resolveLappRoot(explicit?: string): string {
  if (explicit) return path.resolve(explicit);
  if (process.env.LAPP_HOME) return path.resolve(process.env.LAPP_HOME);
  return path.join(os.homedir(), ".lapp");
}

function loadManifest(root: string, diagnostics: Diagnostic[]): ManifestConfig | undefined {
  const file = findConfigFile(root, "manifest");
  if (!file) return undefined;
  try {
    const data = readJsonc(file) as unknown;
    if (!isObject(data)) {
      diagnostics.push({
        level: "ERROR",
        location: relativeLocation(root, file),
        message: "manifest must be a JSON object",
      });
      return undefined;
    }
    return data as unknown as ManifestConfig;
  } catch (err) {
    diagnostics.push({
      level: "ERROR",
      location: relativeLocation(root, file),
      message: `invalid JSON/JSONC in manifest: ${(err as Error).message}`,
    });
    return undefined;
  }
}

function loadGlobal(root: string, diagnostics: Diagnostic[]): GlobalConfig | undefined {
  const file = findConfigFile(root, "global");
  if (!file) return undefined;
  try {
    const data = readJsonc(file) as unknown;
    if (!isObject(data)) {
      diagnostics.push({
        level: "ERROR",
        location: relativeLocation(root, file),
        message: "global must be a JSON object",
      });
      return undefined;
    }
    return data as unknown as GlobalConfig;
  } catch (err) {
    diagnostics.push({
      level: "ERROR",
      location: relativeLocation(root, file),
      message: `invalid JSON/JSONC in global: ${(err as Error).message}`,
    });
    return undefined;
  }
}

function loadProvider(
  providerDir: string,
  root: string,
  diagnostics: Diagnostic[],
): LappProvider | null {
  const dirName = path.basename(providerDir);
  const providerFile = findConfigFile(providerDir, "provider");
  if (!providerFile) {
    diagnostics.push({
      level: "ERROR",
      location: `providers/${dirName}`,
      message: "missing provider.json or provider.jsonc",
    });
    return null;
  }

  let config: ProviderConfig;
  try {
    const data = readJsonc(providerFile) as unknown;
    if (!isObject(data)) {
      throw new Error("provider must be a JSON object");
    }
    config = data as unknown as ProviderConfig;
  } catch (err) {
    diagnostics.push({
      level: "ERROR",
      location: relativeLocation(root, providerFile),
      message: `invalid JSON/JSONC in provider.json: ${(err as Error).message}`,
    });
    return null;
  }

  config.__file = providerFile;
  config.__dirName = dirName;

  if (typeof config.id === "string" && config.id !== dirName) {
    diagnostics.push({
      level: "WARN",
      location: relativeLocation(root, providerFile),
      message: `provider id "${config.id}" does not match directory "${dirName}"`,
    });
  }

  if (typeof config.protocol === "string" && !CORE_PROTOCOLS.has(config.protocol)) {
    diagnostics.push({
      level: "WARN",
      location: relativeLocation(root, providerFile),
      message: `protocol "${config.protocol}" is not a core LAPP v1 protocol`,
    });
  }

  if (typeof config.baseUrl === "string" && config.baseUrl.endsWith("/")) {
    diagnostics.push({
      level: "WARN",
      location: relativeLocation(root, providerFile),
      message: "baseUrl should not end with /",
    });
  }

  // Load models.json/jsonc if present.
  let models: ModelsConfig | null = null;
  const modelsFile = findConfigFile(providerDir, "models");
  if (modelsFile) {
    try {
      const data = readJsonc(modelsFile) as unknown;
      if (!isObject(data) || !Array.isArray((data as Record<string, unknown>).models)) {
        throw new Error("models must be an object with a models array");
      }
      models = data as unknown as ModelsConfig;
    } catch (err) {
      diagnostics.push({
        level: "ERROR",
        location: relativeLocation(root, modelsFile),
        message: `invalid JSON/JSONC in models.json: ${(err as Error).message}`,
      });
    }
  }

  return { config, models, dir: providerDir };
}

/**
 * Load and normalize a LAPP profile from disk.
 */
export function loadProfile(options: LoadProfileOptions = {}): LappProfile {
  const root = resolveLappRoot(options.path);
  const diagnostics: Diagnostic[] = [];

  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    diagnostics.push({ level: "ERROR", location: ".", message: "target directory does not exist" });
    return { rootDir: root, providers: [], diagnostics };
  }

  const manifest = loadManifest(root, diagnostics);
  const global = loadGlobal(root, diagnostics);

  const providers: LappProvider[] = [];
  const providersDir = path.join(root, "providers");
  if (!fs.existsSync(providersDir) || !fs.statSync(providersDir).isDirectory()) {
    diagnostics.push({ level: "ERROR", location: "providers", message: "missing providers/ directory" });
  } else {
    const entries = fs.readdirSync(providersDir, { withFileTypes: true });
    const providerDirs = entries
      .filter((e) => {
        // Skip hidden directories (`.tmp-XXXX` leftovers, `.bak`, etc.)
        // and non-directories; the writers use dot-prefixed temp files
        // but those should never appear as subdirectories.
        if (!e.isDirectory()) return false;
        if (e.name.startsWith(".")) return false;
        return true;
      })
      .map((e) => path.join(providersDir, e.name))
      .sort((a, b) => a.localeCompare(b));
    for (const dir of providerDirs) {
      // Cheap pre-check: skip dirs that have no provider.json/jsonc so a
      // user-created notes/ or scratch/ subdir doesn't emit a missing-
      // provider.json ERROR on every load. The full check is repeated
      // inside loadProvider for a definitive answer.
      if (!findConfigFile(dir, "provider")) continue;
      const loaded = loadProvider(dir, root, diagnostics);
      if (loaded) {
        // Disabled providers are kept in the profile so a later write can
        // round-trip them (preserving files on disk). The client SDK skips
        // disabled providers when resolving targets.
        if (loaded.config.enabled === false) {
          diagnostics.push({
            level: "INFO",
            location: relativeLocation(root, loaded.config.__file!),
            message: `provider "${loaded.config.id}" is disabled`,
          });
        }
        providers.push(loaded);
      }
    }
  }

  const profile: LappProfile = { rootDir: root, manifest, global, providers, diagnostics };

  if (!options.skipValidate) {
    const result = validateProfile(profile);
    // Merge validator diagnostics (dedupe by location+message).
    for (const d of result.diagnostics) {
      if (!diagnostics.some((x) => x.level === d.level && x.location === d.location && x.message === d.message)) {
        diagnostics.push(d);
      }
    }
  }

  return profile;
}

/**
 * Summarize a profile for inspection. Secrets are redacted by default; pass
 * `revealSecrets: true` only in trusted paths.
 */
export function inspectProfile(
  profile: LappProfile,
  options: { revealSecrets?: boolean } = {},
): ProfileSummary {
  return {
    rootDir: profile.rootDir,
    global: profile.global,
    diagnostics: profile.diagnostics,
    providers: profile.providers.map((p) => {
      const secretRaw = p.config.auth?.secret;
      const ref = typeof secretRaw === "string" ? parseSecretRef(secretRaw) : null;
      const summary: SecretSummary = ref
        ? {
            scheme: ref.scheme,
            redacted: options.revealSecrets ? (secretRaw as string) : redactSecret(secretRaw as string),
            resolvable: ref.scheme === "plaintext" || ref.scheme === "env",
            plaintextWarning: ref.plaintext,
          }
        : {
            // No secret configured; revealSecrets has nothing to reveal here.
            scheme: "plaintext",
            redacted: "<unset>",
            resolvable: false,
            plaintextWarning: false,
          };

      return {
        id: p.config.id,
        name: p.config.name,
        enabled: p.config.enabled !== false,
        protocol: p.config.protocol,
        baseUrl: p.config.baseUrl,
        coreProtocol: CORE_PROTOCOLS.has(p.config.protocol),
        secret: summary,
        modelCount: p.models?.models.length ?? 0,
        models: (p.models?.models ?? []).map((m) => ({
          id: m.id,
          name: m.name,
          aliases: m.aliases,
          type: m.type,
          enabled: m.enabled !== false,
        })),
      };
    }),
  };
}