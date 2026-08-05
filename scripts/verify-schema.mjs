#!/usr/bin/env node
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const canonicalRoot = path.resolve(root, "..", "lapp");
const sdkRoot = path.join(root, "packages", "lapp");
const schemaRoot = path.join(sdkRoot, "schema");
const conformanceRoot = path.join(sdkRoot, "conformance");
const lock = JSON.parse(fs.readFileSync(path.join(root, "spec-lock.json"), "utf8"));
const canonicalSafeDirectory = canonicalRoot.replaceAll("\\", "/");

function git(...args) {
  return execFileSync(
    "git",
    ["-c", `safe.directory=${canonicalSafeDirectory}`, "-C", canonicalRoot, ...args],
    { encoding: "utf8" },
  );
}

function gitBytes(...args) {
  return execFileSync(
    "git",
    ["-c", `safe.directory=${canonicalSafeDirectory}`, "-C", canonicalRoot, ...args],
    { maxBuffer: 16 * 1024 * 1024 },
  );
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function hash(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function filesUnder(directory, prefix = "") {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...filesUnder(absolute, relative));
    else if (entry.isFile()) files.push(relative);
  }
  return files.sort();
}

function sameSet(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${label} file set drift\nlocked: ${expected.join(", ")}\nactual: ${actual.join(", ")}`);
  }
}

function canonicalConformanceSource(relative) {
  const mappings = [
    ["profiles/valid/", ["tools", "validator", "fixtures", "valid"]],
    ["profiles/invalid/", ["tools", "validator", "fixtures", "invalid"]],
    ["profiles/examples/", ["examples"]],
  ];
  for (const [prefix, parts] of mappings) {
    if (relative.startsWith(prefix)) {
      return path.join(canonicalRoot, ...parts, ...relative.slice(prefix.length).split("/"));
    }
  }
  return path.join(
    canonicalRoot,
    "tools",
    "validator",
    "fixtures",
    "conformance",
    ...relative.split("/"),
  );
}

function canonicalBytes(absolute) {
  if (snapshot.kind !== "commit") return fs.readFileSync(absolute);
  const relative = path.relative(canonicalRoot, absolute);
  if (!relative || path.isAbsolute(relative) || relative.startsWith(`..${path.sep}`)) {
    fail(`canonical path escapes its repository: ${absolute}`);
  }
  const gitPath = relative.split(path.sep).join("/");
  return gitBytes("show", `${expectedCommit}:${gitPath}`);
}

if (lock.version !== 2) fail("spec-lock.json must use snapshot format version 2");
const snapshot = lock.canonicalSnapshot;
const expectedCommit = snapshot?.kind === "commit" ? snapshot.commit : snapshot?.baseCommit;
if (!/^[0-9a-f]{40}$/.test(expectedCommit ?? "")) {
  fail("spec-lock.json must contain a full canonical snapshot commit SHA");
}
if (snapshot.kind === "working-tree" && !/^\d{4}-\d{2}-\d{2}$/.test(snapshot.capturedDate ?? "")) {
  fail("working-tree canonical snapshots require capturedDate");
}
if (!['commit', 'working-tree'].includes(snapshot.kind)) fail("unknown canonical snapshot kind");

const schemaFiles = filesUnder(schemaRoot).filter((name) => name.endsWith(".schema.json"));
const lockedSchemas = Object.keys(lock.schemas ?? {}).sort();
sameSet(schemaFiles, lockedSchemas, "schema");
for (const file of schemaFiles) {
  if (hash(fs.readFileSync(path.join(schemaRoot, file))) !== lock.schemas[file]) {
    fail(`schema lock drift: ${file}`);
  }
}

const documentFiles = Object.keys(lock.documents ?? {}).sort();
for (const file of documentFiles) {
  const sdk = fs.readFileSync(path.join(sdkRoot, file));
  if (hash(sdk) !== lock.documents[file]) fail(`document lock drift: ${file}`);
}

const conformanceFiles = filesUnder(conformanceRoot);
const lockedConformance = Object.keys(lock.conformance ?? {}).sort();
sameSet(conformanceFiles, lockedConformance, "conformance");
for (const file of conformanceFiles) {
  if (hash(fs.readFileSync(path.join(conformanceRoot, ...file.split("/")))) !== lock.conformance[file]) {
    fail(`conformance lock drift: ${file}`);
  }
}

if (fs.existsSync(path.join(canonicalRoot, ".git"))) {
  const actualCommit = git("rev-parse", "HEAD").trim();
  if (actualCommit !== expectedCommit) {
    fail(`canonical base drift\nlocked: ${expectedCommit}\nactual: ${actualCommit}`);
  }
  const canonicalSchemas = filesUnder(path.join(canonicalRoot, "schema"))
    .filter((name) => name.endsWith(".schema.json"));
  sameSet(canonicalSchemas, schemaFiles, "canonical schema");
  for (const file of schemaFiles) {
    if (!canonicalBytes(path.join(canonicalRoot, "schema", file))
      .equals(fs.readFileSync(path.join(schemaRoot, file)))) {
      fail(`canonical schema drift: ${file}`);
    }
  }
  for (const file of documentFiles) {
    if (!canonicalBytes(path.join(canonicalRoot, file))
      .equals(fs.readFileSync(path.join(sdkRoot, file)))) {
      fail(`canonical document drift: ${file}`);
    }
  }
  for (const file of conformanceFiles) {
    if (!canonicalBytes(canonicalConformanceSource(file))
      .equals(fs.readFileSync(path.join(conformanceRoot, ...file.split("/"))))) {
      fail(`canonical conformance drift: ${file}`);
    }
  }
}

console.log(
  `canonical LAPP ${snapshot.kind} snapshot ${expectedCommit} verified: `
  + `${schemaFiles.length} schemas, ${documentFiles.length} documents, `
  + `${conformanceFiles.length} conformance files`,
);
