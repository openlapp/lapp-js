#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";

const [packageName, version, distTag] = process.argv.slice(2);
if (!packageName || !version || !distTag) {
  throw new Error("usage: publish-if-missing.mjs <package> <version> <dist-tag>");
}
const publishablePackages = new Set([
  "@openlapp/lapp",
]);
if (!publishablePackages.has(packageName)) throw new Error(`unexpected package: ${packageName}`);
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(version)) {
  throw new Error(`invalid package version: ${version}`);
}
if (!/^[0-9A-Za-z][0-9A-Za-z._-]*$/u.test(distTag)) throw new Error(`invalid dist-tag: ${distTag}`);

const windows = process.platform === "win32";
const npm = windows ? "npm.cmd" : "npm";
const pnpm = windows ? "pnpm.cmd" : "pnpm";
const registry = "https://registry.npmjs.org";
const packageSpec = `${packageName}@${version}`;

function record(message) {
  console.log(message);
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `- ${message}\n`, "utf8");
  }
}

const lookup = spawnSync(
  npm,
  ["view", packageSpec, "version", "--json", "--registry", registry],
  { encoding: "utf8", shell: windows },
);
if (lookup.error) throw lookup.error;

if (lookup.status === 0) {
  const publishedVersion = JSON.parse(lookup.stdout.trim());
  if (publishedVersion !== version) {
    throw new Error(`npm returned an unexpected version for ${packageSpec}: ${publishedVersion}`);
  }
  record(`${packageSpec} already exists; skipped publish`);
  process.exit(0);
}

const lookupOutput = `${lookup.stdout}\n${lookup.stderr}`;
const isMissing = /"code"\s*:\s*"E404"|\bnpm error code E404\b|\b404 Not Found\b/u.test(lookupOutput);
if (!isMissing) {
  process.stderr.write(lookupOutput);
  throw new Error(`could not determine whether ${packageSpec} is already published`);
}

record(`${packageSpec} is not published; publishing with dist-tag ${distTag}`);
const published = spawnSync(
  pnpm,
  [
    "--filter",
    packageName,
    "publish",
    "--access",
    "public",
    "--no-git-checks",
    "--tag",
    distTag,
  ],
  { shell: windows, stdio: "inherit" },
);
if (published.error) throw published.error;
if (published.status !== 0) process.exit(published.status ?? 1);

record(`${packageSpec} published with dist-tag ${distTag}`);
