#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const canonicalRoot = path.resolve(root, "..", "lapp");
const canonical = path.join(canonicalRoot, "schema");
const vendored = path.resolve(root, "packages", "lapp", "schema");
const packageRoots = [
  path.resolve(root, "packages", "lapp"),
  path.resolve(root, "packages", "cli"),
];
const lock = JSON.parse(fs.readFileSync(path.resolve(root, "spec-lock.json"), "utf8"));
if (!/^[0-9a-f]{40}$/.test(lock.canonicalCommit ?? "")) {
  console.error("spec-lock.json must contain a full canonicalCommit SHA");
  process.exit(1);
}

const schemaFiles = (directory) => fs.readdirSync(directory)
  .filter((name) => name.endsWith(".schema.json"))
  .sort();
const vendoredFiles = schemaFiles(vendored);
const lockedFiles = Object.keys(lock.schemas).sort();
if (JSON.stringify(lockedFiles) !== JSON.stringify(vendoredFiles)) {
  console.error(`schema file set drift\nlocked: ${lockedFiles.join(", ")}\nvendored: ${vendoredFiles.join(", ")}`);
  process.exit(1);
}

for (const file of vendoredFiles) {
  const copy = fs.readFileSync(path.join(vendored, file));
  const digest = crypto.createHash("sha256").update(copy).digest("hex");
  if (digest !== lock.schemas[file]) {
    console.error(`schema lock drift: ${file}`);
    process.exit(1);
  }
}

const documentFiles = Object.keys(lock.documents ?? {}).sort();
for (const file of documentFiles) {
  const reference = fs.readFileSync(path.join(packageRoots[0], file));
  const digest = crypto.createHash("sha256").update(reference).digest("hex");
  if (digest !== lock.documents[file]) {
    console.error(`document lock drift: ${file}`);
    process.exit(1);
  }
  for (const packageRoot of packageRoots.slice(1)) {
    if (!reference.equals(fs.readFileSync(path.join(packageRoot, file)))) {
      console.error(`package document drift: ${file}`);
      process.exit(1);
    }
  }
}

if (fs.existsSync(canonical)) {
  let actualCommit;
  try {
    actualCommit = execFileSync("git", [
      "-c",
      `safe.directory=${canonicalRoot.replaceAll("\\", "/")}`,
      "-C",
      canonicalRoot,
      "rev-parse",
      "HEAD",
    ], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    console.error(`canonical checkout is not a Git repository: ${canonicalRoot}`);
    process.exit(1);
  }
  if (actualCommit !== lock.canonicalCommit) {
    console.error(`canonical commit drift\nlocked: ${lock.canonicalCommit}\nactual: ${actualCommit}`);
    process.exit(1);
  }
  const canonicalFiles = schemaFiles(canonical);
  if (JSON.stringify(canonicalFiles) !== JSON.stringify(vendoredFiles)) {
    console.error(`canonical schema file set drift\ncanonical: ${canonicalFiles.join(", ")}\nvendored: ${vendoredFiles.join(", ")}`);
    process.exit(1);
  }
  for (const file of canonicalFiles) {
    const source = fs.readFileSync(path.join(canonical, file));
    const copy = fs.readFileSync(path.join(vendored, file));
    if (!source.equals(copy)) {
      console.error(`canonical schema drift: ${file}`);
      process.exit(1);
    }
  }
  for (const file of documentFiles) {
    const source = fs.readFileSync(path.join(canonicalRoot, file));
    const copy = fs.readFileSync(path.join(packageRoots[0], file));
    if (!source.equals(copy)) {
      console.error(`canonical document drift: ${file}`);
      process.exit(1);
    }
  }
}

console.log(
  `schemas and documents match canonical LAPP ${lock.canonicalCommit}: `
  + `${vendoredFiles.length} schemas, ${documentFiles.length} documents`,
);
