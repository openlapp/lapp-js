#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

function read(file: string): string {
  return readFileSync(resolve(root, file), "utf8");
}

const constantsSrc = read("packages/lapp/src/validate/constants.ts");
const coreProtocolsMatch = constantsSrc.match(/CORE_PROTOCOLS\s*=\s*new\s+Set\(\[\s*([^\]]+)\]/s);
if (!coreProtocolsMatch) {
  console.error("Could not find CORE_PROTOCOLS in packages/lapp/src/validate/constants.ts");
  process.exit(1);
}

const srcProtocols = new Set(
  coreProtocolsMatch[1]!
    .split("\n")
    .map((l) => l.trim().replace(/,$/, "").replace(/"/g, "").replace(/'/g, ""))
    .filter((l) => l.length > 0),
);

function extractProtocolIds(text: string): Set<string> {
  const ids = new Set<string>();
  const rows = text.split("\n").filter((l) => l.trim().startsWith("| `"));
  for (const row of rows) {
    const match = row.match(/\|\s*`([^`]+)`/);
    if (match) ids.add(match[1]!);
  }
  return ids;
}

const readmeProtocols = extractProtocolIds(read("README.md"));
const protocolsDoc = extractProtocolIds(read("docs/protocols.md"));
const zhProtocolsDoc = extractProtocolIds(read("docs/zh/protocols.md"));

let failed = false;

for (const p of srcProtocols) {
  if (!readmeProtocols.has(p)) {
    console.error(`Missing protocol in README.md: ${p}`);
    failed = true;
  }
  if (!protocolsDoc.has(p)) {
    console.error(`Missing protocol in docs/protocols.md: ${p}`);
    failed = true;
  }
  if (!zhProtocolsDoc.has(p)) {
    console.error(`Missing protocol in docs/zh/protocols.md: ${p}`);
    failed = true;
  }
}

for (const p of readmeProtocols) {
  if (!srcProtocols.has(p)) {
    console.error(`Extra protocol in README.md: ${p}`);
    failed = true;
  }
}

for (const p of protocolsDoc) {
  if (!srcProtocols.has(p)) {
    console.error(`Extra protocol in docs/protocols.md: ${p}`);
    failed = true;
  }
}

for (const p of zhProtocolsDoc) {
  if (!srcProtocols.has(p)) {
    console.error(`Extra protocol in docs/zh/protocols.md: ${p}`);
    failed = true;
  }
}

if (failed) {
  console.error("\nSupported-protocols table drift detected.");
  process.exit(1);
}

console.log(`Protocol tables match: ${srcProtocols.size} protocols (EN + ZH)`);
