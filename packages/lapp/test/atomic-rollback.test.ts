import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createProfile,
  loadProfile,
  removeProvider,
  setDefault,
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
      if (!injected && String(target) === providerFile) {
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
      if (!originalFailureInjected && String(target) === providerFile) {
        originalFailureInjected = true;
        throw Object.assign(new Error("injected write failure"), { code: "EIO" });
      }
      if (originalFailureInjected && String(target) === modelsFile) {
        throw Object.assign(new Error("injected rollback failure"), { code: "EIO" });
      }
      return rename(source, target);
    });

    const error = await writeProfileAtomic(next, { before: initial }).catch((caught: unknown) => caught as Error);
    expect(error.name).toBe("ProfileUpdatePartialFailureError");
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

  it("commits managed files in UTF-8 bytewise path order regardless of provider array order", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "lapp-profile-order-"));
    roots.push(root);
    let profile = upsertProvider(createProfile({ rootDir: root }), {
      id: "zeta",
      baseUrl: "https://zeta.example/v1",
      protocols: ["openai-chat-completions"],
      auth: { type: "none" },
      models: [{ id: "z-model" }],
    });
    profile = upsertProvider(profile, {
      id: "alpha",
      baseUrl: "https://alpha.example/v1",
      protocols: ["openai-chat-completions"],
      auth: { type: "none" },
      models: [{ id: "a-model" }],
    });
    profile = setDefault(profile, "chat", { providerId: "alpha", model: "a-model" });

    const mkdir = fs.mkdirSync.bind(fs);
    const createdDirectories: string[] = [];
    vi.spyOn(fs, "mkdirSync").mockImplementation((target) => {
      createdDirectories.push(path.relative(root, String(target)).split(path.sep).join("/"));
      return mkdir(target);
    });
    const rename = fs.renameSync.bind(fs);
    const committed: string[] = [];
    vi.spyOn(fs, "renameSync").mockImplementation((source, target) => {
      committed.push(path.relative(root, String(target)).split(path.sep).join("/"));
      return rename(source, target);
    });

    await writeProfileAtomic(profile);

    expect(createdDirectories).toEqual([
      "providers",
      "providers/alpha",
      "providers/zeta",
    ]);
    expect(committed).toEqual([
      "global.json",
      "providers/alpha/models.json",
      "providers/alpha/provider.json",
      "providers/zeta/models.json",
      "providers/zeta/provider.json",
    ]);
  });

  it("rolls back only completed actions in exact reverse order", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "lapp-profile-journal-"));
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
    const next = upsertProvider(initial, {
      id: "provider",
      name: "after",
      models: [{ id: "after-model" }],
    });
    const providerFile = path.join(root, "providers", "provider", "provider.json");
    const modelsFile = path.join(root, "providers", "provider", "models.json");
    const rename = fs.renameSync.bind(fs);
    const targets: string[] = [];
    let failed = false;
    vi.spyOn(fs, "renameSync").mockImplementation((source, target) => {
      targets.push(String(target));
      if (!failed && String(target) === providerFile) {
        failed = true;
        throw Object.assign(new Error("injected second-action failure"), { code: "EIO" });
      }
      return rename(source, target);
    });

    await expect(writeProfileAtomic(next, { before: initial }))
      .rejects.toThrow("injected second-action failure");
    expect(targets).toEqual([modelsFile, providerFile, modelsFile]);
  });

  it("removes every directory created by a failed first profile write", async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "lapp-profile-directory-"));
    roots.push(parent);
    const root = path.join(parent, "new-profile");
    const profile = upsertProvider(createProfile({ rootDir: root }), {
      id: "provider",
      baseUrl: "https://provider.example/v1",
      protocols: ["openai-chat-completions"],
      auth: { type: "none" },
      models: [{ id: "model" }],
    });
    const providerFile = path.join(root, "providers", "provider", "provider.json");
    const rename = fs.renameSync.bind(fs);
    vi.spyOn(fs, "renameSync").mockImplementation((source, target) => {
      if (String(target) === providerFile) {
        throw Object.assign(new Error("injected new-profile failure"), { code: "EIO" });
      }
      return rename(source, target);
    });

    await expect(writeProfileAtomic(profile)).rejects.toThrow("injected new-profile failure");
    expect(fs.existsSync(root)).toBe(false);
  });

  it("rejects provider removal before any side effect when its directory has unknown content", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "lapp-profile-unknown-"));
    roots.push(root);
    const initial = upsertProvider(createProfile({ rootDir: root }), {
      id: "provider",
      baseUrl: "https://provider.example/v1",
      protocols: ["openai-chat-completions"],
      auth: { type: "none" },
      models: [{ id: "model" }],
    });
    await writeProfileAtomic(initial);
    const providerDirectory = path.join(root, "providers", "provider");
    const providerFile = path.join(providerDirectory, "provider.json");
    const modelsFile = path.join(providerDirectory, "models.json");
    const providerBefore = fs.readFileSync(providerFile);
    const modelsBefore = fs.readFileSync(modelsFile);
    const unknownFile = path.join(providerDirectory, "notes.txt");
    fs.writeFileSync(unknownFile, "keep me", "utf8");
    const unlink = vi.spyOn(fs, "unlinkSync");
    const rename = vi.spyOn(fs, "renameSync");

    await expect(writeProfileAtomic(removeProvider(initial, "provider"), { before: initial }))
      .rejects.toThrow(/unmanaged content/i);

    expect(fs.readFileSync(unknownFile, "utf8")).toBe("keep me");
    expect(fs.readFileSync(providerFile)).toEqual(providerBefore);
    expect(fs.readFileSync(modelsFile)).toEqual(modelsBefore);
    expect(unlink).not.toHaveBeenCalled();
    expect(rename).not.toHaveBeenCalled();
  });

  it("rolls back managed-file deletion when unknown content appears during provider removal", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "lapp-profile-raced-content-"));
    roots.push(root);
    const initial = upsertProvider(createProfile({ rootDir: root }), {
      id: "provider",
      baseUrl: "https://provider.example/v1",
      protocols: ["openai-chat-completions"],
      auth: { type: "none" },
      models: [{ id: "model" }],
    });
    await writeProfileAtomic(initial);
    const providerDirectory = path.join(root, "providers", "provider");
    const providerFile = path.join(providerDirectory, "provider.json");
    const modelsFile = path.join(providerDirectory, "models.json");
    const providerBefore = fs.readFileSync(providerFile);
    const modelsBefore = fs.readFileSync(modelsFile);
    const unknownFile = path.join(providerDirectory, "notes.txt");
    const unlink = fs.unlinkSync.bind(fs);
    vi.spyOn(fs, "unlinkSync").mockImplementation((target) => {
      unlink(target);
      if (String(target) === providerFile) fs.writeFileSync(unknownFile, "raced", "utf8");
    });

    await expect(writeProfileAtomic(removeProvider(initial, "provider"), { before: initial }))
      .rejects.toThrow(/became non-empty/i);

    expect(fs.readFileSync(unknownFile, "utf8")).toBe("raced");
    expect(fs.readFileSync(providerFile)).toEqual(providerBefore);
    expect(fs.readFileSync(modelsFile)).toEqual(modelsBefore);
  });

  it.each(["missing", "existing"] as const)(
    "creates the required providers directory for a zero-provider profile in a %s root",
    async (rootState) => {
      const parent = fs.mkdtempSync(path.join(os.tmpdir(), "lapp-empty-profile-"));
      roots.push(parent);
      const root = rootState === "missing" ? path.join(parent, "profile") : parent;
      const profile = createProfile({ rootDir: root });

      await writeProfileAtomic(profile);

      expect(fs.statSync(path.join(root, "providers")).isDirectory()).toBe(true);
      expect(loadProfile({ path: root })).toEqual(profile);
    },
  );

  it("does not rewrite semantically unchanged JSON with different formatting", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "lapp-profile-noop-"));
    roots.push(root);
    const profile = upsertProvider(createProfile({ rootDir: root }), {
      id: "provider",
      baseUrl: "https://provider.example/v1",
      protocols: ["openai-chat-completions"],
      auth: { type: "none" },
      models: [{ id: "model" }],
    });
    await writeProfileAtomic(profile);
    const providerFile = path.join(root, "providers", "provider", "provider.json");
    const compact = JSON.stringify(JSON.parse(fs.readFileSync(providerFile, "utf8")));
    fs.writeFileSync(providerFile, compact, "utf8");
    const rename = vi.spyOn(fs, "renameSync");

    await writeProfileAtomic(profile, { before: profile });

    expect(rename).not.toHaveBeenCalled();
    expect(fs.readFileSync(providerFile, "utf8")).toBe(compact);
  });
});
