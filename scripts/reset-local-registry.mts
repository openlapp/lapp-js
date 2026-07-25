#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { legacyLocalNpmrc, localNpmrc, root } from "./local-registry-common.mjs";

const volumeName = "openlapp-verdaccio-storage";
if (!process.argv.includes(`--confirm=${volumeName}`)) {
  throw new Error(
    `Registry reset permanently deletes local packages and authentication; rerun with: pnpm registry:reset -- --confirm=${volumeName}`,
  );
}

const inspected = spawnSync(
  "docker",
  ["volume", "inspect", volumeName, "--format", "{{json .Labels}}"],
  { cwd: root, encoding: "utf8", shell: false },
);
if (inspected.error) throw inspected.error;
if (inspected.status === 0) {
  const labels = JSON.parse(inspected.stdout.trim()) as Record<string, string> | null;
  if (
    labels?.["com.docker.compose.project"] !== "openlapp-local-registry"
    || labels?.["com.docker.compose.volume"] !== "storage"
  ) {
    throw new Error(`${volumeName} is not the expected OpenLAPP Compose volume; refusing reset`);
  }
} else if (!`${inspected.stdout}${inspected.stderr}`.includes("No such volume")) {
  throw new Error(`could not inspect ${volumeName}; refusing reset`);
}

const composeFile = path.join(root, "dev", "registry", "compose.yaml");
const result = spawnSync(
  "docker",
  ["compose", "-f", composeFile, "down", "-v"],
  { cwd: root, encoding: "utf8", shell: false },
);
if (result.error) throw result.error;
if (result.status !== 0) {
  throw new Error(
    `docker compose down -v failed (${result.status ?? "spawn"})\n${result.stdout ?? ""}${result.stderr ?? ""}`,
  );
}
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
fs.rmSync(localNpmrc, { force: true });
fs.rmSync(`${localNpmrc}.backup`, { force: true });
fs.rmSync(`${localNpmrc}.bootstrap`, { force: true });
fs.rmSync(legacyLocalNpmrc, { force: true });
console.log("local Registry packages, user, signing state, and local token were deleted");
