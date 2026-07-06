/**
 * JSON/JSONC reader.
 *
 * The JSONC strip logic is ported verbatim from the reference validator
 * `../lapp/tools/validator/lapp-validate.mjs::stripJsonc` so the SDK matches
 * upstream parsing behavior exactly.
 */

import fs from "node:fs";
import path from "node:path";

/** Strip JSONC comments (`//` line comments and `slash-star ... star-slash` block comments) outside of string literals. */
export function stripJsonc(input: string): string {
  let output = "";
  let inString = false;
  let escaped = false;

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i] as string;
    const next = input[i + 1];

    if (inString) {
      output += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      output += char;
      continue;
    }

    if (char === "/" && next === "/") {
      i += 2;
      while (i < input.length && input[i] !== "\n" && input[i] !== "\r") {
        i += 1;
      }
      output += input[i] ?? "";
      continue;
    }

    if (char === "/" && next === "*") {
      i += 2;
      while (i + 1 < input.length && !(input[i] === "*" && input[i + 1] === "/")) {
        i += 1;
      }
      i += 1;
      continue;
    }

    output += char;
  }

  return output;
}

/** Read and parse a `.json` or `.jsonc` file. Throws on invalid JSON. */
export function readJsonc(filePath: string): unknown {
  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(stripJsonc(raw));
}

/**
 * Find a config file preferring `.json` then `.jsonc` in `dir`.
 * Returns the absolute path of the first match, or null.
 */
export function findConfigFile(dir: string, baseName: string): string | null {
  const jsonPath = path.join(dir, `${baseName}.json`);
  if (fs.existsSync(jsonPath)) return jsonPath;
  const jsoncPath = path.join(dir, `${baseName}.jsonc`);
  if (fs.existsSync(jsoncPath)) return jsoncPath;
  return null;
}

/** File-relative location string for diagnostics. */
export function relativeLocation(root: string, target: string): string {
  return path.relative(root, target).split(path.sep).join("/") || ".";
}