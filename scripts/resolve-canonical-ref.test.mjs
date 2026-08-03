import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveCanonicalRef, writeGithubOutput } from "./resolve-canonical-ref.mjs";

const commit = "46ad72624a62f230fb2444bea187a7eceaaec46a";

test("resolves a commit-backed canonical snapshot and writes a GitHub output", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lapp-js-canonical-ref-"));
  const output = path.join(directory, "github-output");
  try {
    assert.equal(resolveCanonicalRef({ canonicalSnapshot: { kind: "commit", commit } }), commit);
    writeGithubOutput("ref", commit, output);
    assert.equal(fs.readFileSync(output, "utf8"), `ref=${commit}\n`);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects a working-tree canonical snapshot", () => {
  assert.throws(
    () => resolveCanonicalRef({ canonicalSnapshot: { kind: "working-tree", baseCommit: commit } }),
    /canonicalSnapshot\.kind must be commit/,
  );
});

test("rejects a non-lowercase full commit SHA", () => {
  assert.throws(
    () => resolveCanonicalRef({ canonicalSnapshot: { kind: "commit", commit: commit.toUpperCase() } }),
    /lowercase 40-hex SHA/,
  );
});
