import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const registry = new URL("http://127.0.0.1:4873/");
export const localRegistryUsername = "openlapp-local";
const userDataDirectory = process.platform === "win32"
  ? process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local")
  : process.platform === "darwin"
    ? path.join(os.homedir(), "Library", "Application Support")
    : process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state");
export const localNpmrc = path.join(userDataDirectory, "OpenLAPP", "local-registry", "npmrc");
export const legacyLocalNpmrc = path.join(root, "dev", "registry", ".npmrc.local");
export const packageEntries = [
  { name: "@openlapp/lapp", directory: "lapp", tarballPrefix: "openlapp-lapp-" },
  { name: "@openlapp/cli", directory: "cli", tarballPrefix: "openlapp-cli-" },
] as const;

export interface PackageManifest {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  exports?: Record<string, unknown>;
  publishConfig?: { access?: string; registry?: string };
}

export interface RegistryMetadata {
  versions?: Record<string, {
    dist?: { integrity?: string; tarball?: string };
  }>;
  "dist-tags"?: Record<string, string>;
}

function assertLoopbackRegistry(): void {
  const hostname = registry.hostname.toLowerCase();
  if (!(["127.0.0.1", "localhost", "[::1]", "::1"].includes(hostname))) {
    throw new Error(`local Registry must use a loopback host, received ${registry.origin}`);
  }
  if (registry.username || registry.password || registry.search || registry.hash) {
    throw new Error("local Registry URL must not contain credentials, query, or fragment data");
  }
  if (registry.pathname !== "/") {
    throw new Error(`local Registry must use its origin root, received ${registry.href}`);
  }
}

assertLoopbackRegistry();

export function readManifest(file: string): PackageManifest {
  return JSON.parse(fs.readFileSync(file, "utf8")) as PackageManifest;
}

export function workspaceVersion(): string {
  const rootManifest = readManifest(path.join(root, "package.json"));
  const versions = new Map<string, string>([[rootManifest.name, rootManifest.version]]);
  for (const entry of packageEntries) {
    const manifest = readManifest(path.join(root, "packages", entry.directory, "package.json"));
    if (manifest.publishConfig?.registry !== registry.href) {
      throw new Error(
        `${entry.name} must target the loopback Registry while using an internal 0.x version`,
      );
    }
    versions.set(manifest.name, manifest.version);
  }
  const unique = [...new Set(versions.values())];
  if (unique.length !== 1) {
    throw new Error(
      `local package versions must match: ${[...versions].map(([name, version]) => `${name}=${version}`).join(", ")}`,
    );
  }
  const version = unique[0]!;
  if (!/^0\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) {
    throw new Error(`local beta publishing requires an internal 0.x version, received ${version}`);
  }
  return version;
}

export function readLocalToken(): string {
  let text: string;
  try {
    text = fs.readFileSync(localNpmrc, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("local Registry credentials are missing; run pnpm registry:init");
    }
    throw error;
  }
  const token = text.match(/:_authToken=([^\r\n]+)/u)?.[1]?.trim();
  if (!token) throw new Error(`${localNpmrc} does not contain an authentication token`);
  return token;
}

export function authHeaders(token = readLocalToken()): HeadersInit {
  return { authorization: `Bearer ${token}` };
}

async function fetchWithRetry(
  input: URL,
  init?: RequestInit,
  attempts = 4,
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(input, {
        ...init,
        signal: init?.signal ?? AbortSignal.timeout(5_000),
      });
      if (response.status < 500 || attempt === attempts) return response;
      await response.arrayBuffer();
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
    }
    await new Promise((resolve) => setTimeout(resolve, attempt * 200));
  }
  throw new Error(`Registry request failed after ${attempts} attempts: ${input.href}`, {
    cause: lastError,
  });
}

export async function waitForRegistry(timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(new URL("-/ping", registry), {
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) return;
      lastError = new Error(`Registry ping returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`local Registry did not become ready at ${registry.origin}`, { cause: lastError });
}

export async function verifyLocalIdentity(token = readLocalToken()): Promise<string> {
  const response = await fetchWithRetry(new URL("-/whoami", registry), {
    headers: authHeaders(token),
  });
  if (!response.ok) {
    throw new Error(`local Registry token was rejected with HTTP ${response.status}`);
  }
  const body = await response.json() as { username?: string };
  if (!body.username) throw new Error("local Registry returned an invalid identity response");
  if (body.username !== localRegistryUsername) {
    throw new Error(
      `local Registry token belongs to ${body.username}, expected ${localRegistryUsername}`,
    );
  }
  return body.username;
}

export function packageMetadataUrl(packageName: string): URL {
  return new URL(packageName.replace("/", "%2f"), registry);
}

export async function readRegistryMetadata(
  packageName: string,
  token = readLocalToken(),
): Promise<RegistryMetadata | undefined> {
  const response = await fetchWithRetry(packageMetadataUrl(packageName), {
    headers: authHeaders(token),
  });
  if (response.status === 404) return undefined;
  if (!response.ok) {
    throw new Error(`could not inspect ${packageName}: Registry returned HTTP ${response.status}`);
  }
  return await response.json() as RegistryMetadata;
}

export function runPnpm(
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): string {
  const pnpmEntrypoint = process.env.npm_execpath;
  const command = pnpmEntrypoint ? process.execPath : process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const commandArgs = pnpmEntrypoint ? [pnpmEntrypoint, ...args] : args;
  const result = spawnSync(command, commandArgs, {
    cwd: options.cwd ?? root,
    encoding: "utf8",
    env: options.env ?? process.env,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `pnpm ${args.join(" ")} failed (${result.status ?? "spawn"})\n${result.stdout ?? ""}${result.stderr ?? ""}`,
    );
  }
  if (result.stderr) process.stderr.write(result.stderr);
  return result.stdout;
}

export function localNpmEnvironment(cacheDirectory: string): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    const normalized = key.toLowerCase();
    if (
      normalized === "node_auth_token"
      || normalized === "npm_token"
      || normalized === "yarn_npm_auth_token"
      || normalized === "npm_config_registry"
      || normalized === "npm_config_userconfig"
      || normalized === "npm_config_cache"
      || (normalized.startsWith("npm_config_") && normalized.includes("auth"))
    ) {
      delete environment[key];
    }
  }
  return {
    ...environment,
    NPM_CONFIG_USERCONFIG: localNpmrc,
    NPM_CONFIG_CACHE: cacheDirectory,
    npm_config_userconfig: localNpmrc,
    npm_config_cache: cacheDirectory,
  };
}
