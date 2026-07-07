/**
 * Tests for the ajv-schemas-missing WARN surfaced by `validateProfile`.
 *
 * The previous behavior was: if the schema directory is missing or empty
 * at load time, ajv returned no schema, and `ajvValidate` silently passed
 * every call. A user adding a typo'd `protocol` like "gpt-5" would then
 * get a clean validation result and the wrong value would be persisted.
 *
 * The fix surfaces a one-time WARN through `profile.diagnostics` so callers
 * running `validateProfile` (or `lapp doctor`) can see that structural
 * checks did not run.
 *
 * We force the missing-schema state by pointing `LAPP_SCHEMA_DIR` at an
 * empty temp dir (this env var is read by `resolveSchemaDir` as a test hook
 * and is not part of the public API).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import {
  createProfile,
  upsertProvider,
  upsertModel,
  validateProfile,
  _resetAjvForTest,
} from "../src/index.js";

describe("validateProfile warns when LAPP schemas are missing", () => {
  let originalSchemaDir: string | undefined;
  let emptyDir: string;

  beforeEach(() => {
    emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "lapp-no-schemas-"));
    originalSchemaDir = process.env["LAPP_SCHEMA_DIR"];
    process.env["LAPP_SCHEMA_DIR"] = emptyDir;
    _resetAjvForTest();
  });

  afterEach(() => {
    if (originalSchemaDir === undefined) {
      delete process.env["LAPP_SCHEMA_DIR"];
    } else {
      process.env["LAPP_SCHEMA_DIR"] = originalSchemaDir;
    }
    fs.rmSync(emptyDir, { recursive: true, force: true });
    _resetAjvForTest();
  });

  it("emits a WARN diagnostic when no schemas are loaded", () => {
    let p = createProfile({ rootDir: "/tmp/.lapp" });
    p = upsertProvider(p, {
      id: "ds",
      protocol: "openai-chat-completions",
      baseUrl: "https://api.deepseek.com",
      auth: { secret: "env://DEEPSEEK_API_KEY" },
    });
    p = upsertModel(p, { providerId: "ds", id: "deepseek-chat", type: "chat" });
    const result = validateProfile(p);
    const schemasWarn = result.diagnostics.find((d) =>
      d.message.includes("LAPP schemas not loaded"),
    );
    expect(schemasWarn).toBeDefined();
    expect(schemasWarn!.level).toBe("WARN");
    // result is still "valid" (semantic checks pass) but the WARN is visible
    expect(result.warnings).toBeGreaterThanOrEqual(1);
  });

  it("does not emit the schemas-missing WARN when schemas are present", () => {
    // Sanity: with the env var cleared, the real (or sibling fallback)
    // schema dir should be found and no WARN should fire.
    delete process.env["LAPP_SCHEMA_DIR"];
    _resetAjvForTest();
    let p = createProfile({ rootDir: "/tmp/.lapp" });
    p = upsertProvider(p, {
      id: "ds",
      protocol: "openai-chat-completions",
      baseUrl: "https://api.deepseek.com",
      auth: { secret: "env://DEEPSEEK_API_KEY" },
    });
    p = upsertModel(p, { providerId: "ds", id: "deepseek-chat", type: "chat" });
    const result = validateProfile(p);
    const schemasWarn = result.diagnostics.find((d) =>
      d.message.includes("LAPP schemas not loaded"),
    );
    expect(schemasWarn).toBeUndefined();
  });

  it("with schemas missing, semantic checks still run (typo'd protocol is still warned)", () => {
    let p = createProfile({ rootDir: "/tmp/.lapp" });
    p = upsertProvider(p, {
      id: "ds",
      protocol: "gpt-5-typo",
      baseUrl: "https://api.deepseek.com",
      auth: { secret: "env://DEEPSEEK_API_KEY" },
    });
    p = upsertModel(p, { providerId: "ds", id: "deepseek-chat", type: "chat" });
    const result = validateProfile(p);
    // Semantic warn for non-core protocol still fires
    const nonCoreWarn = result.diagnostics.find(
      (d) => d.level === "WARN" && d.message.includes("not a core LAPP v1 protocol"),
    );
    expect(nonCoreWarn).toBeDefined();
    // And the schemas-missing WARN is also present
    const schemasWarn = result.diagnostics.find((d) =>
      d.message.includes("LAPP schemas not loaded"),
    );
    expect(schemasWarn).toBeDefined();
  });
});
