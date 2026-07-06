// Copies JSON Schemas from the sibling `../lapp` repository into
// packages/lapp/schema so the published @openlapp/lapp does not depend on the
// sibling repo path. Falls back to the already-copied files if the sibling
// repo is not present (e.g. installed package consumers).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const lappSibling = path.resolve(repoRoot, "..", "lapp", "schema");
const dest = path.resolve(repoRoot, "packages", "lapp", "schema");

fs.mkdirSync(dest, { recursive: true });

if (fs.existsSync(lappSibling)) {
  for (const file of fs.readdirSync(lappSibling)) {
    if (!file.endsWith(".schema.json")) continue;
    fs.copyFileSync(path.join(lappSibling, file), path.join(dest, file));
  }
  console.log(`[copy-schema] copied schemas from ${lappSibling} -> ${dest}`);
} else {
  if (fs.readdirSync(dest).length === 0) {
    console.warn(
      `[copy-schema] sibling schema dir not found at ${lappSibling} and ${dest} is empty; copy schemas manually before building.`,
    );
  } else {
    console.log(`[copy-schema] sibling not found; using existing ${dest}`);
  }
}