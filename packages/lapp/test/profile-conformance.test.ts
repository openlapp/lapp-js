import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  inspectProfile,
  loadProfile,
  ProfileValidationError,
  type Diagnostic,
} from "../src/index.js";

const fixtureRoot = fileURLToPath(new URL("../conformance/profiles/", import.meta.url));

function findProfileRoots(directory: string): string[] {
  const profiles: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const target = path.join(directory, entry.name);
    if (entry.name === ".lapp") profiles.push(target);
    else profiles.push(...findProfileRoots(target));
  }
  return profiles.sort();
}

function label(directory: string): string {
  return path.relative(fixtureRoot, directory).split(path.sep).join("/");
}

function tuples(diagnostics: readonly Diagnostic[]): Array<[string, string | undefined, string | undefined]> {
  return diagnostics.map((diagnostic) => [
    diagnostic.level,
    diagnostic.code,
    diagnostic.location,
  ]);
}

const validProfiles = [
  ...findProfileRoots(path.join(fixtureRoot, "valid")),
  ...findProfileRoots(path.join(fixtureRoot, "examples")),
];
const invalidProfiles = findProfileRoots(path.join(fixtureRoot, "invalid"));

describe("canonical profile fixture acceptance", () => {
  it.each(validProfiles.map((directory) => [label(directory), directory]))(
    "accepts %s",
    (_name, directory) => {
      expect(() => loadProfile({ path: directory })).not.toThrow();
    },
  );

  it.each(invalidProfiles.map((directory) => [label(directory), directory]))(
    "rejects %s with only coded diagnostics",
    (_name, directory) => {
      expect(() => loadProfile({ path: directory })).toThrow(ProfileValidationError);
      const diagnostics = inspectProfile({ path: directory }).diagnostics;
      expect(diagnostics.some((entry) => entry.level === "ERROR")).toBe(true);
      expect(diagnostics.every((entry) => typeof entry.code === "string" && entry.code.length > 0))
        .toBe(true);
    },
  );
});

describe("canonical diagnostic identities", () => {
  function diagnostics(fixture: string): ReturnType<typeof tuples> {
    return tuples(inspectProfile({
      path: path.join(fixtureRoot, "invalid", fixture, ".lapp"),
    }).diagnostics);
  }

  it("locates duplicate I-JSON members with RFC 6901", () => {
    expect(diagnostics("ijson-duplicate-key")).toContainEqual([
      "ERROR",
      "IJSON_DUPLICATE_KEY",
      "providers/demo/provider.json#/id",
    ]);
  });

  it("locates required Schema fields with RFC 6901", () => {
    expect(diagnostics("missing-base-url")).toContainEqual([
      "ERROR",
      "SCHEMA_PROVIDER",
      "providers/deepseek/provider.json#/baseUrl",
    ]);
  });

  it("rejects managed directories and links as non-regular files", () => {
    expect(diagnostics("non-regular-managed-file")).toContainEqual([
      "ERROR",
      "NON_REGULAR_FILE",
      "providers/demo/provider.json",
    ]);
  });

  it("preserves semantic URL diagnostic identities", () => {
    expect(diagnostics("cross-origin-discovery")).toContainEqual([
      "ERROR",
      "CROSS_ORIGIN_DISCOVERY",
      "providers/deepseek/provider.json#/modelDiscovery/url",
    ]);
    const emptyComponents = diagnostics("empty-url-components");
    expect(emptyComponents.some(([, code]) => code === "URL_CREDENTIALS")).toBe(true);
    expect(emptyComponents.some(([, code]) => code === "URL_FRAGMENT")).toBe(true);
  });
});
