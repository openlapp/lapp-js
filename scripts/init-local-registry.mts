#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  legacyLocalNpmrc,
  localNpmrc,
  localRegistryUsername,
  readLocalToken,
  registry,
  verifyLocalIdentity,
  waitForRegistry,
} from "./local-registry-common.mjs";

const username = localRegistryUsername;

function secureCredentialFile(file: string): void {
  fs.chmodSync(file, 0o600);
  if (process.platform !== "win32") return;

  const whoami = spawnSync("whoami.exe", ["/user", "/fo", "csv", "/nh"], {
    encoding: "utf8",
    shell: false,
  });
  const sid = whoami.stdout?.match(/,"(S-[0-9-]+)"/u)?.[1];
  if (whoami.status !== 0 || !sid) {
    throw new Error("could not determine the current Windows user SID for the Registry token ACL");
  }
  const secured = spawnSync(
    "icacls.exe",
    [file, "/inheritance:r", "/grant:r", `*${sid}:(F)`],
    { encoding: "utf8", shell: false },
  );
  if (secured.status !== 0) {
    throw new Error("could not restrict the local Registry token ACL to the current Windows user");
  }
}

function writeProtectedFile(destination: string, contents: string): void {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  const backup = `${destination}.backup`;
  try {
    fs.writeFileSync(temporary, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
    secureCredentialFile(temporary);
    fs.rmSync(backup, { force: true });
    if (fs.existsSync(destination)) fs.renameSync(destination, backup);
    try {
      fs.renameSync(temporary, destination);
      fs.rmSync(backup, { force: true });
    } catch (error) {
      if (!fs.existsSync(destination) && fs.existsSync(backup)) {
        fs.renameSync(backup, destination);
      }
      throw error;
    }
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function writeLocalNpmrc(token: string): void {
  const registryLine = registry.href.endsWith("/") ? registry.href : `${registry.href}/`;
  const authKey = `//${registry.host}${registry.pathname}:_authToken`;
  writeProtectedFile(localNpmrc, [
    "registry=https://registry.npmjs.org/",
    `@openlapp:registry=${registryLine}`,
    `${authKey}=${token}`,
    "",
  ].join("\n"));
}

function verifyCredentialStorageReady(): void {
  fs.mkdirSync(path.dirname(localNpmrc), { recursive: true });
  const probe = `${localNpmrc}.${process.pid}.${randomBytes(6).toString("hex")}.probe`;
  try {
    fs.writeFileSync(probe, "probe\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
    secureCredentialFile(probe);
  } finally {
    fs.rmSync(probe, { force: true });
  }
}

await waitForRegistry();

const localNpmrcBackup = `${localNpmrc}.backup`;
if (!fs.existsSync(localNpmrc) && fs.existsSync(localNpmrcBackup)) {
  fs.renameSync(localNpmrcBackup, localNpmrc);
}

if (!fs.existsSync(localNpmrc) && fs.existsSync(legacyLocalNpmrc)) {
  const legacyText = fs.readFileSync(legacyLocalNpmrc, "utf8");
  const legacyToken = legacyText.match(/:_authToken=([^\r\n]+)/u)?.[1]?.trim();
  if (!legacyToken) throw new Error("legacy local Registry token file is invalid");
  writeLocalNpmrc(legacyToken);
  fs.rmSync(legacyLocalNpmrc, { force: true });
}

if (fs.existsSync(localNpmrc)) {
  const token = readLocalToken();
  const identity = await verifyLocalIdentity(token);
  if (identity !== username) {
    throw new Error(`local Registry token belongs to ${identity}, expected ${username}`);
  }
  writeLocalNpmrc(token);
  console.log(`local Registry credentials are ready for ${identity}`);
} else {
  verifyCredentialStorageReady();
  const bootstrapFile = `${localNpmrc}.bootstrap`;
  const password = fs.existsSync(bootstrapFile)
    ? fs.readFileSync(bootstrapFile, "utf8").trim()
    : randomBytes(32).toString("base64url");
  if (!password) throw new Error("local Registry bootstrap credential is invalid");
  if (!fs.existsSync(bootstrapFile)) writeProtectedFile(bootstrapFile, `${password}\n`);
  const userPath = `-/user/org.couchdb.user:${encodeURIComponent(username)}`;
  const response = await fetch(new URL(userPath, registry), {
    method: "PUT",
    headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(10_000),
    body: JSON.stringify({
      _id: `org.couchdb.user:${username}`,
      name: username,
      password,
      email: "openlapp-local@localhost.invalid",
      type: "user",
      roles: [],
      date: new Date().toISOString(),
    }),
  });
  const body = await response.json().catch(() => undefined) as { token?: string; error?: string } | undefined;
  if (!response.ok || !body?.token) {
    throw new Error(
      `could not create the local Registry user (HTTP ${response.status}${body?.error ? `: ${body.error}` : ""}); `
        + "rerun pnpm registry:init to retry the protected bootstrap credential",
    );
  }

  writeLocalNpmrc(body.token);

  const identity = await verifyLocalIdentity(body.token);
  if (identity !== username) throw new Error(`created token belongs to ${identity}, expected ${username}`);
  fs.rmSync(bootstrapFile, { force: true });
  console.log(`local Registry credentials created for ${identity} in current-user application data`);
}
