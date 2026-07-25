#!/usr/bin/env node
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const canonicalRoot = path.resolve(root, "..", "lapp");
const sdkRoot = path.join(root, "packages", "lapp");
const cliRoot = path.join(root, "packages", "cli");
const conformanceRoot = path.join(sdkRoot, "conformance");
const documents = [
  "USER_AGREEMENT.en.md",
  "USER_AGREEMENT.zh-CN.md",
  "spec.en.md",
  "spec.zh-CN.md",
];
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

function copyCanonicalFile(source, destination) {
  const relative = path.relative(canonicalRoot, source);
  if (!relative || path.isAbsolute(relative) || relative.startsWith(`..${path.sep}`)) {
    throw new Error(`canonical path escapes its repository: ${source}`);
  }
  const bytes = status
    ? fs.readFileSync(source)
    : gitBytes("show", `${baseCommit}:${relative.split(path.sep).join("/")}`);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, bytes);
}

function assertExactChild(parent, target) {
  if (path.dirname(path.resolve(target)) !== path.resolve(parent)) {
    throw new Error(`refusing to replace unexpected path: ${target}`);
  }
}

if (!fs.existsSync(path.join(canonicalRoot, ".git"))) {
  throw new Error(`canonical sibling checkout is missing: ${canonicalRoot}`);
}

const baseCommit = git("rev-parse", "HEAD").trim();
if (!/^[0-9a-f]{40}$/.test(baseCommit)) throw new Error("canonical HEAD is not a full commit SHA");
const status = git("status", "--porcelain", "--untracked-files=all").trim();

const schemaSource = path.join(canonicalRoot, "schema");
const schemaDestination = path.join(sdkRoot, "schema");
const schemaFiles = filesUnder(schemaSource).filter((name) => name.endsWith(".schema.json"));
fs.mkdirSync(schemaDestination, { recursive: true });
for (const existing of filesUnder(schemaDestination)) {
  if (!schemaFiles.includes(existing)) fs.rmSync(path.join(schemaDestination, existing));
}
for (const file of schemaFiles) copyCanonicalFile(
  path.join(schemaSource, file),
  path.join(schemaDestination, file),
);

for (const file of documents) {
  const source = path.join(canonicalRoot, file);
  copyCanonicalFile(source, path.join(sdkRoot, file));
  copyCanonicalFile(source, path.join(cliRoot, file));
}

assertExactChild(sdkRoot, conformanceRoot);
fs.rmSync(conformanceRoot, { recursive: true, force: true });
const trees = [
  {
    source: path.join(canonicalRoot, "tools", "validator", "fixtures", "conformance"),
    destinationPrefix: "",
  },
  {
    source: path.join(canonicalRoot, "tools", "validator", "fixtures", "valid"),
    destinationPrefix: "profiles/valid",
  },
  {
    source: path.join(canonicalRoot, "tools", "validator", "fixtures", "invalid"),
    destinationPrefix: "profiles/invalid",
  },
  {
    source: path.join(canonicalRoot, "examples"),
    destinationPrefix: "profiles/examples",
  },
];
const conformanceSources = new Map();
for (const tree of trees) {
  for (const sourceRelative of filesUnder(tree.source)) {
    const destinationRelative = tree.destinationPrefix
      ? `${tree.destinationPrefix}/${sourceRelative}`
      : sourceRelative;
    const source = path.join(tree.source, ...sourceRelative.split("/"));
    const destination = path.join(conformanceRoot, ...destinationRelative.split("/"));
    copyCanonicalFile(source, destination);
    conformanceSources.set(destinationRelative, source);
  }
}

const lock = {
  version: 2,
  source: "https://github.com/openlapp/lapp",
  canonicalSnapshot: status
    ? {
        kind: "working-tree",
        baseCommit,
        capturedDate: new Date().toISOString().slice(0, 10),
      }
    : { kind: "commit", commit: baseCommit },
  lappSchemaVersion: "1.0",
  schemas: Object.fromEntries(schemaFiles.map((file) => [
    file,
    hash(fs.readFileSync(path.join(schemaDestination, file))),
  ])),
  documents: Object.fromEntries(documents.map((file) => [
    file,
    hash(fs.readFileSync(path.join(sdkRoot, file))),
  ])),
  conformance: Object.fromEntries([...conformanceSources.keys()].sort().map((file) => [
    file,
    hash(fs.readFileSync(path.join(conformanceRoot, ...file.split("/")))),
  ])),
};

fs.writeFileSync(path.join(root, "spec-lock.json"), `${JSON.stringify(lock, null, 2)}\n`, "utf8");
console.log(
  `synced ${schemaFiles.length} schemas, ${documents.length} documents, and `
  + `${conformanceSources.size} conformance files from ${lock.canonicalSnapshot.kind} ${baseCommit}`,
);
