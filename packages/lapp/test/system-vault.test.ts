import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  formatVaultSecretRef,
  openSystemCredentialVault,
  type CredentialBinding,
} from "../src/index.js";

const execFileAsync = promisify(execFile);
const describeWindows = process.platform === "win32" ? describe : describe.skip;

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function resolveDigestInChild(
  reference: string,
  binding: CredentialBinding,
): Promise<{ stdout: string; stderr: string }> {
  const sdkUrl = pathToFileURL(path.resolve("packages/lapp/dist/index.js")).href;
  const script = [
    'import { createHash } from "node:crypto";',
    `const sdk = await import(${JSON.stringify(sdkUrl)});`,
    "const binding = JSON.parse(process.argv[1]);",
    "const reference = process.argv[2];",
    "const vault = await sdk.openSystemCredentialVault();",
    "const secret = await vault.resolve(reference, binding);",
    'process.stdout.write(createHash("sha256").update(secret).digest("hex"));',
  ].join("\n");
  return execFileAsync(process.execPath, [
    "--input-type=module",
    "--eval",
    script,
    JSON.stringify(binding),
    reference,
  ], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 30_000,
    windowsHide: true,
  });
}

describeWindows("Windows system credential Vault", () => {
  it("persists, resolves across processes, rotates, and deletes a current-user credential", async () => {
    const suffix = `${Date.now().toString(36)}-${randomBytes(5).toString("hex")}`;
    const providerId = `test-${suffix}`;
    const reference = formatVaultSecretRef(providerId, "default");
    const binding: CredentialBinding = {
      providerId,
      origin: "https://vault-test.invalid",
      auth: { type: "header", name: "X-Test-Key" },
    };
    const firstSecret = `test-${randomBytes(32).toString("base64url")}`;
    const secondSecret = `test-${randomBytes(32).toString("base64url")}`;
    const vault = await openSystemCredentialVault();

    try {
      await vault.put(reference, firstSecret, binding);
      await expect(vault.status(reference, binding)).resolves.toEqual({
        reference,
        exists: true,
        bindingMatches: true,
      });

      const firstChild = await resolveDigestInChild(reference, binding);
      expect(firstChild.stdout.trim()).toBe(digest(firstSecret));
      expect(`${firstChild.stdout}${firstChild.stderr}`).not.toContain(firstSecret);

      await vault.put(reference, secondSecret, binding, { overwrite: true });
      const secondChild = await resolveDigestInChild(reference, binding);
      expect(secondChild.stdout.trim()).toBe(digest(secondSecret));
      expect(`${secondChild.stdout}${secondChild.stderr}`).not.toContain(secondSecret);

      await expect(vault.delete(reference)).resolves.toBe(true);
      await expect(vault.status(reference, binding)).resolves.toEqual({
        reference,
        exists: false,
      });
      await expect(vault.resolve(reference, binding)).rejects.toMatchObject({
        code: "VAULT_CREDENTIAL_NOT_FOUND",
      });
    } finally {
      await vault.delete(reference).catch(() => false);
    }
  }, 60_000);
});
