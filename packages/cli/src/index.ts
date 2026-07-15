#!/usr/bin/env node
import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { UsageError } from "./args.js";
import {
  commandDefault,
  commandInspect,
  commandModel,
  commandModels,
  commandPresets,
  commandProvider,
  commandValidate,
} from "./commands/profile.js";
import { commandCredential } from "./commands/credential.js";
import { commandChat, commandPing, commandResolve } from "./commands/runtime.js";
import { classifyError, printJsonError } from "./output.js";

const packageJson = createRequire(import.meta.url)("../package.json") as { version: string };
export const VERSION = `lapp ${packageJson.version}`;

export function usage(): string {
  return `Usage:
  lapp validate [path] [--json]
  lapp inspect [path] [--json]
  lapp provider add [path] --id <id> [--base-url <url>] [--protocol <id>...] [--vault <id> [--stdin] [--overwrite] | --env <name> | --plaintext [--stdin] --allow-plaintext | --no-auth] [--model <id>] [--yes | --dry-run]
  lapp provider set [path] --id <id> [options] [--yes | --dry-run]
  lapp provider remove [path] --id <id> [--yes | --dry-run]
  lapp credential set [path] --provider <id> [--id <id>] [--stdin] [--overwrite] [--yes | --dry-run] [--json]
  lapp credential status [path] --provider <id> [--id <id>] [--json]
  lapp credential delete [path] --provider <id> [--id <id>] [--yes | --dry-run] [--json]
  lapp model add [path] --provider <id> --id <id> [options] [--yes | --dry-run]
  lapp model set [path] --provider <id> --id <id> [options] [--yes | --dry-run]
  lapp model remove [path] --provider <id> --id <id> [--yes | --dry-run]
  lapp default set [path] --task <task> --provider <id> --model <id> [--yes | --dry-run]
  lapp models list [path] [--provider <id>] [--json]
  lapp models refresh [path] --provider <id> [--apply --yes | --dry-run] [--json]
  lapp resolve [--path <path>] (--provider <id> --model <id> | --default <task>) [--protocol <id>...] [--json]
  lapp presets [--json]
  lapp ping [--path <path>] [--provider <id> --model <id> | --default <task>] [--json]
  lapp chat [message...] [--path <path>] [--provider <id> --model <id> | --default <task>] [--system <prompt>] [--stream | --json]
  lapp help
  lapp version`;
}

export async function main(rawArgv: string[] = process.argv.slice(2)): Promise<number> {
  const argv = [...rawArgv];
  const optionEnd = argv.indexOf("--");
  const json = (optionEnd < 0 ? argv : argv.slice(0, optionEnd)).includes("--json");
  try {
    if (argv.length === 0 || (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h"))) {
      console.log(usage());
      return 0;
    }
    if (argv.length === 1 && (argv[0] === "--version" || argv[0] === "-v")) {
      console.log(VERSION);
      return 0;
    }
    const command = argv.shift();
    switch (command) {
      case "validate": await commandValidate(argv); break;
      case "inspect": await commandInspect(argv); break;
      case "provider": await commandProvider(argv); break;
      case "credential": await commandCredential(argv); break;
      case "model": await commandModel(argv); break;
      case "default": await commandDefault(argv); break;
      case "models": await commandModels(argv); break;
      case "resolve": await commandResolve(argv); break;
      case "presets": await commandPresets(argv); break;
      case "ping": await commandPing(argv); break;
      case "chat": await commandChat(argv); break;
      case "help":
        if (argv.length) throw new UsageError("help takes no arguments");
        console.log(usage());
        break;
      case "version":
        if (argv.length) throw new UsageError("version takes no arguments");
        console.log(VERSION);
        break;
      default: throw new UsageError(`unknown command: ${command}`);
    }
    return 0;
  } catch (error) {
    const failure = classifyError(error);
    if (json) printJsonError(failure);
    else {
      console.error(`${failure.code}: ${failure.message}`);
      if (failure.exitCode === 2) console.error(usage());
    }
    return failure.exitCode;
  }
}

function isMainModule(): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    console.error(classifyError(error).message);
    process.exitCode = 1;
  });
}

export * from "./args.js";
export * from "./output.js";
export * from "./presets.js";
export * from "./commands/profile.js";
export * from "./commands/credential.js";
export * from "./commands/runtime.js";
