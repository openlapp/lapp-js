import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AuthError,
  LAPP_AUTH_VAULT_SERVICE,
  createAuthTokenStoreFromKeyring,
  withAuthIdLock,
  type AuthEnvelopeV1,
} from "../src/index.js";

const roots: string[] = [];

class FakeEntry {
  static records = new Map<string, string>();
  static observed: Array<[string, string]> = [];
  private readonly key: string;

  constructor(service: string, username: string) {
    FakeEntry.observed.push([service, username]);
    this.key = `${service}\0${username}`;
  }

  async getPassword(): Promise<string | null> { return FakeEntry.records.get(this.key) ?? null; }
  async setPassword(password: string): Promise<void> { FakeEntry.records.set(this.key, password); }
  async deleteCredential(): Promise<boolean> { return FakeEntry.records.delete(this.key); }
}

const envelope: AuthEnvelopeV1 = {
  version: 1,
  authId: "grok-main",
  driver: "xai-grok",
  configDigest: `sha256:${"0".repeat(64)}`,
  generation: 1,
  credentials: {
    accessToken: "access-secret",
    refreshToken: "refresh-secret",
    expiresAt: "2099-01-01T00:00:00.000Z",
  },
};

afterEach(() => {
  FakeEntry.records.clear();
  FakeEntry.observed = [];
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("AuthTokenStore", () => {
  it("uses a separate service namespace and round-trips an exact envelope", async () => {
    const store = createAuthTokenStoreFromKeyring(FakeEntry);
    await store.write(envelope);
    expect(FakeEntry.observed).toContainEqual([LAPP_AUTH_VAULT_SERVICE, "grok-main"]);
    expect(await store.read("grok-main")).toEqual(envelope);
    expect(await store.status("grok-main")).toMatchObject({
      authId: "grok-main",
      exists: true,
      driver: "xai-grok",
      expired: false,
    });
    expect(await store.delete("grok-main")).toBe(true);
    expect(await store.read("grok-main")).toBeUndefined();
  });

  it("rejects unknown envelope fields without exposing token bytes", async () => {
    const store = createAuthTokenStoreFromKeyring(FakeEntry);
    FakeEntry.records.set(
      `${LAPP_AUTH_VAULT_SERVICE}\0grok-main`,
      JSON.stringify({ ...envelope, unexpected: "access-secret" }),
    );
    await expect(store.read("grok-main")).rejects.toMatchObject<AuthError>({
      code: "AUTH_RECORD_INVALID",
    });
    await expect(store.read("grok-main")).rejects.not.toThrow("access-secret");
  });
});

describe("authId lock", () => {
  it("serializes callers for the same authId", async () => {
    const stateHome = fs.mkdtempSync(path.join(os.tmpdir(), "lapp-auth-lock-"));
    roots.push(stateHome);
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const first = withAuthIdLock("grok-main", async () => {
      order.push("first-enter");
      await gate;
      order.push("first-leave");
    }, { stateHome });
    await Promise.resolve();
    const second = withAuthIdLock("grok-main", async () => {
      order.push("second-enter");
    }, { stateHome, timeoutMs: 2_000, retryDelayMs: 5 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(order).toEqual(["first-enter"]);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(["first-enter", "first-leave", "second-enter"]);
  });
});
