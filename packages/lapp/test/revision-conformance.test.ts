import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  computeRegistryRevision,
  computeProfileRevision,
  ProfilePathInvalidError,
} from "../src/index.js";

interface RevisionVector {
  name: string;
  revision: string;
}

const conformanceDirectory = fileURLToPath(new URL("../conformance/", import.meta.url));
const revisionFixture = JSON.parse(fs.readFileSync(
  path.join(conformanceDirectory, "revision-v1.json"),
  "utf8",
)) as { vectors: RevisionVector[] };
const expected = new Map(revisionFixture.vectors.map((vector) => [vector.name, vector.revision]));
const registryRevisionFixture = JSON.parse(fs.readFileSync(
  path.join(conformanceDirectory, "revision-v2.json"),
  "utf8",
)) as { vectors: RevisionVector[] };
const registryExpected = new Map(
  registryRevisionFixture.vectors.map((vector) => [vector.name, vector.revision]),
);
const roots: string[] = [];

function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(process.cwd(), ".revision-test-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("canonical profile revision vectors", () => {
  it("matches missing-root and byte-exact basic-profile vectors", () => {
    const missing = path.join(temporaryRoot(), "does-not-exist");
    expect(computeProfileRevision(missing)).toBe(expected.get("missing-root"));
    expect(computeProfileRevision(
      path.join(conformanceDirectory, "revision-basic", ".lapp"),
    )).toBe(expected.get("basic-profile"));
  });

  it("frames non-file root markers", () => {
    const root = temporaryRoot();
    fs.mkdirSync(path.join(root, "global.json"));
    fs.writeFileSync(path.join(root, "providers"), Buffer.alloc(0));
    expect(computeProfileRevision(root)).toBe(expected.get("non-file-markers"));
  });

  it("frames missing and non-file provider files and ignores unrelated direct files", () => {
    const root = temporaryRoot();
    fs.mkdirSync(path.join(root, "providers", "a", "models.json"), { recursive: true });
    const revision = computeProfileRevision(root);
    expect(revision).toBe(expected.get("provider-missing-and-non-file"));
    fs.writeFileSync(path.join(root, "providers", "not-a-provider"), "ignored", "utf8");
    expect(computeProfileRevision(root)).toBe(revision);
  });

  it("frames symlinks and junctions as state 03 without following them", () => {
    const root = temporaryRoot();
    const target = path.join(root, "unmanaged-target");
    fs.mkdirSync(target);
    fs.symlinkSync(
      target,
      path.join(root, "global.json"),
      process.platform === "win32" ? "junction" : "dir",
    );
    expect(computeProfileRevision(root)).toBe(expected.get("symbolic-link-state-03"));
  });

  it.skipIf(process.platform === "win32")(
    "rejects a provider directory name that is not valid UTF-8",
    () => {
      const root = temporaryRoot();
      const providers = path.join(root, "providers");
      fs.mkdirSync(providers);
      const invalidPath = Buffer.concat([
        Buffer.from(`${providers}${path.sep}`),
        Buffer.from([0xff]),
      ]);
      fs.mkdirSync(invalidPath);
      expect(() => computeProfileRevision(root)).toThrow(ProfilePathInvalidError);
    },
  );
});

describe("canonical registry revision vectors", () => {
  it("matches missing-root and byte-exact auth-plus-provider vectors", () => {
    const missing = path.join(temporaryRoot(), "does-not-exist");
    expect(computeRegistryRevision(missing)).toBe(registryExpected.get("missing-root"));
    expect(computeRegistryRevision(
      path.join(conformanceDirectory, "revision-auth", ".lapp"),
    )).toBe(registryExpected.get("auth-and-provider-profile"));
  });

  it("frames a non-file auth root as state 03", () => {
    const root = temporaryRoot();
    const target = path.join(root, "unmanaged-target");
    fs.mkdirSync(target);
    fs.symlinkSync(
      target,
      path.join(root, "auth"),
      process.platform === "win32" ? "junction" : "dir",
    );
    expect(computeRegistryRevision(root)).toBe(registryExpected.get("auth-root-non-file"));
  });

  it("frames missing and non-file auth source files", () => {
    const root = temporaryRoot();
    fs.mkdirSync(path.join(root, "auth", "a", "models.json"), { recursive: true });
    expect(computeRegistryRevision(root)).toBe(
      registryExpected.get("auth-missing-and-non-file"),
    );
  });
});
