import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createProfile,
  upsertProvider,
  writeProfileAtomic,
} from "../src/index.js";

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("profile write transaction", () => {
  it("restores every previously written file when a later atomic rename fails", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "lapp-profile-rollback-"));
    roots.push(root);
    const initial = upsertProvider(createProfile({ rootDir: root }), {
      id: "provider",
      name: "before",
      baseUrl: "https://provider.example/v1",
      protocols: ["openai-chat-completions"],
      auth: { type: "none" },
      models: [{ id: "before-model" }],
    });
    await writeProfileAtomic(initial);
    const providerFile = path.join(root, "providers", "provider", "provider.json");
    const modelsFile = path.join(root, "providers", "provider", "models.json");
    const providerBefore = fs.readFileSync(providerFile);
    const modelsBefore = fs.readFileSync(modelsFile);
    const next = upsertProvider(initial, {
      id: "provider",
      name: "after",
      models: [{ id: "after-model" }],
    });

    const rename = fs.renameSync.bind(fs);
    let injected = false;
    vi.spyOn(fs, "renameSync").mockImplementation((source, target) => {
      if (!injected && String(target) === modelsFile) {
        injected = true;
        const error = Object.assign(new Error("injected rename failure"), { code: "EIO" });
        throw error;
      }
      return rename(source, target);
    });

    await expect(writeProfileAtomic(next, { before: initial })).rejects.toThrow(
      "injected rename failure",
    );
    expect(fs.readFileSync(providerFile)).toEqual(providerBefore);
    expect(fs.readFileSync(modelsFile)).toEqual(modelsBefore);
    expect(fs.readdirSync(path.dirname(providerFile)).some((name) => name.endsWith(".tmp"))).toBe(false);
  });

  it("reports a distinct failure when restoring an earlier file also fails", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "lapp-profile-partial-"));
    roots.push(root);
    const initial = upsertProvider(createProfile({ rootDir: root }), {
      id: "provider",
      name: "before",
      baseUrl: "https://provider.example/v1",
      protocols: ["openai-chat-completions"],
      auth: { type: "none" },
      models: [{ id: "before-model" }],
    });
    await writeProfileAtomic(initial);
    const providerFile = path.join(root, "providers", "provider", "provider.json");
    const modelsFile = path.join(root, "providers", "provider", "models.json");
    const next = upsertProvider(initial, {
      id: "provider",
      name: "after",
      models: [{ id: "after-model" }],
    });

    const rename = fs.renameSync.bind(fs);
    let originalFailureInjected = false;
    vi.spyOn(fs, "renameSync").mockImplementation((source, target) => {
      if (!originalFailureInjected && String(target) === modelsFile) {
        originalFailureInjected = true;
        throw Object.assign(new Error("injected write failure"), { code: "EIO" });
      }
      if (originalFailureInjected && String(target) === providerFile) {
        throw Object.assign(new Error("injected rollback failure"), { code: "EIO" });
      }
      return rename(source, target);
    });

    const error = await writeProfileAtomic(next, { before: initial }).catch((caught: unknown) => caught as Error);
    expect(error.name).toBe("ProfileWriteRollbackError");
    expect(error.message).toBe("profile update failed and rollback could not restore the previous files");
    expect(fs.readdirSync(path.dirname(providerFile)).some((name) => name.endsWith(".tmp"))).toBe(false);
  });

  it("refuses a provider directory symlink or junction that escapes the profile root", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "lapp-profile-link-root-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "lapp-profile-link-outside-"));
    roots.push(root, outside);
    fs.mkdirSync(path.join(root, "providers"), { recursive: true });
    fs.symlinkSync(
      outside,
      path.join(root, "providers", "provider"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const profile = upsertProvider(createProfile({ rootDir: root }), {
      id: "provider",
      baseUrl: "https://provider.example/v1",
      protocols: ["openai-chat-completions"],
      auth: { type: "none" },
      models: [{ id: "model" }],
    });

    await expect(writeProfileAtomic(profile)).rejects.toThrow(/symbolic link or junction/i);
    expect(fs.existsSync(path.join(outside, "provider.json"))).toBe(false);
    expect(fs.existsSync(path.join(outside, "models.json"))).toBe(false);
  });
});
