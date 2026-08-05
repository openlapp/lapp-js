#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pnpmEntrypoint = process.env.npm_execpath;
if (!pnpmEntrypoint) throw new Error("npm_execpath is unavailable; run this script through pnpm smoke:pack");

function run(command: string, args: string[], cwd = root): string {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed (${result.status ?? "spawn"})\n${result.stdout ?? ""}${result.stderr ?? ""}`);
  }
  return result.stdout;
}

function runPnpm(args: string[], cwd = root): string {
  return run(process.execPath, [pnpmEntrypoint, ...args], cwd);
}

function filesUnder(directory: string, prefix = ""): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...filesUnder(absolute, relative));
    else if (entry.isFile()) files.push(relative);
  }
  return files.sort();
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "lapp-pack-smoke-"));
try {
  runPnpm(["--filter", "@openlapp/lapp", "pack", "--pack-destination", temp]);
  const tarballs = fs.readdirSync(temp).filter((name) => name.endsWith(".tgz"));
  const sdkTarball = tarballs.find((name) => name.startsWith("openlapp-lapp-"));
  if (!sdkTarball || tarballs.length !== 1) {
    throw new Error(`expected one SDK tarball, found: ${tarballs.join(", ")}`);
  }

  const sdkTarballPath = path.join(temp, sdkTarball);
  const entries = run("tar", ["-tzf", sdkTarballPath]).split(/\r?\n/u).filter(Boolean);
  const forbiddenEntries = entries.filter((entry) =>
    /^(?:package\/)?(?:internal\/ui|react(?:\/|$)|vue(?:\/|$)|ui(?:\/|$)|dist\/(?:styles\.css|messages\.json|theme-tokens\.json))/iu.test(entry),
  );
  if (forbiddenEntries.length) {
    throw new Error(`SDK tarball contains UI artifacts: ${forbiddenEntries.join(", ")}`);
  }

  const installDir = path.join(temp, "consumer");
  fs.mkdirSync(installDir);
  const sdkSpec = `file:${sdkTarballPath.replace(/\\/g, "/")}`;
  fs.writeFileSync(path.join(installDir, "package.json"), `${JSON.stringify({
    name: "lapp-pack-smoke",
    private: true,
    type: "module",
    dependencies: { "@openlapp/lapp": sdkSpec },
  }, null, 2)}\n`, "utf8");
  runPnpm(["install", "--ignore-scripts"], installDir);

  const requiredExports = [
    "loadProfile",
    "inspectProfile",
    "listModels",
    "resolveConnection",
    "createLappClient",
    "createImageGenerationClient",
    "createVideoGenerationClient",
    "createSpeechSynthesisClient",
    "createMusicGenerationClient",
  ];
  const assertion = `const required=${JSON.stringify(requiredExports)};if(required.some((name)=>typeof m[name]!=="function"))process.exit(1)`;
  run(process.execPath, ["--input-type=module", "-e", `const m=await import('@openlapp/lapp');${assertion}`], installDir);
  run(process.execPath, ["-e", `const m=require('@openlapp/lapp');${assertion}`], installDir);

  const sdkPackage = JSON.parse(
    fs.readFileSync(path.join(installDir, "node_modules", "@openlapp", "lapp", "package.json"), "utf8"),
  ) as {
    version?: string;
    dependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    files?: string[];
  };
  const rootPackage = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { version?: string };
  if (!sdkPackage.version || sdkPackage.version !== rootPackage.version) {
    throw new Error(`packed version differs: root=${rootPackage.version ?? "missing"} sdk=${sdkPackage.version ?? "missing"}`);
  }
  const uiDependencies = [
    ...Object.keys(sdkPackage.dependencies ?? {}),
    ...Object.keys(sdkPackage.peerDependencies ?? {}),
  ].filter((name) => name === "react" || name === "vue" || name === "@openlapp/react" || name === "@openlapp/vue");
  if (uiDependencies.length || sdkPackage.files?.some((entry) => /react|vue|internal[\\/]ui/iu.test(entry))) {
    throw new Error(`packed SDK exposes UI dependencies or files: ${uiDependencies.join(", ") || "files allowlist"}`);
  }
  const nodeModules = path.join(installDir, "node_modules");
  if (fs.existsSync(path.join(nodeModules, ".bin", "lapp"))
    || fs.existsSync(path.join(nodeModules, ".bin", "lapp.CMD"))) {
    throw new Error("SDK install unexpectedly exposed the removed legacy lapp CLI");
  }

  const packageRoot = path.join(nodeModules, "@openlapp", "lapp");
  const expectedFiles = [
    "LICENSE",
    "USER_AGREEMENT.en.md",
    "USER_AGREEMENT.zh-CN.md",
    "spec.en.md",
    "spec.zh-CN.md",
  ];
  for (const file of expectedFiles) {
    const expected = fs.readFileSync(path.join(root, "packages", "lapp", file), "utf8");
    const packed = fs.readFileSync(path.join(packageRoot, file), "utf8");
    if (packed !== expected) throw new Error(`packed SDK ${file} differs from the workspace copy`);
  }
  for (const file of filesUnder(path.join(root, "packages", "lapp", "schema"))) {
    const expected = fs.readFileSync(path.join(root, "packages", "lapp", "schema", file));
    const packed = fs.readFileSync(path.join(packageRoot, "schema", ...file.split("/")));
    if (!packed.equals(expected)) throw new Error(`packed SDK schema/${file} differs byte-for-byte`);
  }
  for (const file of filesUnder(path.join(root, "packages", "lapp", "conformance"))) {
    const expected = fs.readFileSync(path.join(root, "packages", "lapp", "conformance", ...file.split("/")));
    const packed = fs.readFileSync(path.join(packageRoot, "conformance", ...file.split("/")));
    if (!packed.equals(expected)) throw new Error(`packed SDK conformance/${file} differs byte-for-byte`);
  }

  console.log(`pack smoke passed (${process.platform}): SDK, ESM, CJS, UI isolation, licenses, agreements, specs, schemas, conformance fixtures`);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
