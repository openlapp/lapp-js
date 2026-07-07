#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

function read(file: string): string {
  return readFileSync(resolve(root, file), "utf8");
}

function extractCommandLines(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("lapp "));
}

function extractUsageBlock(text: string): string[] {
  const start = text.indexOf("```text");
  const end = text.indexOf("```", start + 1);
  if (start === -1 || end === -1) return [];
  return text
    .slice(start + "```text".length, end)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("lapp "));
}

const cliSrc = read("packages/cli/src/index.ts");
const cliReadme = read("packages/cli/README.md");
const cliDoc = read("docs/cli.md");
const cliZhDoc = read("docs/zh/cli.md");

const srcUsageMatch = cliSrc.match(/return `Usage:\n([^`]+)`;/);
if (!srcUsageMatch) {
  console.error("Could not find usage block in packages/cli/src/index.ts");
  process.exit(1);
}

const srcCommands = extractCommandLines(srcUsageMatch[1]!);
const readmeCommands = extractUsageBlock(cliReadme);
const docCommands = extractUsageBlock(cliDoc);
const zhDocCommands = extractUsageBlock(cliZhDoc);

function normalize(cmd: string): string {
  return cmd.replace(/\s+/g, " ").trim();
}

const srcSet = new Set(srcCommands.map(normalize));
const readmeSet = new Set(readmeCommands.map(normalize));
const docSet = new Set(docCommands.map(normalize));
const zhDocSet = new Set(zhDocCommands.map(normalize));

let failed = false;

for (const cmd of srcSet) {
  if (!readmeSet.has(cmd)) {
    console.error(`Missing in packages/cli/README.md: ${cmd}`);
    failed = true;
  }
  if (!docSet.has(cmd)) {
    console.error(`Missing in docs/cli.md: ${cmd}`);
    failed = true;
  }
  if (!zhDocSet.has(cmd)) {
    console.error(`Missing in docs/zh/cli.md: ${cmd}`);
    failed = true;
  }
}

for (const cmd of readmeSet) {
  if (!srcSet.has(cmd)) {
    console.error(`Extra in packages/cli/README.md: ${cmd}`);
    failed = true;
  }
}

for (const cmd of docSet) {
  if (!srcSet.has(cmd)) {
    console.error(`Extra in docs/cli.md: ${cmd}`);
    failed = true;
  }
}

for (const cmd of zhDocSet) {
  if (!srcSet.has(cmd)) {
    console.error(`Extra in docs/zh/cli.md: ${cmd}`);
    failed = true;
  }
}

if (failed) {
  console.error("\nCLI command list drift detected.");
  process.exit(1);
}

console.log(`CLI docs match: ${srcSet.size} commands (EN + ZH)`);
