import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  commitProfileTransaction,
  computeProfileRevision,
  createProfile,
  CredentialError,
  prepareProviderUpdate,
  ProfileRevisionConflictError,
  ProfileLockedError,
  ProfileUpdatePartialFailureError,
  upsertProvider,
  writeProfileAtomic,
  writerLockPaths,
  type CredentialVault,
} from "../src/index.js";

interface TransactionFailureCase {
  name: string;
  vaultMutated: boolean;
  profileRestored: boolean;
  vaultRestored: boolean;
  expectedCode: "PROFILE_UPDATE_PARTIAL_FAILURE" | "CREDENTIAL_UPDATE_PARTIAL_FAILURE";
  expectedDetailCodes: string[];
}

const transactionFailures = (JSON.parse(fs.readFileSync(
  new URL("../conformance/transaction-failures-v1.json", import.meta.url),
  "utf8",
)) as { cases: TransactionFailureCase[] }).cases;

const roots: string[] = [];

function temporaryDirectory(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(directory);
  return directory;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("public Profile + Vault transaction", () => {
  it("requires expectedRevision even when a JavaScript caller bypasses TypeScript", async () => {
    const rootDir = temporaryDirectory("lapp-transaction-required-");
    const before = createProfile({ rootDir });

    await expect(commitProfileTransaction({
      rootDir,
      before,
      next: before,
      lock: { stateHome: temporaryDirectory("lapp-state-required-") },
    } as never)).rejects.toThrow(/expectedRevision is required/i);
  });

  it("does not let a JavaScript caller bypass the global lock with lockHeld", async () => {
    const rootDir = temporaryDirectory("lapp-transaction-lock-bypass-");
    const stateHome = temporaryDirectory("lapp-state-lock-bypass-");
    const before = createProfile({ rootDir });
    const next = upsertProvider(before, {
      id: "provider",
      baseUrl: "https://provider.example/v1",
      protocols: ["openai-chat-completions"],
      auth: { type: "none" },
    });
    const { lockDirectory, ownerFile } = writerLockPaths({ stateHome });
    fs.mkdirSync(lockDirectory, { recursive: true });
    fs.writeFileSync(ownerFile, JSON.stringify({
      version: 1,
      token: "00000000-0000-4000-8000-000000000099",
      pid: 1,
      createdAt: "2000-01-01T00:00:00.000Z",
    }), "utf8");

    await expect(commitProfileTransaction({
      rootDir,
      expectedRevision: computeProfileRevision(rootDir),
      before,
      next,
      lockHeld: true,
      lock: { stateHome, timeoutMs: 20, retryDelayMs: 5 },
    } as never)).rejects.toBeInstanceOf(ProfileLockedError);
  });

  it("checks CAS again after asynchronous preflight and before the first side effect", async () => {
    const rootDir = temporaryDirectory("lapp-transaction-cas-");
    const before = createProfile({ rootDir });
    const prepared = prepareProviderUpdate(before, {
      id: "provider",
      baseUrl: "https://provider.example/v1",
      protocols: ["openai-chat-completions"],
      auth: {
        type: "bearer",
        credential: { secret: "new-secret", storage: "vault" },
      },
    });
    let putCalls = 0;
    const vault: CredentialVault = {
      async status(reference) {
        fs.writeFileSync(path.join(rootDir, "global.json"), "{}\n", "utf8");
        return { reference, exists: false };
      },
      async put() { putCalls += 1; },
      async resolve() { throw new Error("not expected"); },
      async delete() { throw new Error("not expected"); },
    };

    await expect(commitProfileTransaction({
      rootDir,
      expectedRevision: computeProfileRevision(rootDir),
      before,
      next: prepared.profile,
      vaultWrite: prepared.vaultWrite!,
      vault,
      lock: { stateHome: temporaryDirectory("lapp-state-cas-") },
    })).rejects.toBeInstanceOf(ProfileRevisionConflictError);
    expect(putCalls).toBe(0);
  });

  it.each(transactionFailures)("executes canonical failure precedence: $name", async (fixture) => {
    const rootDir = temporaryDirectory(`lapp-transaction-${fixture.name}-`);
    const before = upsertProvider(createProfile({ rootDir }), {
      id: "provider",
      name: "before",
      baseUrl: "https://provider.example/v1",
      protocols: ["openai-chat-completions"],
      auth: { type: "bearer", secret: "vault://provider/default" },
    });
    await writeProfileAtomic(before);

    if (!fixture.vaultMutated) {
      const next = upsertProvider(before, { id: "provider", name: "after" });
      const error = await commitProfileTransaction({
        rootDir,
        expectedRevision: computeProfileRevision(rootDir),
        before,
        next,
        writeProfile: async () => {
          throw fixture.profileRestored
            ? new Error("injected profile commit failure after complete rollback")
            : new ProfileUpdatePartialFailureError();
        },
        lock: { stateHome: temporaryDirectory(`lapp-state-${fixture.name}-`) },
      }).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(ProfileUpdatePartialFailureError);
      expect((error as ProfileUpdatePartialFailureError).code).toBe(fixture.expectedCode);
      expect(fixture.expectedDetailCodes).toEqual([]);
      return;
    }

    const prepared = prepareProviderUpdate(before, {
      id: "provider",
      name: "after",
      auth: {
        type: "bearer",
        credential: { secret: "replacement", storage: "vault", overwrite: true },
      },
    });
    const binding = prepared.vaultWrite!.binding;
    let puts = 0;
    const vault: CredentialVault = {
      async status(reference) {
        return { reference, exists: true, bindingMatches: true };
      },
      async resolve(_reference, expectedBinding) {
        expect(expectedBinding).toEqual(binding);
        return "previous";
      },
      async put(_reference, secret) {
        puts += 1;
        if (secret === "previous" && !fixture.vaultRestored) {
          throw new Error("injected Vault restore failure");
        }
      },
      async delete() { return false; },
    };

    const error = await commitProfileTransaction({
      rootDir,
      expectedRevision: computeProfileRevision(rootDir),
      before,
      next: prepared.profile,
      vaultWrite: prepared.vaultWrite!,
      vault,
      writeProfile: async () => {
        throw fixture.profileRestored
          ? new Error("injected profile commit failure after complete rollback")
          : new ProfileUpdatePartialFailureError();
      },
      lock: { stateHome: temporaryDirectory(`lapp-state-${fixture.name}-`) },
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(CredentialError);
    expect((error as CredentialError).code).toBe(fixture.expectedCode);
    expect((error as CredentialError).causes.map((cause) => cause.code))
      .toEqual(fixture.expectedDetailCodes);
    expect(puts).toBe(2);
  });
});
