import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const vaultHarness = vi.hoisted(() => ({
  records: new Map<string, { secret: string; binding: unknown }>(),
  calls: [] as string[],
  failProfileWrite: false,
  failProfileRollback: false,
  failRestoreSecret: undefined as string | undefined,
  omitBindingMatches: false,
}));

const inputHarness = vi.hoisted(() => ({
  secret: "vault-test-secret",
  calls: [] as Array<{ stdin: boolean; prompt?: string }>,
}));

vi.mock("@openlapp/lapp", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const fail = (code: string, message: string): Error & { code: string } =>
    Object.assign(new Error(message), { code });
  return {
    ...actual,
    writeProfileAtomic: async (...args: unknown[]) => {
      if (vaultHarness.failProfileWrite) {
        const error = new Error("simulated profile write failure");
        if (vaultHarness.failProfileRollback) error.name = "ProfileWriteRollbackError";
        throw error;
      }
      return (actual.writeProfileAtomic as (...values: unknown[]) => Promise<unknown>)(...args);
    },
    openSystemCredentialVault: async () => ({
      put: async (ref: string, secret: string, binding: unknown, options?: { overwrite?: boolean }) => {
        vaultHarness.calls.push(`put:${ref}`);
        if (secret === vaultHarness.failRestoreSecret) {
          throw fail("VAULT_OPERATION_FAILED", "simulated Vault rollback failure");
        }
        if (vaultHarness.records.has(ref) && !options?.overwrite) {
          throw fail("VAULT_CREDENTIAL_EXISTS", "Vault credential already exists");
        }
        vaultHarness.records.set(ref, { secret, binding: structuredClone(binding) });
      },
      resolve: async (ref: string, binding: unknown) => {
        vaultHarness.calls.push(`resolve:${ref}`);
        const record = vaultHarness.records.get(ref);
        if (!record) throw fail("VAULT_CREDENTIAL_NOT_FOUND", "Vault credential not found");
        if (JSON.stringify(record.binding) !== JSON.stringify(binding)) {
          throw fail("VAULT_BINDING_MISMATCH", "Vault credential binding mismatch");
        }
        return record.secret;
      },
      status: async (ref: string, binding: unknown) => {
        vaultHarness.calls.push(`status:${ref}`);
        const record = vaultHarness.records.get(ref);
        return {
          reference: ref,
          exists: Boolean(record),
          ...(record && !vaultHarness.omitBindingMatches
            ? { bindingMatches: JSON.stringify(record.binding) === JSON.stringify(binding) }
            : {}),
        };
      },
      delete: async (ref: string) => {
        vaultHarness.calls.push(`delete:${ref}`);
        return vaultHarness.records.delete(ref);
      },
    }),
  };
});

vi.mock("../src/secret-input.js", () => ({
  readSecretInput: async (stdin: boolean, prompt?: string) => {
    inputHarness.calls.push({ stdin, ...(prompt ? { prompt } : {}) });
    return inputHarness.secret;
  },
}));

import { main, VERSION } from "../src/index.js";

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

let tempDir: string;
let root: string;
let previousKey: string | undefined;

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function seedProfile(): void {
  writeJson(path.join(root, "global.json"), {
    schemaVersion: "1.0",
    defaults: { chat: { providerId: "demo", modelId: "old-model" } },
  });
  writeJson(path.join(root, "providers", "demo", "provider.json"), {
    schemaVersion: "1.0",
    id: "demo",
    baseUrl: "http://127.0.0.1:18080/v1",
    protocols: ["openai-chat-completions"],
    auth: { type: "bearer", secret: "env://LAPP_CLI_TEST_KEY" },
    modelDiscovery: {
      protocol: "openai-models",
      url: "http://127.0.0.1:18080/v1/models",
    },
  });
  writeJson(path.join(root, "providers", "demo", "models.json"), {
    schemaVersion: "1.0",
    models: [{ id: "old-model", name: "Local name", type: "chat" }],
  });
}

async function run(args: string[]): Promise<RunResult> {
  let stdout = "";
  let stderr = "";
  const log = vi.spyOn(console, "log").mockImplementation((...values) => {
    stdout += `${values.map(String).join(" ")}\n`;
  });
  const error = vi.spyOn(console, "error").mockImplementation((...values) => {
    stderr += `${values.map(String).join(" ")}\n`;
  });
  const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(((value: unknown) => {
    stdout += String(value);
    return true;
  }) as typeof process.stdout.write);
  const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(((value: unknown) => {
    stderr += String(value);
    return true;
  }) as typeof process.stderr.write);
  try {
    return { code: await main(args), stdout, stderr };
  } finally {
    log.mockRestore();
    error.mockRestore();
    stdoutWrite.mockRestore();
    stderrWrite.mockRestore();
  }
}

function jsonOutput(result: RunResult): any {
  expect(result.stderr).toBe("");
  return JSON.parse(result.stdout.trim());
}

beforeEach(() => {
  vaultHarness.records.clear();
  vaultHarness.calls.length = 0;
  vaultHarness.failProfileWrite = false;
  vaultHarness.failProfileRollback = false;
  vaultHarness.failRestoreSecret = undefined;
  vaultHarness.omitBindingMatches = false;
  inputHarness.secret = "vault-test-secret";
  inputHarness.calls.length = 0;
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "lapp-cli-v1-"));
  root = path.join(tempDir, ".lapp");
  previousKey = process.env.LAPP_CLI_TEST_KEY;
  process.env.LAPP_CLI_TEST_KEY = "test-secret-value";
  seedProfile();
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (previousKey === undefined) delete process.env.LAPP_CLI_TEST_KEY;
  else process.env.LAPP_CLI_TEST_KEY = previousKey;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("LAPP v1 CLI contract", () => {
  it("rejects unknown flags with usage exit code 2", async () => {
    const result = await run(["presets", "--unknown"]);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("USAGE");
  });

  it("does not treat --json after the option delimiter as an output flag", async () => {
    const result = await run(["presets", "--", "--json"]);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/^USAGE:/);
  });

  it("preserves the stable ENV_SECRET_MISSING credential code", async () => {
    delete process.env.LAPP_CLI_TEST_KEY;
    const result = await run([
      "chat", "hello", "--path", root,
      "--provider", "demo", "--model", "old-model", "--json",
    ]);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr).error.code).toBe("ENV_SECRET_MISSING");
  });

  it("preserves the stable credential code through ping/testConnection", async () => {
    delete process.env.LAPP_CLI_TEST_KEY;
    const result = await run([
      "ping", "--path", root,
      "--provider", "demo", "--model", "old-model", "--json",
    ]);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr).error.code).toBe("ENV_SECRET_MISSING");
  });

  it.each([
    ["provider remove rejects add-only flags", () => ["provider", "remove", root, "--id", "demo", "--model", "x"]],
    ["model remove rejects patch flags", () => ["model", "remove", root, "--provider", "demo", "--id", "old-model", "--name", "x"]],
    ["models list rejects refresh flags", () => ["models", "list", root, "--apply"]],
    ["nested help is not swallowed by the root router", () => ["provider", "add", "--help"]],
    ["nested version is not swallowed by the root router", () => ["models", "list", "--version"]],
  ])("%s", async (_label, makeArgs) => {
    const result = await run(makeArgs());
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("USAGE");
  });

  it.each([
    ["env/no-auth", () => ["provider", "set", root, "--id", "demo", "--env", "NEW_KEY", "--no-auth"]],
    ["bearer name", () => ["provider", "set", root, "--id", "demo", "--env", "NEW_KEY", "--auth-type", "bearer", "--auth-name", "x-key"]],
    ["vault/plaintext", () => ["provider", "set", root, "--id", "demo", "--vault", "default", "--plaintext", "--allow-plaintext"]],
    ["write mode", () => ["model", "set", root, "--provider", "demo", "--id", "old-model", "--yes", "--dry-run"]],
    ["refresh mode", () => ["models", "refresh", root, "--provider", "demo", "--apply", "--yes", "--dry-run"]],
  ])("rejects conflicting %s flags", async (_label, makeArgs) => {
    const result = await run(makeArgs());
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
  });

  it("enforces strict add/set semantics", async () => {
    for (const args of [
      ["provider", "add", root, "--id", "demo", "--yes"],
      ["provider", "set", root, "--id", "missing", "--name", "Missing", "--yes"],
      ["model", "add", root, "--provider", "demo", "--id", "old-model", "--yes"],
      ["model", "set", root, "--provider", "demo", "--id", "missing", "--name", "Missing", "--yes"],
    ]) {
      const result = await run(args);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
    }
  });

  it("rejects zero token limits and validates invalid dry-run proposals", async () => {
    const zero = await run([
      "model", "set", root, "--provider", "demo", "--id", "old-model",
      "--context-window", "0", "--dry-run",
    ]);
    expect(zero.code).toBe(2);
    expect(zero.stderr).toContain("positive integer");

    const invalid = await run([
      "model", "add", root, "--provider", "demo", "--id", "bad-protocol",
      "--protocol", "anthropic-messages", "--dry-run",
    ]);
    expect(invalid.code).toBe(1);
    expect(invalid.stderr).toContain("PROFILE_INVALID");
    expect(fs.existsSync(path.join(root, "providers", "demo", "models.json"))).toBe(true);
  });

  it("creates a profile in an empty root", async () => {
    const emptyRoot = path.join(tempDir, "empty-profile");
    fs.mkdirSync(emptyRoot);
    const result = await run([
      "provider", "add", emptyRoot,
      "--id", "first",
      "--base-url", "http://127.0.0.1:18081/v1",
      "--protocol", "openai-chat-completions",
      "--no-auth",
      "--model", "first-model",
      "--yes",
    ]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(fs.readFileSync(
      path.join(emptyRoot, "providers", "first", "provider.json"),
      "utf8",
    ))).toMatchObject({ id: "first", schemaVersion: "1.0" });
  });

  it("creates a profile in a missing root but rejects a non-empty damaged root", async () => {
    const missingRoot = path.join(tempDir, "missing-profile");
    const created = await run([
      "provider", "add", missingRoot,
      "--id", "first",
      "--base-url", "http://127.0.0.1:18081/v1",
      "--protocol", "openai-chat-completions",
      "--no-auth",
      "--yes",
    ]);
    expect(created.code).toBe(0);
    expect(fs.existsSync(path.join(missingRoot, "providers", "first", "provider.json"))).toBe(true);

    const damagedRoot = path.join(tempDir, "damaged-profile");
    fs.mkdirSync(damagedRoot);
    fs.writeFileSync(path.join(damagedRoot, "unrelated.txt"), "not a profile");
    const damaged = await run([
      "provider", "add", damagedRoot,
      "--id", "first",
      "--base-url", "http://127.0.0.1:18081/v1",
      "--protocol", "openai-chat-completions",
      "--no-auth",
    ]);
    expect(damaged.code).toBe(1);
    expect(damaged.stderr).toContain("PROFILE_INVALID");
  });

  it("lists local models as one JSON document", async () => {
    const result = await run(["models", "list", root, "--json"]);
    expect(result.code).toBe(0);
    expect(jsonOutput(result)).toMatchObject({
      version: 1,
      data: {
        models: [{
          providerId: "demo",
          modelId: "old-model",
          modelName: "Local name",
          protocols: ["openai-chat-completions"],
        }],
      },
    });
  });

  it("resolves the default by reporting credential scheme and status only", async () => {
    const result = await run(["resolve", "--path", root, "--default", "chat", "--json"]);
    expect(result.code).toBe(0);
    const output = jsonOutput(result);
    expect(output.data.connection).toMatchObject({
      providerId: "demo",
      modelId: "old-model",
      protocol: "openai-chat-completions",
      auth: { type: "bearer", scheme: "env", available: true },
    });
    expect(output.data.connection.auth).not.toHaveProperty("value");
    expect(output.data.connection.auth).not.toHaveProperty("resolved");
    expect(result.stdout).not.toContain("test-secret-value");
  });

  it("redacts a plaintext credential echoed in otherwise public connection fields", async () => {
    const providerFile = path.join(root, "providers", "demo", "provider.json");
    const provider = JSON.parse(fs.readFileSync(providerFile, "utf8"));
    provider.auth.secret = "test-secret-value";
    provider.requestHeaders = { "X-Debug-Label": "prefix test-secret-value suffix" };
    writeJson(providerFile, provider);

    const result = await run(["resolve", "--path", root, "--default", "chat", "--json"]);

    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain("test-secret-value");
    expect(jsonOutput(result).data.connection.requestHeaders).toEqual({
      "X-Debug-Label": "prefix [REDACTED] suffix",
    });
  });

  it("rejects the removed --reveal-secrets flag", async () => {
    const result = await run([
      "resolve", "--path", root, "--default", "chat", "--json", "--reveal-secrets",
    ]);
    expect(result.code).toBe(2);
    expect(JSON.parse(result.stderr).error.code).toBe("USAGE");
    expect(result.stdout).toBe("");
  });

  it("redacts secret values from every ordinary resolve field", async () => {
    for (const secret of ["demo", "old-model", "openai-chat-completions", "127.0.0.1"]) {
      const providerFile = path.join(root, "providers", "demo", "provider.json");
      const provider = JSON.parse(fs.readFileSync(providerFile, "utf8"));
      provider.auth.secret = secret;
      writeJson(providerFile, provider);
      const result = await run(["resolve", "--path", root, "--default", "chat"]);
      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).not.toContain(secret);
      expect(result.stdout).toContain("[REDACTED]");
    }
  });

  it("removes raw --secret argv input and requires explicit plaintext consent", async () => {
    const removed = await run(["provider", "set", root, "--id", "demo", "--secret", "raw-key"]);
    expect(removed.code).toBe(2);
    expect(removed.stderr).not.toContain("raw-key");

    const unapproved = await run(["provider", "set", root, "--id", "demo", "--plaintext"]);
    expect(unapproved.code).toBe(2);
    expect(unapproved.stderr).toContain("--allow-plaintext");

    const approved = await run([
      "provider", "set", root, "--id", "demo", "--plaintext", "--allow-plaintext", "--yes",
    ]);
    expect(approved.code).toBe(0);
    const provider = JSON.parse(fs.readFileSync(path.join(root, "providers", "demo", "provider.json"), "utf8"));
    expect(provider.auth.secret).toBe("vault-test-secret");
    expect(approved.stderr).toContain("warning");
  });

  it("stores provider credentials in Vault and never writes the raw key to the profile", async () => {
    const result = await run([
      "provider", "set", root, "--id", "demo", "--vault", "primary", "--stdin", "--yes",
    ]);
    expect(result.code).toBe(0);
    expect(inputHarness.calls).toEqual([expect.objectContaining({ stdin: true })]);
    expect(vaultHarness.records.get("vault://demo/primary")?.secret).toBe("vault-test-secret");
    const provider = JSON.parse(fs.readFileSync(path.join(root, "providers", "demo", "provider.json"), "utf8"));
    expect(provider.auth.secret).toBe("vault://demo/primary");
    expect(JSON.stringify(provider)).not.toContain("vault-test-secret");
  });

  it("rejects Windows-reserved and trailing-dot credential ids", async () => {
    for (const credentialId of ["con", "com1.backup", "default."]) {
      const result = await run([
        "provider", "set", root, "--id", "demo", "--vault", credentialId, "--stdin", "--yes",
      ]);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("portable credential id");
    }
    expect(inputHarness.calls).toEqual([]);
    expect(vaultHarness.calls).toEqual([]);
  });

  it("reports a binding mismatch as unavailable from status and resolve", async () => {
    const stored = await run([
      "provider", "set", root, "--id", "demo", "--vault", "primary", "--stdin", "--yes",
    ]);
    expect(stored.code).toBe(0);
    const record = vaultHarness.records.get("vault://demo/primary")!;
    record.binding = { ...(record.binding as Record<string, unknown>), origin: "https://attacker.invalid" };

    const status = await run([
      "credential", "status", root, "--provider", "demo", "--id", "primary", "--json",
    ]);
    expect(jsonOutput(status).data.credential).toMatchObject({
      available: false,
      bindingMatches: false,
    });

    const resolved = await run(["resolve", "--path", root, "--default", "chat", "--json"]);
    expect(jsonOutput(resolved).data.connection.auth).toMatchObject({
      scheme: "vault",
      available: false,
      bindingMatches: false,
    });

    inputHarness.secret = "re-entered-secret";
    const replaced = await run([
      "credential", "set", root, "--provider", "demo", "--id", "primary",
      "--stdin", "--overwrite", "--yes", "--json",
    ]);
    expect(replaced.code).toBe(0);
    expect(vaultHarness.records.get("vault://demo/primary")).toMatchObject({
      secret: "re-entered-secret",
      binding: expect.objectContaining({ origin: "http://127.0.0.1:18080" }),
    });
  });

  it("treats an incomplete Vault status as unavailable", async () => {
    const stored = await run([
      "provider", "set", root, "--id", "demo", "--vault", "primary", "--stdin", "--yes",
    ]);
    expect(stored.code).toBe(0);
    vaultHarness.omitBindingMatches = true;

    const status = await run([
      "credential", "status", root, "--provider", "demo", "--id", "primary", "--json",
    ]);
    const statusCredential = jsonOutput(status).data.credential;
    expect(statusCredential).toMatchObject({ available: false, bindingMatches: false });

    const resolved = await run(["resolve", "--path", root, "--default", "chat", "--json"]);
    expect(jsonOutput(resolved).data.connection.auth).toMatchObject({
      scheme: "vault",
      available: false,
      bindingMatches: false,
    });
  });

  it("redacts a Vault value even when it equals a public write-plan field", async () => {
    inputHarness.secret = "vault://demo/primary";
    const result = await run([
      "credential", "set", root, "--provider", "demo", "--id", "primary",
      "--stdin", "--yes", "--json",
    ]);

    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain(inputHarness.secret);
    expect(result.stdout).toContain("[REDACTED]");
  });

  it("credential status, rotation, and deletion never export the secret", async () => {
    const initial = await run([
      "provider", "set", root, "--id", "demo", "--vault", "primary", "--stdin", "--yes",
    ]);
    expect(initial.code).toBe(0);

    const status = await run([
      "credential", "status", root, "--provider", "demo", "--id", "primary", "--json",
    ]);
    expect(status.code).toBe(0);
    expect(jsonOutput(status).data.credential).toMatchObject({
      ref: "vault://demo/primary",
      available: true,
      bindingMatches: true,
    });
    expect(status.stdout).not.toContain("vault-test-secret");

    inputHarness.secret = "rotated-vault-secret";
    const rotate = await run([
      "credential", "set", root, "--provider", "demo", "--id", "primary",
      "--stdin", "--overwrite", "--yes", "--json",
    ]);
    expect(rotate.code).toBe(0);
    expect(vaultHarness.records.get("vault://demo/primary")?.secret).toBe("rotated-vault-secret");
    expect(rotate.stdout).not.toContain("rotated-vault-secret");

    vaultHarness.calls.length = 0;
    const preview = await run([
      "credential", "delete", root, "--provider", "demo", "--id", "primary", "--dry-run",
    ]);
    expect(preview.code).toBe(0);
    expect(vaultHarness.calls).toEqual([]);
    expect(vaultHarness.records.has("vault://demo/primary")).toBe(true);

    const deleted = await run([
      "credential", "delete", root, "--provider", "demo", "--id", "primary", "--yes",
    ]);
    expect(deleted.code).toBe(0);
    expect(vaultHarness.records.has("vault://demo/primary")).toBe(false);
    const provider = JSON.parse(fs.readFileSync(path.join(root, "providers", "demo", "provider.json"), "utf8"));
    expect(provider.auth.secret).toBe("vault://demo/primary");
  });

  it("restores the previous Vault value when the profile write fails", async () => {
    const initial = await run([
      "provider", "set", root, "--id", "demo", "--vault", "primary", "--stdin", "--yes",
    ]);
    expect(initial.code).toBe(0);
    expect(vaultHarness.records.get("vault://demo/primary")?.secret).toBe("vault-test-secret");

    vaultHarness.calls.length = 0;
    inputHarness.secret = "must-be-rolled-back";
    vaultHarness.failProfileWrite = true;
    const failed = await run([
      "provider", "set", root, "--id", "demo",
      "--name", "Updated display name",
      "--vault", "primary", "--stdin", "--overwrite", "--yes",
    ]);
    expect(failed.code).toBe(1);
    expect(failed.stderr).not.toContain("must-be-rolled-back");
    expect(vaultHarness.records.get("vault://demo/primary")?.secret).toBe("vault-test-secret");
    expect(vaultHarness.calls.filter((call) => call === "put:vault://demo/primary")).toHaveLength(2);
  });

  it("returns the stable partial-failure code when Vault rollback fails", async () => {
    const initial = await run([
      "provider", "set", root, "--id", "demo", "--vault", "primary", "--stdin", "--yes",
    ]);
    expect(initial.code).toBe(0);

    inputHarness.secret = "replacement-secret";
    vaultHarness.failProfileWrite = true;
    vaultHarness.failRestoreSecret = "vault-test-secret";
    const failed = await run([
      "provider", "set", root, "--id", "demo", "--name", "Changed",
      "--vault", "primary", "--stdin", "--overwrite", "--yes",
    ]);

    expect(failed.code).toBe(1);
    expect(failed.stdout).toBe("");
    expect(failed.stderr).toContain("CREDENTIAL_UPDATE_PARTIAL_FAILURE");
    expect(failed.stderr).not.toContain("replacement-secret");
  });

  it("returns the stable partial-failure code when profile rollback fails", async () => {
    const initial = await run([
      "provider", "set", root, "--id", "demo", "--vault", "primary", "--stdin", "--yes",
    ]);
    expect(initial.code).toBe(0);

    inputHarness.secret = "replacement-secret";
    vaultHarness.failProfileWrite = true;
    vaultHarness.failProfileRollback = true;
    const failed = await run([
      "provider", "set", root, "--id", "demo", "--name", "Changed",
      "--vault", "primary", "--stdin", "--overwrite", "--yes",
    ]);

    expect(failed.code).toBe(1);
    expect(failed.stderr).toContain("CREDENTIAL_UPDATE_PARTIAL_FAILURE");
    expect(vaultHarness.records.get("vault://demo/primary")?.secret).toBe("vault-test-secret");
  });

  it("dry-run plans a default Vault reference without reading or opening the Vault", async () => {
    const emptyRoot = path.join(tempDir, "vault-dry-run");
    const result = await run([
      "provider", "add", emptyRoot,
      "--id", "custom",
      "--base-url", "https://example.invalid/v1",
      "--protocol", "openai-chat-completions",
      "--dry-run",
    ]);
    expect(result.code).toBe(0);
    expect(inputHarness.calls).toEqual([]);
    expect(vaultHarness.calls).toEqual([]);
    expect(fs.existsSync(emptyRoot)).toBe(false);
  });

  it("new authenticated providers default to hidden-input vault/default", async () => {
    const newRoot = path.join(tempDir, "vault-default");
    const result = await run([
      "provider", "add", newRoot,
      "--id", "custom",
      "--base-url", "https://example.invalid/v1",
      "--protocol", "openai-chat-completions",
      "--yes",
    ]);
    expect(result.code).toBe(0);
    expect(inputHarness.calls).toEqual([expect.objectContaining({ stdin: false })]);
    const provider = JSON.parse(fs.readFileSync(
      path.join(newRoot, "providers", "custom", "provider.json"),
      "utf8",
    ));
    expect(provider.auth.secret).toBe("vault://custom/default");
    expect(vaultHarness.records.get("vault://custom/default")?.secret).toBe("vault-test-secret");
  });

  it("preserves preset header authentication while defaulting to Vault", async () => {
    const newRoot = path.join(tempDir, "anthropic-vault-default");
    const result = await run(["provider", "add", newRoot, "--id", "anthropic", "--yes"]);
    expect(result.code).toBe(0);
    const provider = JSON.parse(fs.readFileSync(
      path.join(newRoot, "providers", "anthropic", "provider.json"),
      "utf8",
    ));
    expect(provider.auth).toEqual({
      type: "header",
      name: "x-api-key",
      secret: "vault://anthropic/default",
    });
  });

  it("does not consume credential-input flags for a no-auth preset", async () => {
    const newRoot = path.join(tempDir, "ollama-no-auth");
    const result = await run([
      "provider", "add", newRoot, "--id", "ollama", "--stdin", "--yes",
    ]);
    expect(result.code).toBe(2);
    expect(inputHarness.calls).toEqual([]);
    expect(vaultHarness.calls).toEqual([]);
  });

  it("forbids interactive credential input in JSON mode", async () => {
    const result = await run([
      "credential", "set", root, "--provider", "demo", "--yes", "--json",
    ]);
    expect(result.code).toBe(2);
    expect(JSON.parse(result.stderr).error.message).toContain("requires --stdin");
    expect(inputHarness.calls).toEqual([]);
    expect(vaultHarness.calls).toEqual([]);
  });

  it("previews a refresh without writing, then only appends on --apply --yes", async () => {
    const modelsFile = path.join(root, "providers", "demo", "models.json");
    const before = fs.readFileSync(modelsFile, "utf8");
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      data: [
        { id: "new-z", name: "Remote Z" },
        { id: "old-model", name: "Remote overwrite attempt" },
        { id: "new-a", name: "Remote A" },
      ],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const preview = await run(["models", "refresh", root, "--provider", "demo", "--json"]);
    expect(preview.code).toBe(0);
    expect(jsonOutput(preview).data).toMatchObject({
      providerId: "demo",
      applied: false,
      added: [{ modelId: "new-a" }, { modelId: "new-z" }],
    });
    expect(fs.readFileSync(modelsFile, "utf8")).toBe(before);

    const apply = await run([
      "models", "refresh", root, "--provider", "demo", "--apply", "--yes", "--json",
    ]);
    expect(apply.code).toBe(0);
    expect(jsonOutput(apply).data.applied).toBe(true);
    const written = JSON.parse(fs.readFileSync(modelsFile, "utf8"));
    expect(written.models.map((model: { id: string }) => model.id)).toEqual([
      "old-model", "new-a", "new-z",
    ]);
    expect(written.models[0].name).toBe("Local name");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("models refresh dry-run does not resolve credentials, contact the network, or write", async () => {
    const modelsFile = path.join(root, "providers", "demo", "models.json");
    const before = fs.readFileSync(modelsFile, "utf8");
    const providerFile = path.join(root, "providers", "demo", "provider.json");
    const provider = JSON.parse(fs.readFileSync(providerFile, "utf8"));
    provider.auth.secret = "vault://demo/default";
    fs.writeFileSync(providerFile, `${JSON.stringify(provider, null, 2)}\n`, "utf8");
    const fetchMock = vi.fn(async () => new Response("unreachable"));
    vi.stubGlobal("fetch", fetchMock);

    const result = await run([
      "models", "refresh", root, "--provider", "demo", "--dry-run", "--json",
    ]);

    expect(result.code).toBe(0);
    expect(jsonOutput(result).data).toMatchObject({
      providerId: "demo",
      applied: false,
      skipped: true,
      added: [],
    });
    expect(vaultHarness.calls).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(fs.readFileSync(modelsFile, "utf8")).toBe(before);
  });

  it("models refresh dry-run rejects a provider without model discovery without I/O", async () => {
    const providerFile = path.join(root, "providers", "demo", "provider.json");
    const provider = JSON.parse(fs.readFileSync(providerFile, "utf8"));
    delete provider.modelDiscovery;
    fs.writeFileSync(providerFile, `${JSON.stringify(provider, null, 2)}\n`, "utf8");
    const fetchMock = vi.fn(async () => new Response("unreachable"));
    vi.stubGlobal("fetch", fetchMock);

    const result = await run([
      "models", "refresh", root, "--provider", "demo", "--dry-run", "--json",
    ]);

    expect(result.code).toBe(1);
    expect(JSON.parse(result.stderr).error.code).toBe("DISCOVERY_NOT_CONFIGURED");
    expect(vaultHarness.calls).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never writes an echoed resolved credential to stdout for chat or stream", async () => {
    const secret = "test-secret-value";

    vi.stubGlobal("fetch", vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { stream?: boolean };
      if (body.stream) {
        return new Response(
          `data: ${JSON.stringify({ choices: [{ delta: { content: secret } }] })}\n\ndata: [DONE]\n\n`,
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }
      return new Response(JSON.stringify({
        choices: [{ message: { role: "assistant", content: secret }, finish_reason: "stop" }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }));

    const chat = await run([
      "chat", "hello", "--path", root, "--provider", "demo", "--model", "old-model", "--json",
    ]);
    expect(chat).toMatchObject({ code: 0, stderr: "" });
    expect(chat.stdout).not.toContain(secret);
    expect(chat.stdout).toContain("<redacted>");

    const stream = await run([
      "chat", "hello", "--path", root, "--provider", "demo", "--model", "old-model", "--stream",
    ]);
    expect(stream).toMatchObject({ code: 0, stderr: "" });
    expect(stream.stdout).not.toContain(secret);
    expect(stream.stdout).toContain("<redacted>");
  });

  it("rejects streaming JSON chat before loading a profile", async () => {
    const result = await run(["chat", "hello", "--stream", "--json"]);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr.trim())).toMatchObject({
      version: 1,
      error: { code: "USAGE", message: "--stream cannot be combined with --json" },
    });
  });

  it("reports the version committed in package.json", async () => {
    const packageJson = JSON.parse(fs.readFileSync(
      fileURLToPath(new URL("../package.json", import.meta.url)),
      "utf8",
    ));
    expect(VERSION).toBe(`lapp ${packageJson.version}`);
    const result = await run(["version"]);
    expect(result).toEqual({ code: 0, stdout: `${VERSION}\n`, stderr: "" });
  });
});
