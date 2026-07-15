#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pnpmEntrypoint = process.env.npm_execpath;
if (!pnpmEntrypoint) throw new Error("npm_execpath is unavailable; run this script through pnpm smoke:pack");

interface ProcessResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

interface RecordedRequest {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

function runSync(command: string, args: string[], cwd = root): string {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", shell: false });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed (${result.status ?? "spawn"})\n${result.stdout ?? ""}${result.stderr ?? ""}`,
    );
  }
  return result.stdout;
}

function runPnpm(args: string[], cwd = root): string {
  return runSync(process.execPath, [pnpmEntrypoint, ...args], cwd);
}

function runAsync(
  command: string,
  args: string[],
  cwd: string,
  shell = false,
  options: { input?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      shell,
      env: { ...process.env, ...options.env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(options.input);
  });
}

function requireSuccess(result: ProcessResult, label: string): string {
  if (result.status !== 0) {
    throw new Error(`${label} failed (${result.status ?? "spawn"})\n${result.stdout}${result.stderr}`);
  }
  if (result.stderr) throw new Error(`${label} wrote to stderr:\n${result.stderr}`);
  return result.stdout.trim();
}

function parseJson(result: ProcessResult, label: string): any {
  return JSON.parse(requireSuccess(result, label));
}

function header(request: RecordedRequest, name: string): string {
  const value = request.headers[name.toLowerCase()];
  return Array.isArray(value) ? value.join(", ") : value ?? "";
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "lapp-pack-smoke-"));
let server: Server | undefined;
let nativeInstallDir: string | undefined;
let nativeVaultRef: string | undefined;
try {
  runPnpm(["--filter", "@openlapp/lapp", "pack", "--pack-destination", temp]);
  runPnpm(["--filter", "@openlapp/cli", "pack", "--pack-destination", temp]);

  const tarballs = fs.readdirSync(temp).filter((name) => name.endsWith(".tgz"));
  const sdkTarball = tarballs.find((name) => name.startsWith("openlapp-lapp-"));
  const cliTarball = tarballs.find((name) => name.startsWith("openlapp-cli-"));
  if (!sdkTarball || !cliTarball) throw new Error(`missing package tarball: ${tarballs.join(", ")}`);

  const installDir = path.join(temp, "consumer");
  fs.mkdirSync(installDir);
  const sdkSpec = `file:${path.join(temp, sdkTarball).replace(/\\/g, "/")}`;
  const cliSpec = `file:${path.join(temp, cliTarball).replace(/\\/g, "/")}`;
  fs.writeFileSync(
    path.join(installDir, "package.json"),
    JSON.stringify({
      name: "lapp-pack-smoke",
      private: true,
      type: "module",
      dependencies: {
        "@openlapp/lapp": sdkSpec,
        "@openlapp/cli": cliSpec,
      },
      pnpm: { overrides: { "@openlapp/lapp": sdkSpec } },
    }),
  );
  runPnpm(["install", "--ignore-scripts"], installDir);

  if (process.platform === "win32") {
    nativeInstallDir = path.join(temp, "native-consumer");
    fs.mkdirSync(nativeInstallDir);
    fs.writeFileSync(
      path.join(nativeInstallDir, "package.json"),
      JSON.stringify({
        name: "lapp-native-pack-smoke",
        private: true,
        type: "module",
        dependencies: {
          "@openlapp/lapp": sdkSpec,
          "@openlapp/cli": cliSpec,
        },
        pnpm: { overrides: { "@openlapp/lapp": sdkSpec } },
      }),
    );
    // This second consumer is deliberately a normal install. The Windows
    // native optional package must be present and usable from the real tarball.
    runPnpm(["install"], nativeInstallDir);
  }

  runSync(process.execPath, ["--input-type=module", "-e", "const m=await import('@openlapp/lapp');if(typeof m.loadProfile!=='function')process.exit(1)"], installDir);
  runSync(process.execPath, ["-e", "const m=require('@openlapp/lapp');if(typeof m.loadProfile!=='function')process.exit(1)"], installDir);

  const sdkPackage = JSON.parse(
    fs.readFileSync(path.join(installDir, "node_modules", "@openlapp", "lapp", "package.json"), "utf8"),
  ) as { version?: string };
  const cliPackage = JSON.parse(
    fs.readFileSync(path.join(installDir, "node_modules", "@openlapp", "cli", "package.json"), "utf8"),
  ) as { version?: string; dependencies?: Record<string, string>; bin?: Record<string, string> };
  const sdkDependency = cliPackage.dependencies?.["@openlapp/lapp"] ?? "";
  if (!sdkPackage.version || cliPackage.version !== sdkPackage.version || sdkDependency !== sdkPackage.version) {
    throw new Error(
      `packed versions differ: sdk=${sdkPackage.version ?? "missing"} cli=${cliPackage.version ?? "missing"} cli-sdk=${sdkDependency || "missing"}`,
    );
  }
  if (cliPackage.bin?.lapp !== "./dist/index.js") {
    throw new Error(`packed CLI has invalid bin mapping: ${cliPackage.bin?.lapp ?? "missing"}`);
  }
  const expectedFiles = new Map([
    ["LICENSE", path.join(root, "LICENSE")],
    ["USER_AGREEMENT.en.md", path.join(root, "packages", "lapp", "USER_AGREEMENT.en.md")],
    ["USER_AGREEMENT.zh-CN.md", path.join(root, "packages", "lapp", "USER_AGREEMENT.zh-CN.md")],
    ["spec.en.md", path.join(root, "packages", "lapp", "spec.en.md")],
    ["spec.zh-CN.md", path.join(root, "packages", "lapp", "spec.zh-CN.md")],
  ]);
  for (const packageName of ["lapp", "cli"]) {
    for (const [file, expectedPath] of expectedFiles) {
      const expected = fs.readFileSync(expectedPath, "utf8");
      const packed = fs.readFileSync(
        path.join(installDir, "node_modules", "@openlapp", packageName, file),
        "utf8",
      );
      if (packed !== expected) throw new Error(`packed ${packageName} ${file} differs from canonical package copy`);
    }
  }
  for (const file of ["global.schema.json", "models.schema.json", "provider.schema.json"]) {
    const expected = fs.readFileSync(path.join(root, "packages", "lapp", "schema", file));
    const packed = fs.readFileSync(
      path.join(installDir, "node_modules", "@openlapp", "lapp", "schema", file),
    );
    if (!packed.equals(expected)) throw new Error(`packed SDK schema/${file} differs byte-for-byte`);
  }

  const requests: RecordedRequest[] = [];
  server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString("utf8");
    requests.push({
      method: request.method ?? "",
      url: request.url ?? "",
      headers: request.headers,
      body,
    });
    response.setHeader("content-type", "application/json");
    if (request.method === "GET" && request.url?.startsWith("/v1/models")) {
      response.end(JSON.stringify({ data: [
        { id: "old-model", name: "Remote old" },
        { id: "new-model", name: "Remote new" },
      ] }));
      return;
    }
    if (request.method === "POST" && request.url === "/v1/chat/completions") {
      if (body.includes("trigger-error")) {
        response.statusCode = 401;
        response.end(JSON.stringify({ error: "opaque-header-secret rejected" }));
        return;
      }
      const input = JSON.parse(body) as { model?: string };
      response.end(JSON.stringify({
        model: input.model,
        choices: [{ message: { role: "assistant", content: "smoke reply" }, finish_reason: "stop" }],
      }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise<void>((resolve, reject) => {
    server!.once("error", reject);
    server!.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fake upstream did not expose a TCP port");
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;

  const lappHome = path.join(temp, ".lapp");
  writeJson(path.join(lappHome, "global.json"), {
    schemaVersion: "1.0",
    defaults: { chat: { providerId: "smoke", modelId: "old-model" } },
  });
  writeJson(path.join(lappHome, "providers", "smoke", "provider.json"), {
    schemaVersion: "1.0",
    id: "smoke",
    baseUrl,
    protocols: ["openai-chat-completions"],
    auth: { type: "bearer", secret: "opaque-bearer-secret" },
    requestHeaders: { "X-Smoke-Opaque": "opaque-public-value" },
    modelDiscovery: { protocol: "openai-models", url: `${baseUrl}/models` },
  });
  writeJson(path.join(lappHome, "providers", "smoke", "models.json"), {
    schemaVersion: "1.0",
    models: [{ id: "old-model", name: "Local name", type: "chat" }],
  });
  writeJson(path.join(lappHome, "providers", "header", "provider.json"), {
    schemaVersion: "1.0",
    id: "header",
    baseUrl,
    protocols: ["openai-chat-completions"],
    auth: { type: "header", name: "X-Smoke-Key", secret: "opaque-header-secret" },
  });
  writeJson(path.join(lappHome, "providers", "header", "models.json"), {
    schemaVersion: "1.0",
    models: [{ id: "header-model", type: "chat" }],
  });

  const platformBin = path.join(
    installDir,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "lapp.CMD" : "lapp",
  );
  if (!fs.existsSync(platformBin)) throw new Error(`installed CLI shim is missing: ${platformBin}`);
  const runCli = (args: string[]) => runAsync(
    process.execPath,
    [pnpmEntrypoint, "exec", "lapp", ...args],
    installDir,
  );

  const versionOutput = requireSuccess(await runCli(["--version"]), "installed CLI version");
  if (versionOutput !== `lapp ${cliPackage.version}`) {
    throw new Error(`unexpected CLI version output: ${versionOutput}`);
  }
  const modelsOutput = parseJson(await runCli(["models", "list", lappHome, "--json"]), "models list");
  if (modelsOutput.version !== 1 || modelsOutput.data?.models?.length !== 2) {
    throw new Error(`unexpected models JSON: ${JSON.stringify(modelsOutput)}`);
  }

  const modelsFile = path.join(lappHome, "providers", "smoke", "models.json");
  const beforeRefresh = fs.readFileSync(modelsFile, "utf8");
  const preview = parseJson(
    await runCli(["models", "refresh", lappHome, "--provider", "smoke", "--json"]),
    "models refresh preview",
  );
  if (preview.data?.applied !== false || preview.data?.added?.[0]?.modelId !== "new-model") {
    throw new Error(`unexpected refresh preview: ${JSON.stringify(preview)}`);
  }
  if (fs.readFileSync(modelsFile, "utf8") !== beforeRefresh) throw new Error("refresh preview changed models.json");
  const applied = parseJson(
    await runCli(["models", "refresh", lappHome, "--provider", "smoke", "--apply", "--yes", "--json"]),
    "models refresh apply",
  );
  if (applied.data?.applied !== true) throw new Error(`refresh was not applied: ${JSON.stringify(applied)}`);
  const persistedModels = JSON.parse(fs.readFileSync(modelsFile, "utf8")) as { models?: Array<{ id?: string; name?: string }> };
  if (persistedModels.models?.map((model) => model.id).join(",") !== "old-model,new-model") {
    throw new Error("refresh did not append the new model");
  }
  if (persistedModels.models?.[0]?.name !== "Local name") throw new Error("refresh overwrote a local model field");

  const chat = parseJson(
    await runCli(["chat", "hello", "--path", lappHome, "--provider", "header", "--model", "header-model", "--json"]),
    "chat JSON",
  );
  if (chat.data?.text !== "smoke reply" || chat.data?.providerId !== "header") {
    throw new Error(`unexpected chat JSON: ${JSON.stringify(chat)}`);
  }
  const ping = parseJson(
    await runCli(["ping", "--path", lappHome, "--provider", "smoke", "--model", "old-model", "--json"]),
    "ping JSON",
  );
  if (ping.data?.ok !== true) throw new Error(`unexpected ping JSON: ${JSON.stringify(ping)}`);

  const failed = await runCli([
    "chat", "trigger-error", "--path", lappHome,
    "--provider", "header", "--model", "header-model", "--json",
  ]);
  if (failed.status !== 1 || failed.stdout !== "") {
    throw new Error(`failed chat used wrong channel/status: ${JSON.stringify(failed)}`);
  }
  const failure = JSON.parse(failed.stderr.trim()) as { version?: number; error?: { code?: string } };
  if (failure.version !== 1 || !failure.error?.code) throw new Error(`invalid JSON error: ${failed.stderr}`);
  if (`${failed.stdout}${failed.stderr}`.includes("opaque-header-secret")) {
    throw new Error("failed chat leaked its credential");
  }

  if (nativeInstallDir) {
    const nativeCredentialId = `pack-${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    nativeVaultRef = `vault://packvault/${nativeCredentialId}`;
    const nativeHome = path.join(temp, ".lapp-native");
    const firstVaultSecret = `pack-vault-one-${randomUUID()}`;
    const rotatedVaultSecret = `pack-vault-two-${randomUUID()}`;
    writeJson(path.join(nativeHome, "providers", "packvault", "provider.json"), {
      schemaVersion: "1.0",
      id: "packvault",
      baseUrl,
      protocols: ["openai-chat-completions"],
      auth: { type: "bearer", secret: nativeVaultRef },
    });
    writeJson(path.join(nativeHome, "providers", "packvault", "models.json"), {
      schemaVersion: "1.0",
      models: [{ id: "vault-model", type: "chat" }],
    });
    const runNativeCli = (args: string[], input?: string) => runAsync(
      process.execPath,
      [pnpmEntrypoint, "exec", "lapp", ...args],
      nativeInstallDir!,
      false,
      { input },
    );

    const firstSet = parseJson(await runNativeCli([
      "credential", "set", nativeHome,
      "--provider", "packvault", "--id", nativeCredentialId,
      "--stdin", "--yes", "--json",
    ], `${firstVaultSecret}\n`), "native credential set");
    if (firstSet.data?.credential?.applied !== true) {
      throw new Error(`native credential was not stored: ${JSON.stringify(firstSet)}`);
    }
    const status = parseJson(await runNativeCli([
      "credential", "status", nativeHome,
      "--provider", "packvault", "--id", nativeCredentialId, "--json",
    ]), "native credential status");
    if (status.data?.credential?.available !== true || status.data?.credential?.bindingMatches !== true) {
      throw new Error(`native credential status was not usable: ${JSON.stringify(status)}`);
    }
    const resolved = parseJson(await runNativeCli([
      "resolve", "--path", nativeHome,
      "--provider", "packvault", "--model", "vault-model", "--json",
    ]), "native resolve status");
    if (resolved.data?.connection?.auth?.scheme !== "vault"
      || resolved.data?.connection?.auth?.available !== true
      || resolved.data?.connection?.auth?.bindingMatches !== true) {
      throw new Error(`native resolve exposed an unusable credential: ${JSON.stringify(resolved)}`);
    }

    const firstVaultChat = parseJson(await runNativeCli([
      "chat", "vault-one", "--path", nativeHome,
      "--provider", "packvault", "--model", "vault-model", "--json",
    ]), "native Vault chat");
    if (firstVaultChat.data?.text !== "smoke reply") {
      throw new Error(`native Vault chat failed: ${JSON.stringify(firstVaultChat)}`);
    }

    const rotated = parseJson(await runNativeCli([
      "credential", "set", nativeHome,
      "--provider", "packvault", "--id", nativeCredentialId,
      "--stdin", "--overwrite", "--yes", "--json",
    ], `${rotatedVaultSecret}\n`), "native credential rotation");
    if (rotated.data?.credential?.applied !== true) {
      throw new Error(`native credential was not rotated: ${JSON.stringify(rotated)}`);
    }
    await requireSuccess(await runNativeCli([
      "chat", "vault-two", "--path", nativeHome,
      "--provider", "packvault", "--model", "vault-model", "--json",
    ]), "rotated native Vault chat");

    const providerText = fs.readFileSync(
      path.join(nativeHome, "providers", "packvault", "provider.json"),
      "utf8",
    );
    const publicOutput = [
      JSON.stringify(firstSet),
      JSON.stringify(status),
      JSON.stringify(resolved),
      JSON.stringify(firstVaultChat),
      JSON.stringify(rotated),
      providerText,
    ].join("\n");
    if (publicOutput.includes(firstVaultSecret) || publicOutput.includes(rotatedVaultSecret)) {
      throw new Error("packed SDK or CLI exposed a Vault credential");
    }
    const firstNativeRequest = requests.find((request) =>
      request.method === "POST" && header(request, "authorization") === `Bearer ${firstVaultSecret}`);
    const rotatedNativeRequest = requests.find((request) =>
      request.method === "POST" && header(request, "authorization") === `Bearer ${rotatedVaultSecret}`);
    if (!firstNativeRequest || !rotatedNativeRequest) {
      throw new Error("packed Vault requests did not use the current Windows credential");
    }

    const deleted = parseJson(await runNativeCli([
      "credential", "delete", nativeHome,
      "--provider", "packvault", "--id", nativeCredentialId,
      "--yes", "--json",
    ]), "native credential delete");
    if (deleted.data?.credential?.deleted !== true) {
      throw new Error(`native credential was not deleted: ${JSON.stringify(deleted)}`);
    }
    nativeVaultRef = undefined;
    const missingVaultChat = await runNativeCli([
      "chat", "after-delete", "--path", nativeHome,
      "--provider", "packvault", "--model", "vault-model", "--json",
    ]);
    if (missingVaultChat.status !== 1
      || !missingVaultChat.stderr.includes("VAULT_CREDENTIAL_NOT_FOUND")
      || `${missingVaultChat.stdout}${missingVaultChat.stderr}`.includes(firstVaultSecret)
      || `${missingVaultChat.stdout}${missingVaultChat.stderr}`.includes(rotatedVaultSecret)) {
      throw new Error(`deleted Vault credential did not fail safely: ${JSON.stringify(missingVaultChat)}`);
    }
  }

  const discoveryRequests = requests.filter((request) => request.method === "GET");
  if (discoveryRequests.length !== 2 || discoveryRequests.some((request) =>
    header(request, "authorization") !== "Bearer opaque-bearer-secret"
    || header(request, "x-smoke-opaque") !== "opaque-public-value")) {
    throw new Error("refresh did not send the configured bearer auth and request header");
  }
  const bearerChat = requests.find((request) =>
    request.method === "POST" && header(request, "authorization") === "Bearer opaque-bearer-secret");
  if (!bearerChat) throw new Error("ping did not send bearer authentication");
  const headerChats = requests.filter((request) =>
    request.method === "POST" && header(request, "x-smoke-key") === "opaque-header-secret");
  if (headerChats.length !== 2) throw new Error("chat did not send header authentication");

  console.log(`pack smoke passed (${process.platform}): ESM, CJS, real bin, fake upstream, auth, Vault, JSON channels, licenses, agreements, specs, schemas`);
} finally {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  if (nativeInstallDir && nativeVaultRef) {
    await runAsync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        "const {openSystemCredentialVault}=await import('@openlapp/lapp');await (await openSystemCredentialVault()).delete(process.env.LAPP_TEST_VAULT_REF)",
      ],
      nativeInstallDir,
      false,
      { env: { LAPP_TEST_VAULT_REF: nativeVaultRef } },
    ).catch(() => undefined);
  }
  fs.rmSync(temp, { recursive: true, force: true });
}
