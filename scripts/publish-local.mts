#!/usr/bin/env node
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  localNpmEnvironment,
  packageEntries,
  readRegistryMetadata,
  registry,
  runPnpm,
  verifyLocalIdentity,
  waitForRegistry,
  workspaceVersion,
} from "./local-registry-common.mjs";

await waitForRegistry();
const identity = await verifyLocalIdentity();
const version = workspaceVersion();
const existing = new Map<string, boolean>();
const metadataByPackage = new Map<string, Awaited<ReturnType<typeof readRegistryMetadata>>>();
for (const entry of packageEntries) {
  const metadata = await readRegistryMetadata(entry.name);
  metadataByPackage.set(entry.name, metadata);
  existing.set(entry.name, Boolean(metadata?.versions?.[version]));
}
const existingCount = [...existing.values()].filter(Boolean).length;
const allPackagesExist = existingCount === packageEntries.length;
if (!allPackagesExist && existingCount !== 0) {
  const present = [...existing].filter(([, value]) => value).map(([name]) => name);
  throw new Error(
    `partial local release ${version} already exists (${present.join(", ")}); `
      + "use a new internal version or deliberately run pnpm registry:reset",
  );
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "openlapp-local-publish-"));
const environment = localNpmEnvironment(path.join(temp, "npm-cache"));
const published: string[] = [];
try {
  process.stdout.write(runPnpm(["build"]));
  process.stdout.write(runPnpm(["smoke:pack"]));

  for (const entry of packageEntries) {
    process.stdout.write(runPnpm([
      "--filter",
      entry.name,
      "pack",
      "--pack-destination",
      temp,
    ]));
  }

  const tarballs = fs.readdirSync(temp).filter((file) => file.endsWith(".tgz"));
  const artifacts = packageEntries.map((entry) => {
    const tarball = tarballs.find((file) => file.startsWith(entry.tarballPrefix));
    if (!tarball) throw new Error(`missing packed tarball for ${entry.name}`);
    const file = path.join(temp, tarball);
    const integrity = `sha512-${createHash("sha512").update(fs.readFileSync(file)).digest("base64")}`;
    return { entry, file, integrity };
  });

  if (allPackagesExist) {
    const staleTags = packageEntries.filter((entry) =>
      metadataByPackage.get(entry.name)?.["dist-tags"]?.beta !== version);
    if (staleTags.length) {
      throw new Error(
        `local packages exist but beta tags differ: ${staleTags.map((entry) =>
          `${entry.name}=${metadataByPackage.get(entry.name)?.["dist-tags"]?.beta ?? "missing"}`).join(", ")}`,
      );
    }
    const changed = artifacts.filter(({ entry, integrity }) =>
      metadataByPackage.get(entry.name)?.versions?.[version]?.dist?.integrity !== integrity);
    if (changed.length) {
      throw new Error(
        `local Registry already contains different bytes for ${changed.map(({ entry }) => entry.name).join(", ")}@${version}; `
          + "increment the immutable internal version before publishing",
      );
    }
    console.log(
      `all OpenLAPP packages ${version} already exist in ${registry.origin} with matching SHA-512 integrity; nothing published`,
    );
  } else {
    for (const { entry, file } of artifacts) {
      process.stdout.write(runPnpm([
        "publish",
        file,
        "--registry",
        registry.href,
        "--tag",
        "beta",
        "--access",
        "public",
        "--no-git-checks",
      ], { env: environment }));
      published.push(entry.name);
    }

    for (const { entry, integrity } of artifacts) {
      const metadata = await readRegistryMetadata(entry.name);
      if (
        !metadata?.versions?.[version]
        || metadata["dist-tags"]?.beta !== version
        || metadata.versions[version]?.dist?.integrity !== integrity
      ) {
        throw new Error(
          `${entry.name}@${version} is missing, changed, or lacks the beta dist-tag after publish`,
        );
      }
    }
    console.log(
      `published ${packageEntries.length} OpenLAPP packages at ${version} to ${registry.origin} as ${identity}`,
    );
  }
} catch (error) {
  if (published.length) {
    throw new Error(
      `local publish stopped after ${published.join(", ")}; use a new version or reset the local Registry`,
      { cause: error },
    );
  }
  throw error;
} finally {
  fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
