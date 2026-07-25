import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  LAPP_MANAGER_BRIDGE_PROTOCOL_VERSION,
  type ManagerResult,
  type ManagerSnapshot,
} from "../src/manager/contract.js";

describe("browser-safe manager contract", () => {
  it("is structured-clone-safe and has a stable protocol version", () => {
    const value: ManagerResult<ManagerSnapshot> = {
      ok: true,
      value: {
        revision: "sha256:test",
        profile: { providers: [] },
        diagnostics: [],
      },
    };
    expect(LAPP_MANAGER_BRIDGE_PROTOCOL_VERSION).toBe(1);
    expect(structuredClone(value)).toEqual(value);
  });

  it("contains no Node or native runtime imports", () => {
    const source = fs.readFileSync(
      fileURLToPath(new URL("../src/manager/contract.ts", import.meta.url)),
      "utf8",
    );
    expect(source).not.toMatch(/from\s+["']node:/);
    expect(source).not.toContain("@napi-rs/keyring");
    expect(source.match(/^import\s+(?!type\b)/gm) ?? []).toHaveLength(0);
  });
});
