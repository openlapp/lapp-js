import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CredentialError,
  credentialBindingsEqual,
  inspectWriterLock,
  ProfileLockInvalidError,
  ProfileLockedError,
  ProfileReadUnstableError,
  readStable,
  repairWriterLock,
  type CredentialBinding,
  type CredentialVault,
  type ManagerResult,
  withWriterLock,
  writerLockPaths,
} from "../src/index.js";
import {
  computeProfileRevision,
  createNodeLappManagerHost,
} from "../src/manager/host.js";

const roots: string[] = [];
let previousStateHome: string | undefined;

function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(process.cwd(), ".manager-test-"));
  roots.push(root);
  return root;
}

beforeEach(() => {
  previousStateHome = process.env.LAPP_STATE_HOME;
  process.env.LAPP_STATE_HOME = temporaryRoot();
});

afterEach(() => {
  vi.restoreAllMocks();
  if (previousStateHome === undefined) delete process.env.LAPP_STATE_HOME;
  else process.env.LAPP_STATE_HOME = previousStateHome;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function unwrap<T>(result: ManagerResult<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  expect(result.ok).toBe(true);
  return result.value;
}

class MemoryVault implements CredentialVault {
  readonly records = new Map<string, { secret: string; binding: CredentialBinding }>();
  putDelayMs = 0;
  onPutStarted?: () => void;

  async put(
    reference: string,
    secret: string,
    binding: CredentialBinding,
    options: { overwrite?: boolean } = {},
  ): Promise<void> {
    this.onPutStarted?.();
    if (this.putDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.putDelayMs));
    }
    if (this.records.has(reference) && !options.overwrite) {
      throw new CredentialError("VAULT_CREDENTIAL_EXISTS", "vault credential already exists");
    }
    this.records.set(reference, { secret, binding: structuredClone(binding) });
  }

  async resolve(reference: string, binding: CredentialBinding): Promise<string> {
    const record = this.records.get(reference);
    if (!record) {
      throw new CredentialError("VAULT_CREDENTIAL_NOT_FOUND", "vault credential was not found");
    }
    if (!credentialBindingsEqual(record.binding, binding)) {
      throw new CredentialError("VAULT_BINDING_MISMATCH", "vault binding mismatch");
    }
    return record.secret;
  }

  async status(reference: string, binding: CredentialBinding) {
    const record = this.records.get(reference);
    return record
      ? {
          reference,
          exists: true,
          bindingMatches: credentialBindingsEqual(record.binding, binding),
        }
      : { reference, exists: false };
  }

  async delete(reference: string): Promise<boolean> {
    return this.records.delete(reference);
  }
}

function providerSet(secret: string) {
  return {
    type: "provider.set" as const,
    input: {
      id: "provider",
      name: "Provider",
      baseUrl: "https://provider.example/v1",
      protocols: ["openai-chat-completions"],
      models: [{ id: "model" }],
      auth: {
        type: "bearer" as const,
        credential: { secret },
      },
    },
  };
}

describe("Node LAPP manager host", () => {
  it("stores, rotates, reports, and deletes a Vault credential without returning it", async () => {
    const root = temporaryRoot();
    const vault = new MemoryVault();
    const host = createNodeLappManagerHost({ path: root, vault });
    const initial = unwrap(await host.getSnapshot());
    const firstSecret = "sk-manager-first-secret";
    const created = unwrap(await host.transact({
      expectedRevision: initial.revision,
      operation: providerSet(firstSecret),
    }));

    expect(created.revision).not.toBe(initial.revision);
    expect(created.snapshot.profile.providers[0]?.auth).toEqual({
      type: "bearer",
      credential: {
        scheme: "vault",
        reference: "vault://provider/default",
        available: true,
        bindingMatches: true,
        plaintextWarning: false,
      },
    });
    expect(JSON.stringify(created)).not.toContain(firstSecret);
    expect(fs.readFileSync(
      path.join(root, "providers", "provider", "provider.json"),
      "utf8",
    )).not.toContain(firstSecret);

    const secondSecret = "sk-manager-second-secret";
    const rotated = unwrap(await host.transact({
      expectedRevision: created.revision,
      operation: {
        type: "credential.set",
        providerId: "provider",
        secret: secondSecret,
        overwrite: true,
      },
    }));
    expect(rotated.revision).not.toBe(created.revision);
    expect(JSON.stringify(rotated)).not.toContain(secondSecret);
    expect(vault.records.get("vault://provider/default")?.secret).toBe(secondSecret);

    const deleted = unwrap(await host.transact({
      expectedRevision: rotated.revision,
      operation: { type: "credential.delete", providerId: "provider" },
    }));
    expect(vault.records.size).toBe(0);
    expect(deleted.snapshot.profile.providers[0]?.auth).toMatchObject({
      credential: { available: false },
    });
  });

  it("returns a sanitized plaintext warning without exposing the plaintext secret", async () => {
    const root = temporaryRoot();
    const host = createNodeLappManagerHost({ path: root, vault: new MemoryVault() });
    const initial = unwrap(await host.getSnapshot());
    const secret = "sk-manager-plaintext-secret";
    const operation = providerSet(secret);
    operation.input.auth.credential = { secret, storage: "plaintext" };
    const saved = unwrap(await host.transact({ expectedRevision: initial.revision, operation }));
    expect(saved.warnings).toMatchObject([{ code: "PLAINTEXT_SECRET_IN_USE" }]);
    expect(saved.snapshot.profile.providers[0]?.auth).toEqual({
      type: "bearer",
      credential: {
        scheme: "plaintext",
        available: true,
        plaintextWarning: true,
      },
    });
    expect(JSON.stringify(saved)).not.toContain(secret);
  });

  it("applies provider, model, and default operations semantically with CAS", async () => {
    const root = temporaryRoot();
    const host = createNodeLappManagerHost({ path: root, vault: new MemoryVault() });
    let snapshot = unwrap(await host.getSnapshot());
    const run = async (operation: Parameters<typeof host.transact>[0]["operation"]) => {
      const value = unwrap(await host.transact({
        expectedRevision: snapshot.revision,
        operation,
      }));
      snapshot = value.snapshot;
    };

    await run({
      type: "provider.set",
      input: {
        id: "provider",
        baseUrl: "https://provider.example/v1",
        protocols: ["openai-chat-completions"],
        auth: { type: "none" },
      },
    });
    await run({ type: "model.set", input: { providerId: "provider", id: "model" } });
    await run({
      type: "default.set",
      task: "chat",
      target: { providerId: "provider", model: "model" },
    });
    expect(snapshot.profile.global?.defaults.chat).toEqual({
      providerId: "provider",
      modelId: "model",
    });
    await run({ type: "default.delete", task: "chat" });
    await run({ type: "model.delete", target: { providerId: "provider", model: "model" } });
    await run({ type: "provider.delete", providerId: "provider" });
    expect(snapshot.profile.providers).toEqual([]);

    const stale = await host.transact({
      expectedRevision: "sha256:stale",
      operation: {
        type: "provider.set",
        input: {
          id: "other",
          baseUrl: "https://other.example/v1",
          protocols: ["openai-chat-completions"],
          auth: { type: "none" },
        },
      },
    });
    expect(stale).toMatchObject({ ok: false, error: { code: "PROFILE_CONFLICT" } });
  });

  it("serializes two hosts at the root lock and rejects the stale writer", async () => {
    const root = temporaryRoot();
    const vault = new MemoryVault();
    vault.putDelayMs = 60;
    let started!: () => void;
    const putStarted = new Promise<void>((resolve) => { started = resolve; });
    vault.onPutStarted = started;
    const stateHome = temporaryRoot();
    const lock = { stateHome, timeoutMs: 2_000, retryDelayMs: 5 };
    const firstHost = createNodeLappManagerHost({ path: root, vault, lock });
    const secondHost = createNodeLappManagerHost({ path: root, vault, lock });
    const revision = unwrap(await firstHost.getSnapshot()).revision;

    const first = firstHost.transact({
      expectedRevision: revision,
      operation: providerSet("sk-manager-lock-secret"),
    });
    await putStarted;
    const second = secondHost.transact({
      expectedRevision: revision,
      operation: {
        type: "provider.set",
        input: {
          id: "other",
          baseUrl: "https://other.example/v1",
          protocols: ["openai-chat-completions"],
          auth: { type: "none" },
        },
      },
    });

    expect((await first).ok).toBe(true);
    expect(await second).toMatchObject({
      ok: false,
      error: { code: "PROFILE_CONFLICT" },
    });
    expect(unwrap(await firstHost.getSnapshot()).profile.providers.map((entry) => entry.id))
      .toEqual(["provider"]);
    expect(inspectWriterLock({ stateHome }).locked).toBe(false);
  });

  it("rejects a stale credential rotation after a Vault-only revision change", async () => {
    const root = temporaryRoot();
    const stateHome = temporaryRoot();
    const lock = { stateHome, timeoutMs: 2_000, retryDelayMs: 5 };
    const vault = new MemoryVault();
    const firstHost = createNodeLappManagerHost({ path: root, vault, lock });
    const secondHost = createNodeLappManagerHost({ path: root, vault, lock });
    const initial = unwrap(await firstHost.getSnapshot());
    const created = unwrap(await firstHost.transact({
      expectedRevision: initial.revision,
      operation: providerSet("sk-manager-initial-secret"),
    }));
    const sharedRevision = unwrap(await secondHost.getSnapshot()).revision;
    const profileRevision = computeProfileRevision(root);
    expect(sharedRevision).toBe(created.revision);

    const firstRotation = unwrap(await firstHost.transact({
      expectedRevision: sharedRevision,
      operation: {
        type: "credential.set",
        providerId: "provider",
        secret: "sk-manager-first-rotation",
        overwrite: true,
      },
    }));
    expect(firstRotation.revision).not.toBe(sharedRevision);
    expect(computeProfileRevision(root)).toBe(profileRevision);

    const staleRotation = await secondHost.transact({
      expectedRevision: sharedRevision,
      operation: {
        type: "credential.set",
        providerId: "provider",
        secret: "sk-manager-stale-rotation",
        overwrite: true,
      },
    });
    expect(staleRotation).toMatchObject({
      ok: false,
      error: {
        code: "PROFILE_CONFLICT",
        currentRevision: firstRotation.revision,
      },
    });
    expect(vault.records.get("vault://provider/default")?.secret)
      .toBe("sk-manager-first-rotation");
  });

  it("rolls back a newly written Vault record when the profile write fails", async () => {
    const root = temporaryRoot();
    const vault = new MemoryVault();
    const host = createNodeLappManagerHost({ path: root, vault });
    const revision = unwrap(await host.getSnapshot()).revision;
    const secret = "sk-manager-rollback-secret";
    const providerFile = path.join(root, "providers", "provider", "provider.json");
    const rename = fs.renameSync.bind(fs);
    vi.spyOn(fs, "renameSync").mockImplementation((source, target) => {
      if (String(target) === providerFile) {
        throw Object.assign(new Error(`injected failure ${secret}`), { code: "EIO" });
      }
      return rename(source, target);
    });

    const result = await host.transact({
      expectedRevision: revision,
      operation: providerSet(secret),
    });
    expect(result).toMatchObject({ ok: false, error: { code: "PROFILE_OPERATION_FAILED" } });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(vault.records.size).toBe(0);
    expect(unwrap(await host.getSnapshot()).profile.providers).toEqual([]);
  });

  it("returns result-union errors for malformed IPC payloads", async () => {
    const host = createNodeLappManagerHost({
      path: temporaryRoot(),
      vault: new MemoryVault(),
    });
    await expect(host.transact(null as never)).resolves.toMatchObject({
      ok: false,
      error: { code: "MANAGER_OPERATION_UNSUPPORTED" },
    });
    await expect(host.transact({ operation: null } as never)).resolves.toMatchObject({
      ok: false,
      error: { code: "MANAGER_OPERATION_UNSUPPORTED" },
    });
    await expect(host.transact({
      expectedRevision: "sha256:test",
      operation: { type: "credential.set", providerId: "provider", secret: 123 },
    } as never)).resolves.toMatchObject({
      ok: false,
      error: { code: "MANAGER_OPERATION_UNSUPPORTED" },
    });
    await expect(host.testConnection(null as never)).resolves.toMatchObject({
      ok: false,
      error: { code: "MANAGER_OPERATION_UNSUPPORTED" },
    });
    await expect(host.testConnection({
      selector: { default: undefined, providerId: "provider", model: "model" },
    } as never)).resolves.toMatchObject({
      ok: false,
      error: { code: "MANAGER_OPERATION_UNSUPPORTED" },
    });
  });
});

describe("current-user global writer lock", () => {
  it("does not change an uninitialized profile revision while holding the global lock", async () => {
    const parent = temporaryRoot();
    const root = path.join(parent, "not-created-yet");
    const stateHome = temporaryRoot();
    const before = computeProfileRevision(root);
    expect(before).toBe("sha256:456f63cb84cb2687af0572afef1598a5ec819bf11467922665bfeed0bc21d6fd");
    await withWriterLock(async () => undefined, { stateHome });
    expect(computeProfileRevision(root)).toBe(before);
  });

  it("discards lock-observing read attempts and reports only read instability", async () => {
    const root = temporaryRoot();
    const stateHome = temporaryRoot();
    let reads = 0;
    await withWriterLock(async () => {
      expect(() => readStable(root, () => {
        reads += 1;
        return "mixed";
      }, { attempts: 3, lock: { stateHome } })).toThrow(ProfileReadUnstableError);
    }, { stateHome });
    expect(reads).toBe(0);
  });

  it("never permits more than the normative three stable-read attempts", () => {
    const root = temporaryRoot();
    expect(() => readStable(root, () => "value", { attempts: 4 }))
      .toThrow(/1 through 3/);
  });

  it("flushes owner.json before entry and cleans up only its validated failed acquisition", async () => {
    const stateHome = temporaryRoot();
    vi.spyOn(fs, "fsyncSync").mockImplementation(() => {
      throw Object.assign(new Error("injected owner flush failure"), { code: "EIO" });
    });

    await expect(withWriterLock(async () => "must-not-run", { stateHome }))
      .rejects.toBeInstanceOf(ProfileLockInvalidError);
    expect(inspectWriterLock({ stateHome }).locked).toBe(false);
  });

  it("never steals an old lock and requires explicit token-checked repair", async () => {
    const stateHome = temporaryRoot();
    const { lockDirectory, ownerFile } = writerLockPaths({ stateHome });
    const token = "00000000-0000-4000-8000-000000000001";
    fs.mkdirSync(lockDirectory, { recursive: true });
    fs.writeFileSync(ownerFile, JSON.stringify({
      version: 1,
      token,
      pid: 1,
      createdAt: "2000-01-01T00:00:00.000Z",
    }));

    await expect(withWriterLock(
      async () => "acquired",
      { stateHome, timeoutMs: 20, retryDelayMs: 5 },
    )).rejects.toBeInstanceOf(ProfileLockedError);
    expect(inspectWriterLock({ stateHome })).toMatchObject({
      locked: true,
      ownerValid: true,
      owner: { token },
    });
    expect(() => repairWriterLock(
      "00000000-0000-4000-8000-000000000002",
      { stateHome },
    )).toThrow(/changed/);
    expect(repairWriterLock(token, { stateHome })).toMatchObject({ token });
    await expect(withWriterLock(
      async () => "acquired",
      { stateHome, timeoutMs: 20, retryDelayMs: 5 },
    )).resolves.toBe("acquired");
    expect(inspectWriterLock({ stateHome }).locked).toBe(false);
  });

  it("refuses release after owner mutation and leaves the observed lock in place", async () => {
    const stateHome = temporaryRoot();
    const { ownerFile } = writerLockPaths({ stateHome });
    const replacementToken = "00000000-0000-4000-8000-000000000003";

    await expect(withWriterLock(async () => {
      const owner = JSON.parse(fs.readFileSync(ownerFile, "utf8")) as Record<string, unknown>;
      fs.writeFileSync(ownerFile, JSON.stringify({ ...owner, token: replacementToken }), "utf8");
    }, { stateHome })).rejects.toBeInstanceOf(ProfileLockInvalidError);

    expect(inspectWriterLock({ stateHome })).toMatchObject({
      locked: true,
      ownerValid: true,
      owner: { token: replacementToken },
    });
  });

  it("preserves unexpected lock entries during release and explicit repair", async () => {
    const releaseStateHome = temporaryRoot();
    const releasePaths = writerLockPaths({ stateHome: releaseStateHome });
    await expect(withWriterLock(async () => {
      fs.writeFileSync(path.join(releasePaths.lockDirectory, "unexpected.txt"), "preserve", "utf8");
    }, { stateHome: releaseStateHome })).rejects.toBeInstanceOf(ProfileLockInvalidError);
    expect(fs.readFileSync(path.join(releasePaths.lockDirectory, "unexpected.txt"), "utf8"))
      .toBe("preserve");
    expect(inspectWriterLock({ stateHome: releaseStateHome })).toMatchObject({
      locked: true,
      ownerValid: true,
    });

    const repairStateHome = temporaryRoot();
    const repairPaths = writerLockPaths({ stateHome: repairStateHome });
    const token = "00000000-0000-4000-8000-000000000004";
    fs.mkdirSync(repairPaths.lockDirectory, { recursive: true });
    fs.writeFileSync(repairPaths.ownerFile, JSON.stringify({
      version: 1,
      token,
      pid: 1,
      createdAt: "2000-01-01T00:00:00.000Z",
    }), "utf8");
    fs.writeFileSync(path.join(repairPaths.lockDirectory, "unexpected.txt"), "preserve", "utf8");

    expect(() => repairWriterLock(token, { stateHome: repairStateHome }))
      .toThrow(ProfileLockInvalidError);
    expect(fs.readFileSync(path.join(repairPaths.lockDirectory, "unexpected.txt"), "utf8"))
      .toBe("preserve");
    expect(inspectWriterLock({ stateHome: repairStateHome })).toMatchObject({
      locked: true,
      ownerValid: true,
      owner: { token },
    });
  });
});
