#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const COMMIT_SHA = /^[0-9a-f]{40}$/;

export function resolveCanonicalRef(lock) {
  const snapshot = lock?.canonicalSnapshot;
  if (snapshot?.kind !== "commit") {
    throw new Error("spec-lock.json canonicalSnapshot.kind must be commit");
  }
  if (!COMMIT_SHA.test(snapshot.commit ?? "")) {
    throw new Error("spec-lock.json canonicalSnapshot.commit must be a lowercase 40-hex SHA");
  }
  return snapshot.commit;
}

export function writeGithubOutput(name, value, outputPath = process.env.GITHUB_OUTPUT) {
  const line = `${name}=${value}\n`;
  if (outputPath) fs.appendFileSync(outputPath, line, "utf8");
  else process.stdout.write(line);
}

function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const lock = JSON.parse(fs.readFileSync(path.join(root, "spec-lock.json"), "utf8"));
  writeGithubOutput("ref", resolveCanonicalRef(lock));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
