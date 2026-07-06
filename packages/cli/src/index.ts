/**
 * `lapp` — thin CLI wrapper over @openlapp/lapp.
 *
 * All profile logic lives in the SDK; the CLI only parses args, calls the SDK,
 * prints results, and redacts secrets by default.
 */

import fs from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  loadProfile,
  inspectProfile,
  validateProfile,
  createProfile,
  upsertProvider,
  removeProvider,
  upsertModel,
  removeModel,
  setDefaultModel,
  planChanges,
  writeProfileAtomic,
  exportEnv,
  createLappClient,
  resolveLappRoot,
  UnsupportedProtocolError,
  type LappProfile,
} from "@openlapp/lapp";

const VERSION = "lapp 0.1.0";

function usage(): string {
  return `Usage:
  lapp validate [path]
  lapp inspect [path] [--reveal-secrets]
  lapp init [path] --provider <id> --protocol <p> --base-url <url> [--secret <ref>] [--model <id>]
  lapp provider add|set [path] --id <id> --protocol <p> --base-url <url> [--secret <ref>]
  lapp provider remove [path] --id <id>
  lapp model add|set [path] --provider <id> --id <id> [--alias <a>...] [--type <t>]
  lapp model remove [path] --provider <id> --id <id>
  lapp default set [path] --provider <id> --model <id>
  lapp env [path] --format bash|zsh|fish|powershell|cmd [--resolve] [--allow-plaintext]
  lapp ping [provider[/model]] [path]
  lapp chat [provider[/model]] <message> [path]
  lapp doctor [path]

Global flags: --dry-run, --yes, --reveal-secrets, --help, -h, --version, -v
`;
}

interface ParsedArgs {
  args: string[];
  flags: Record<string, string | string[] | boolean>;
}

function parseFlags(argv: string[]): ParsedArgs {
  const args: string[] = [];
  const flags: Record<string, string | string[] | boolean> = {};
  let i = 0;
  while (i < argv.length) {
    const a = argv[i]!;
    if (a === "--help" || a === "-h") { flags["help"] = true; i++; continue; }
    if (a === "--version" || a === "-v") { flags["version"] = true; i++; continue; }
    if (a === "--dry-run") { flags["dry-run"] = true; i++; continue; }
    if (a === "--yes") { flags["yes"] = true; i++; continue; }
    if (a === "--reveal-secrets") { flags["reveal-secrets"] = true; i++; continue; }
    if (a === "--resolve") { flags["resolve"] = true; i++; continue; }
    if (a === "--allow-plaintext") { flags["allow-plaintext"] = true; i++; continue; }
    if (a === "--") { args.push(...argv.slice(i + 1)); break; }
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      // Only treat the next token as a flag's value if it doesn't itself
      // look like a flag. Without this guard, `lapp provider add --id
      // --protocol x` (forgot the id value) silently stores
      // `id = "--protocol"` and consumes the real --protocol flag. Users
      // can still force a flag-shaped value with `--` first, which the
      // parser already honors by pushing everything after it verbatim.
      if (next === undefined || next.startsWith("--")) {
        flags[key] = true;
        i++;
      } else {
        if (key in flags) {
          const existing = flags[key];
          if (typeof existing === "boolean") {
            flags[key] = [next];
          } else if (Array.isArray(existing)) {
            flags[key] = [...existing, next];
          } else {
            flags[key] = [existing as string, next];
          }
        } else {
          flags[key] = next;
        }
        i += 2;
      }
      continue;
    }
    args.push(a);
    i++;
  }
  return { args, flags };
}

function flagString(flags: Record<string, unknown>, key: string): string | undefined {
  const v = flags[key];
  if (v === undefined || typeof v === "boolean") return undefined;
  if (Array.isArray(v)) return v[0] ?? undefined;
  return v as string;
}

function flagArray(flags: Record<string, unknown>, key: string): string[] {
  const v = flags[key];
  if (v === undefined || typeof v === "boolean") return [];
  return Array.isArray(v) ? v : [v as string];
}

// Cover common API-key prefixes plus generic long base64-ish strings that
// appear in echoed provider errors. This is a defense-in-depth layer; the
// SDK's `redactSecret` is the canonical redaction for profile-level secrets.
const SECRET_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{8,}\b/g,                    // OpenAI / DeepSeek / Anthropic
  /\bsk-ant-[A-Za-z0-9_-]{8,}\b/g,                // explicit ant
  /\bsk-or-[A-Za-z0-9_-]{8,}\b/g,                 // OpenRouter
  /\bgho_[A-Za-z0-9]{8,}\b/g,                     // GitHub OAuth
  /\bghp_[A-Za-z0-9]{8,}\b/g,                     // GitHub PAT
  /\bxai-[A-Za-z0-9]{8,}\b/g,                     // xAI
  /\bAIza[0-9A-Za-z_-]{8,}\b/g,                   // Google API key
  /Bearer\s+[A-Za-z0-9._-]{8,}/g,                 // Authorization: Bearer ...
];

function redactAll(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) out = out.replace(re, "<redacted>");
  return out;
}

function printDiagnostics(profile: LappProfile): void {
  for (const d of profile.diagnostics) {
    const tag = d.level === "ERROR" ? "✖" : d.level === "WARN" ? "⚠" : "i";
    const loc = d.location ? ` ${d.location}:` : "";
    console.log(`${tag} ${d.level}${loc} ${d.message}`);
  }
}

function exists(p: string): boolean {
  try { return fs.existsSync(p); } catch { return false; }
}

function looksLikePath(s: string): boolean {
  // A bare `provider/model` target must NOT be treated as a path. Match only
  // tokens that look unambiguously like a filesystem path: rooted, drive-letter,
  // relative-with-./, UNC, `.lapp`-suffixed, or exactly `.` / `..`.
  if (s === "." || s === "..") return true;
  if (s.endsWith(".lapp")) return true;
  if (s.startsWith("/") || s.startsWith("./") || s.startsWith("../") || s.startsWith("\\")) return true;
  if (/^[A-Za-z]:[\\/]/.test(s)) return true; // Windows drive letter
  return false;
}

function parseTarget(token: string): { provider?: string; model?: string } {
  if (!token.includes("/")) return { provider: token };
  const idx = token.indexOf("/");
  return { provider: token.slice(0, idx), model: token.slice(idx + 1) };
}

async function cmdValidate(args: string[]): Promise<number> {
  const root = args[0] ? resolveLappRoot(args[0]) : resolveLappRoot();
  const profile = loadProfile({ path: root });
  // loadProfile already called validateProfile internally; re-running it would
  // double-compute diagnostics and risk duplicate ERROR lines.
  const errors = profile.diagnostics.filter((d) => d.level === "ERROR").length;
  const warnings = profile.diagnostics.filter((d) => d.level === "WARN").length;
  console.log(`LAPP validate: ${root}`);
  printDiagnostics(profile);
  console.log(`Result: ${errors === 0 ? "passed" : "failed"} with ${errors} error(s), ${warnings} warning(s)`);
  return errors === 0 ? 0 : 1;
}

async function cmdInspect(args: string[], flags: Record<string, unknown>): Promise<number> {
  const root = args[0] ? resolveLappRoot(args[0]) : resolveLappRoot();
  const profile = loadProfile({ path: root });
  const summary = inspectProfile(profile, { revealSecrets: Boolean(flags["reveal-secrets"]) });
  console.log(`root: ${summary.rootDir}`);
  console.log(`providers (${summary.providers.length}):`);
  for (const p of summary.providers) {
    console.log(`  - ${p.id}${p.name ? ` (${p.name})` : ""} [${p.protocol}]${p.enabled ? "" : " (disabled)"}${p.coreProtocol ? "" : " (non-core)"}`);
    console.log(`    baseUrl: ${p.baseUrl}`);
    console.log(`    secret: ${p.secret.redacted} (scheme=${p.secret.scheme}, resolvable=${p.secret.resolvable}${p.secret.plaintextWarning ? ", plaintext-warning" : ""})`);
    if (p.models.length) {
      console.log(`    models (${p.modelCount}):`);
      for (const m of p.models) {
        const aliases = m.aliases?.length ? ` aliases=[${m.aliases.join(", ")}]` : "";
        console.log(`      - ${m.id}${m.name ? ` (${m.name})` : ""} [${m.type ?? "?"}]${aliases}${m.enabled ? "" : " (disabled)"}`);
      }
    }
  }
  if (summary.global?.defaultModel) {
    console.log(`global.defaultModel: ${summary.global.defaultModel.providerId}/${summary.global.defaultModel.model}`);
  }
  printDiagnostics(profile);
  return 0;
}

function loadOrCreate(root: string): LappProfile {
  return exists(root) ? loadProfile({ path: root }) : createProfile({ rootDir: root });
}

async function cmdInit(args: string[], flags: Record<string, unknown>): Promise<number> {
  const root = args[0] ? resolveLappRoot(args[0]) : resolveLappRoot();
  const providerId = flagString(flags, "provider");
  const protocol = flagString(flags, "protocol");
  const baseUrl = flagString(flags, "base-url");
  const secret = flagString(flags, "secret");
  const modelId = flagString(flags, "model");
  const force = flags["force"] === true;
  if (!providerId || !protocol || !baseUrl) {
    console.error("init requires --provider, --protocol, --base-url");
    return 2;
  }
  // init destroys any existing profile (it starts from createProfile, an
  // empty in-memory tree). Refuse to run on an existing profile unless
  // --force is set, mirroring the destructive-operation guard `provider remove`
  // already uses — a fat-fingered `init` on the wrong path would otherwise
  // wipe every provider/model/global in one command.
  if (!force && exists(root)) {
    const existing = loadProfile({ path: root, skipValidate: true });
    if (existing.providers.length > 0 || existing.global || existing.manifest) {
      console.error(`profile already exists at ${root} (use --force to overwrite)`);
      return 1;
    }
  }
  let profile = createProfile({ rootDir: root, manifest: true });
  profile = upsertProvider(profile, {
    id: providerId,
    protocol,
    baseUrl,
    ...(secret ? { auth: { secret } } : {}),
  });
  if (modelId) {
    profile = upsertModel(profile, { providerId, id: modelId, type: "chat" });
    profile = setDefaultModel(profile, { providerId, model: modelId });
  }
  return await maybeWrite(profile, flags);
}

async function cmdProvider(args: string[], flags: Record<string, unknown>): Promise<number> {
  const sub = args[0];
  const root = args.find(looksLikePath) ? resolveLappRoot(args.find(looksLikePath)!) : resolveLappRoot();
  // `provider remove` must refuse to operate on a non-existent profile —
  // creating an empty .lapp tree as a side effect of a no-op remove is
  // surprising. `provider add|set` is allowed to initialize a fresh tree.
  if ((sub === "remove") && !exists(root)) {
    console.error(`profile does not exist: ${root}`);
    return 1;
  }
  const profile = loadOrCreate(root);
  if (sub === "add" || sub === "set") {
    const id = flagString(flags, "id");
    const protocol = flagString(flags, "protocol");
    const baseUrl = flagString(flags, "base-url");
    const secret = flagString(flags, "secret");
    if (!id || !protocol || !baseUrl) {
      console.error("provider add requires --id, --protocol, --base-url");
      return 2;
    }
    const next = upsertProvider(profile, { id, protocol, baseUrl, ...(secret ? { auth: { secret } } : {}) });
    return await maybeWrite(next, flags);
  }
  if (sub === "remove") {
    const id = flagString(flags, "id");
    if (!id) { console.error("provider remove requires --id"); return 2; }
    const next = removeProvider(profile, id);
    return await maybeWrite(next, flags);
  }
  console.error(`unknown provider subcommand: ${sub ?? "(none)"}`);
  return 2;
}

async function cmdModel(args: string[], flags: Record<string, unknown>): Promise<number> {
  const sub = args[0];
  const root = args.find(looksLikePath) ? resolveLappRoot(args.find(looksLikePath)!) : resolveLappRoot();
  if ((sub === "remove") && !exists(root)) {
    console.error(`profile does not exist: ${root}`);
    return 1;
  }
  const profile = loadOrCreate(root);
  if (sub === "add" || sub === "set") {
    const providerId = flagString(flags, "provider");
    const id = flagString(flags, "id");
    if (!providerId || !id) { console.error("model add requires --provider, --id"); return 2; }
    const next = upsertModel(profile, {
      providerId,
      id,
      aliases: flagArray(flags, "alias").length ? flagArray(flags, "alias") : [id],
      type: flagString(flags, "type") ?? "chat",
    });
    return await maybeWrite(next, flags);
  }
  if (sub === "remove") {
    const providerId = flagString(flags, "provider");
    const id = flagString(flags, "id");
    if (!providerId || !id) { console.error("model remove requires --provider, --id"); return 2; }
    const next = removeModel(profile, { providerId, model: id });
    return await maybeWrite(next, flags);
  }
  console.error(`unknown model subcommand: ${sub ?? "(none)"}`);
  return 2;
}

async function cmdDefault(args: string[], flags: Record<string, unknown>): Promise<number> {
  const sub = args[0];
  const root = args.find(looksLikePath) ? resolveLappRoot(args.find(looksLikePath)!) : resolveLappRoot();
  // `default set` references a provider/model that must already exist; silently
  // creating a fresh tree and pointing a default at nothing leaves a broken
  // profile. Mirror the `provider/model remove` existence guard.
  if ((sub === "set") && !exists(root)) {
    console.error(`profile does not exist: ${root}`);
    return 1;
  }
  const profile = loadOrCreate(root);
  if (!profile.global) profile.global = { schemaVersion: "1.0" };
  if (sub === "set") {
    const providerId = flagString(flags, "provider");
    const model = flagString(flags, "model");
    if (!providerId || !model) { console.error("default set requires --provider, --model"); return 2; }
    const next = setDefaultModel(profile, { providerId, model });
    return await maybeWrite(next, flags);
  }
  console.error(`unknown default subcommand: ${sub ?? "(none)"}`);
  return 2;
}

async function cmdEnv(args: string[], flags: Record<string, unknown>): Promise<number> {
  const root = args.find(looksLikePath) ? resolveLappRoot(args.find(looksLikePath)!) : resolveLappRoot();
  const format = flagString(flags, "format") ?? "bash";
  const profile = loadProfile({ path: root });
  const out = exportEnv(profile, {
    format: format as "bash" | "zsh" | "fish" | "powershell" | "cmd",
    resolve: Boolean(flags["resolve"]),
    allowPlaintext: Boolean(flags["allow-plaintext"]),
  });
  console.log(out);
  return 0;
}

async function cmdPing(args: string[]): Promise<number> {
  const targetToken = args.find((a) => !looksLikePath(a));
  const pathArg = args.find(looksLikePath);
  const root = pathArg ? resolveLappRoot(pathArg) : resolveLappRoot();
  const profile = loadProfile({ path: root });
  const target = targetToken ? parseTarget(targetToken) : {};
  const client = createLappClient({
    profile,
    provider: target.provider,
    model: target.model,
    resolveSecrets: true,
  });
  const result = await client.testConnection();
  if (result.ok) {
    console.log(`pong: ${result.provider}/${result.model} (${result.protocol})`);
    return 0;
  }
  console.error(`ping failed: ${redactAll(result.message ?? "unknown")}`);
  return 1;
}

async function cmdChat(args: string[], flags: Record<string, unknown>): Promise<number> {
  const pathArg = args.find(looksLikePath);
  const positional = args.filter((a) => !looksLikePath(a));
  const root = pathArg ? resolveLappRoot(pathArg) : resolveLappRoot();
  if (positional.length === 0) {
    console.error("chat requires a <message>");
    return 2;
  }
  // Target resolution priority:
  //   1. --provider / --model flags (explicit, always preferred)
  //   2. First positional *only if* it contains a "/" AND has no spaces AND
  //      doesn't look like a filesystem path (a target token is a single
  //      word with one slash like "openai/gpt-4o"; a message like
  //      "compare A/B" or "check 1/2 of pizza" should not be misrouted).
  //   3. Otherwise treat all positionals as the message.
  // Without rule 2 multi-word messages like `what is the weather` would be
  // misparsed as `provider=what`. The stricter rule-2 check avoids
  // misrouting messages that merely contain a slash.
  let targetToken: string | undefined;
  let message: string;
  if (flagString(flags, "provider") || flagString(flags, "model")) {
    message = positional.join(" ");
  } else {
    const first = positional[0];
    if (first && first.includes("/") && !first.includes(" ") && !looksLikePath(first)) {
      targetToken = first;
      message = positional.slice(1).join(" ");
    } else {
      message = positional.join(" ");
    }
  }
  if (message === "") {
    console.error("chat requires a <message>");
    return 2;
  }
  const profile = loadProfile({ path: root });
  const target = targetToken ? parseTarget(targetToken) : {};
  const client = createLappClient({
    profile,
    provider: flagString(flags, "provider") ?? target.provider,
    model: flagString(flags, "model") ?? target.model,
    resolveSecrets: true,
  });
  const resp = await client.chat({ messages: [{ role: "user", content: message }] });
  // Print the assistant's reply verbatim. redactAll is for *errors* (which
  // can echo the request and the secret); applying it to the model's
  // answer would mangle legitimate content that happens to match a
  // key-shaped regex (e.g. the model explaining an API key format).
  console.log(resp.text);
  return 0;
}

async function cmdDoctor(args: string[]): Promise<number> {
  const root = args[0] ? resolveLappRoot(args[0]) : resolveLappRoot();
  const profile = loadProfile({ path: root });
  // loadProfile already called validateProfile; reuse its diagnostics.
  const errors = profile.diagnostics.filter((d) => d.level === "ERROR").length;
  const warnings = profile.diagnostics.filter((d) => d.level === "WARN").length;
  console.log(`lapp doctor: ${root}`);
  console.log(`node: ${process.version}`);
  console.log(`root: ${profile.rootDir}`);
  console.log(`providers: ${profile.providers.length}`);
  console.log(`errors: ${errors}, warnings: ${warnings}`);
  printDiagnostics(profile);
  let unsupported = 0;
  const problems: string[] = [];
  for (const p of profile.providers) {
    // Disabled providers are intentionally off — skip them so doctor doesn't
    // print 'provider is disabled' as a problem.
    if (p.config.enabled === false) continue;
    try {
      createLappClient({ profile, provider: p.config.id, resolveSecrets: false });
    } catch (err) {
      if (err instanceof UnsupportedProtocolError) {
        unsupported++;
        console.log(`  unsupported protocol: ${p.config.id} -> ${p.config.protocol}`);
      } else {
        // Other errors (TargetResolutionError for a provider with no
        // enabled model and no global default, etc.) are real
        // configuration issues the user should hear about. Report them
        // so `lapp doctor` doesn't silently pass a broken profile.
        problems.push(`  ${p.config.id}: ${redactAll((err as Error).message)}`);
      }
    }
  }
  for (const msg of problems) console.error(msg);
  console.log(unsupported > 0 ? `unsupported protocols: ${unsupported}` : "all protocols supported");
  // Exit non-zero on real problems (unsupported protocols OR broken-provider
  // problems) so CI can detect them. A pure-WARN profile still exits 0.
  if (unsupported > 0 || problems.length > 0) return 1;
  return errors === 0 ? 0 : 1;
}

async function maybeWrite(profile: LappProfile, flags: Record<string, unknown>): Promise<number> {
  const before = exists(profile.rootDir) ? loadProfile({ path: profile.rootDir, skipValidate: true }) : null;
  const plan = planChanges(before, profile);
  console.log("planned changes:");
  if (plan.changes.length === 0) {
    console.log("  (none)");
  } else {
    for (const c of plan.changes) {
      console.log(`  ${c.kind}: ${c.path}`);
    }
  }
  if (flags["dry-run"]) {
    console.log("(dry-run; not writing)");
    return 0;
  }
  if (!flags["yes"]) {
    console.log("pass --yes to apply.");
    return 0;
  }
  await writeProfileAtomic(profile, { before });
  console.log("written.");
  return 0;
}

type Command =
  | "validate" | "inspect" | "init" | "provider" | "model" | "default"
  | "env" | "ping" | "chat" | "doctor" | "help" | "version";

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const { args, flags } = parseFlags(argv);
  if (flags.help) { console.log(usage()); return 0; }
  if (flags.version) { console.log(VERSION); return 0; }

  const cmd = (args.shift() ?? "help") as Command;
  switch (cmd) {
    case "validate": return await cmdValidate(args);
    case "inspect": return await cmdInspect(args, flags);
    case "init": return await cmdInit(args, flags);
    case "provider": return await cmdProvider(args, flags);
    case "model": return await cmdModel(args, flags);
    case "default": return await cmdDefault(args, flags);
    case "env": return await cmdEnv(args, flags);
    case "ping": return await cmdPing(args);
    case "chat": return await cmdChat(args, flags);
    case "doctor": return await cmdDoctor(args);
    case "help": console.log(usage()); return 0;
    case "version": console.log(VERSION); return 0;
    default:
      console.error(`unknown command: ${cmd}`);
      console.error(usage());
      return 2;
  }
}

// Only auto-run when this module is the entry point (not when imported by tests).
const _isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (_isMain) {
  main().catch((err) => {
    console.error(redactAll((err as Error).message ?? String(err)));
    process.exit(1);
  }).then((code) => process.exit(code));
}

export {
  parseFlags,
  flagString,
  flagArray,
  redactAll,
  SECRET_PATTERNS,
  looksLikePath,
  parseTarget,
  exists,
  printDiagnostics,
  loadOrCreate,
  maybeWrite,
  cmdValidate,
  cmdInspect,
  cmdInit,
  cmdProvider,
  cmdModel,
  cmdDefault,
  cmdEnv,
  cmdPing,
  cmdChat,
  cmdDoctor,
  main,
};