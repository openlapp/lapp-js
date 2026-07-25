#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  authHeaders,
  localNpmEnvironment,
  packageEntries,
  packageMetadataUrl,
  readManifest,
  readRegistryMetadata,
  registry,
  runPnpm,
  verifyLocalIdentity,
  waitForRegistry,
  workspaceVersion,
} from "./local-registry-common.mjs";

function runNode(args: string[], cwd: string, env?: NodeJS.ProcessEnv): string {
  const result = spawnSync(process.execPath, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`node ${args.join(" ")} failed\n${result.stdout ?? ""}${result.stderr ?? ""}`);
  }
  return result.stdout;
}

await waitForRegistry();
await verifyLocalIdentity();
const version = workspaceVersion();
const metadataByPackage = new Map<string, Awaited<ReturnType<typeof readRegistryMetadata>>>();
for (const entry of packageEntries) {
  const metadata = await readRegistryMetadata(entry.name);
  metadataByPackage.set(entry.name, metadata);
  if (!metadata?.versions?.[version]) {
    throw new Error(`${entry.name}@${version} is not published; run pnpm registry:publish`);
  }
  if (metadata["dist-tags"]?.beta !== version) {
    throw new Error(`${entry.name} does not point its beta dist-tag at ${version}`);
  }

  const anonymousMetadata = await fetch(packageMetadataUrl(entry.name), {
    redirect: "error",
    signal: AbortSignal.timeout(5_000),
  });
  if (anonymousMetadata.status !== 401 && anonymousMetadata.status !== 403) {
    throw new Error(`${entry.name} metadata is readable without authentication`);
  }
  const tarball = metadata.versions[version]?.dist?.tarball;
  if (!tarball) throw new Error(`${entry.name}@${version} metadata lacks a tarball URL`);
  const tarballUrl = new URL(tarball);
  if (tarballUrl.origin !== registry.origin) {
    throw new Error(`${entry.name}@${version} points outside the loopback Registry`);
  }
  const anonymousTarball = await fetch(tarballUrl, {
    redirect: "error",
    signal: AbortSignal.timeout(5_000),
  });
  if (anonymousTarball.status !== 401 && anonymousTarball.status !== 403) {
    throw new Error(`${entry.name}@${version} tarball is readable without authentication`);
  }
}

const blockedScope = await fetch(packageMetadataUrl("@not-openlapp/probe"), {
  headers: authHeaders(),
  redirect: "error",
  signal: AbortSignal.timeout(5_000),
});
if (blockedScope.status !== 401 && blockedScope.status !== 403) {
  throw new Error(`non-OpenLAPP scope was not denied (HTTP ${blockedScope.status})`);
}
const missingLocalPackage = await fetch(packageMetadataUrl("@openlapp/registry-smoke-missing"), {
  headers: authHeaders(),
  redirect: "error",
  signal: AbortSignal.timeout(5_000),
});
if (missingLocalPackage.status !== 404) {
  throw new Error(`missing OpenLAPP package did not stay local (HTTP ${missingLocalPackage.status})`);
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "openlapp-registry-consumer-"));
let nativeVaultRef: string | undefined;
try {
  fs.writeFileSync(path.join(temp, "package.json"), `${JSON.stringify({
    name: "openlapp-local-registry-smoke",
    version: "0.0.0",
    private: true,
    type: "module",
    dependencies: {
      "@openlapp/lapp": version,
      "@openlapp/cli": version,
    },
  }, null, 2)}\n`, "utf8");

  const environment = localNpmEnvironment(path.join(temp, "npm-cache"));
  process.stdout.write(runPnpm([
    "install",
    "--store-dir",
    path.join(temp, "pnpm-store"),
  ], { cwd: temp, env: environment }));

  const installed = new Map<string, ReturnType<typeof readManifest>>();
  for (const entry of packageEntries) {
    const manifest = readManifest(path.join(temp, "node_modules", ...entry.name.split("/"), "package.json"));
    if (manifest.version !== version) {
      throw new Error(`installed ${entry.name}@${manifest.version}; expected ${version}`);
    }
    for (const field of ["dependencies", "optionalDependencies", "peerDependencies"] as const) {
      if (Object.values(manifest[field] ?? {}).some((value) => value.startsWith("workspace:"))) {
        throw new Error(`installed ${entry.name} still contains a workspace: ${field} entry`);
      }
    }
    installed.set(entry.name, manifest);
  }
  for (const name of ["@openlapp/cli"]) {
    if (installed.get(name)?.dependencies?.["@openlapp/lapp"] !== version) {
      throw new Error(`${name} does not depend on exact @openlapp/lapp@${version}`);
    }
  }
  runNode(["--input-type=module", "-e", "const m=await import('@openlapp/lapp');if(typeof m.loadProfile!=='function')process.exit(1)"], temp);
  runNode(["-e", "const m=require('@openlapp/lapp');if(typeof m.loadProfile!=='function')process.exit(1)"], temp);
  if (process.platform === "win32") {
    const credentialId = `probe-${randomUUID().replaceAll("-", "")}`;
    nativeVaultRef = `vault://registry-smoke/${credentialId}`;
    const binding = JSON.stringify({
      providerId: "registry-smoke",
      origin: "https://example.invalid",
      auth: { type: "bearer" },
    });
    const firstSecret = `registry-one-${randomUUID()}`;
    const rotatedSecret = `registry-two-${randomUUID()}`;
    const vaultEnvironment = {
      LAPP_REGISTRY_SMOKE_BINDING: binding,
      LAPP_REGISTRY_SMOKE_REF: nativeVaultRef,
    };
    runNode([
      "--input-type=module",
      "-e",
      "const m=await import('@openlapp/lapp');const v=await m.openSystemCredentialVault();await v.put(process.env.LAPP_REGISTRY_SMOKE_REF,process.env.LAPP_REGISTRY_SMOKE_SECRET,JSON.parse(process.env.LAPP_REGISTRY_SMOKE_BINDING));const s=await v.status(process.env.LAPP_REGISTRY_SMOKE_REF,JSON.parse(process.env.LAPP_REGISTRY_SMOKE_BINDING));if(!s.exists||!s.bindingMatches)process.exit(1)",
    ], temp, { ...vaultEnvironment, LAPP_REGISTRY_SMOKE_SECRET: firstSecret });
    const firstHash = runNode([
      "--input-type=module",
      "-e",
      "const {createHash}=await import('node:crypto');const m=await import('@openlapp/lapp');const v=await m.openSystemCredentialVault();const s=await v.resolve(process.env.LAPP_REGISTRY_SMOKE_REF,JSON.parse(process.env.LAPP_REGISTRY_SMOKE_BINDING));process.stdout.write(createHash('sha256').update(s).digest('hex'))",
    ], temp, vaultEnvironment).trim();
    if (firstHash !== createHash("sha256").update(firstSecret).digest("hex")) {
      throw new Error("Registry-installed Vault did not resolve the first credential across processes");
    }
    runNode([
      "--input-type=module",
      "-e",
      "const m=await import('@openlapp/lapp');const v=await m.openSystemCredentialVault();await v.put(process.env.LAPP_REGISTRY_SMOKE_REF,process.env.LAPP_REGISTRY_SMOKE_SECRET,JSON.parse(process.env.LAPP_REGISTRY_SMOKE_BINDING),{overwrite:true})",
    ], temp, { ...vaultEnvironment, LAPP_REGISTRY_SMOKE_SECRET: rotatedSecret });
    const rotatedHash = runNode([
      "--input-type=module",
      "-e",
      "const {createHash}=await import('node:crypto');const m=await import('@openlapp/lapp');const v=await m.openSystemCredentialVault();const s=await v.resolve(process.env.LAPP_REGISTRY_SMOKE_REF,JSON.parse(process.env.LAPP_REGISTRY_SMOKE_BINDING));process.stdout.write(createHash('sha256').update(s).digest('hex'))",
    ], temp, vaultEnvironment).trim();
    if (rotatedHash !== createHash("sha256").update(rotatedSecret).digest("hex")) {
      throw new Error("Registry-installed Vault did not expose the rotated credential");
    }
    runNode([
      "--input-type=module",
      "-e",
      "const m=await import('@openlapp/lapp');const v=await m.openSystemCredentialVault();if(!await v.delete(process.env.LAPP_REGISTRY_SMOKE_REF))process.exit(1);try{await v.resolve(process.env.LAPP_REGISTRY_SMOKE_REF,JSON.parse(process.env.LAPP_REGISTRY_SMOKE_BINDING));process.exit(1)}catch(e){if(e?.code!=='VAULT_CREDENTIAL_NOT_FOUND')throw e}",
    ], temp, vaultEnvironment);
    nativeVaultRef = undefined;
  }
  runNode(["--input-type=module", "-e", "const m=await import('@openlapp/lapp/manager-contract');if(m.LAPP_MANAGER_BRIDGE_PROTOCOL_VERSION!==1)process.exit(1)"], temp);
  runNode(["-e", "const m=require('@openlapp/lapp/manager-contract');if(m.LAPP_MANAGER_BRIDGE_PROTOCOL_VERSION!==1)process.exit(1)"], temp);
  runNode(["--input-type=module", "-e", "const m=await import('@openlapp/lapp/manager-host');if(typeof m.createNodeLappManagerHost!=='function')process.exit(1)"], temp);
  runNode(["-e", "const m=require('@openlapp/lapp/manager-host');if(typeof m.createNodeLappManagerHost!=='function')process.exit(1)"], temp);
  const cliVersion = runPnpm(["exec", "lapp", "--version"], { cwd: temp, env: environment }).trim();
  if (cliVersion !== `lapp ${version}`) throw new Error(`unexpected installed CLI version: ${cliVersion}`);

  console.log(`local Registry smoke passed: two packages at ${version} installed from ${registry.origin}`);
} finally {
  if (nativeVaultRef) {
    runNode([
      "--input-type=module",
      "-e",
      "const m=await import('@openlapp/lapp');const v=await m.openSystemCredentialVault();await v.delete(process.env.LAPP_REGISTRY_SMOKE_REF)",
    ], temp, { LAPP_REGISTRY_SMOKE_REF: nativeVaultRef });
  }
  fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
