/**
 * `lapp` — thin CLI wrapper over @openlapp/lapp.
 *
 * All profile logic lives in the SDK; the CLI only parses args, calls the SDK,
 * prints results, and redacts secrets by default.
 */

import fs from "node:fs";
import path from "node:path";
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
  setDefaultModelRef,
  planChanges,
  writeProfileAtomic,
  exportEnv,
  createLappClient,
  resolveLappRoot,
  UnsupportedProtocolError,
  syncProviderModels,
  applySyncedModels,
  replaceProviderModels,
  ensureGlobal,
  type LappProfile,
  type ChatMessage,
} from "@openlapp/lapp";
import {
  applyPreset,
  getPreset,
  listPresets,
  type PresetProtocolObject,
} from "./presets.js";
import {
  resolveLappCliHome,
  loadSession,
  saveSession,
  appendToSessionFile,
  listSessions,
  deleteSession,
  getLatestSession,
  generateSessionId,
  type SessionMeta,
} from "./sessions.js";

const VERSION = "lapp 1.0.0";

function usage(): string {
  return `Usage:
  lapp validate [path]
  lapp inspect [path] [--reveal-secrets]
  lapp provider add|set [path] --id <id|preset> [--protocol <p>...] [--protocol-base-url <url>] [--protocol-header 'k: v']... [--base-url <url>] [--secret <ref>] [--auth-type bearer|header|query|none] [--auth-header <name>] [--auth-query-param <name>] [--no-auth] [--model <id>] [--name <s>] [--header 'k: v']... [--link k=v]... [--enabled|--disabled] [--force]
  lapp provider remove [path] --id <id>
  lapp model add|set [path] --provider <id> --id <id> [--alias <a>...] [--type <t>] [--capability <c>...] [--input-modality <m>...] [--output-modality <m>...] [--context-window <n>] [--max-output-tokens <n>] [--model-protocol <p>] [--link k=v]... [--metadata k=v]... [--metadata-json '{...}'] [--enabled|--disabled]
  lapp model remove [path] --provider <id> --id <id>
  lapp models list [path]
  lapp models sync [path] --provider <id> [--apply] [--remove-stale] [--set-default] [--kind chat|embedding|image|tts|video]
  lapp default set [path] --provider <id> --model <id> [--kind chat|embedding|image|tts|video]
  lapp env [path] --format bash|zsh|fish|powershell|cmd [--resolve] [--allow-plaintext]
  lapp presets
  lapp ping [provider[/model]] [path]
  lapp chat [provider[/model]] <message> [path] [--provider <id> --model <id>] [--stream] [--tool <name:description:schema>] [--session <name> | --continue] [--system <prompt>] [--file <path>...] [--json] [--debug]
  lapp chat --list-sessions
  lapp chat --delete-session <name>
  lapp chat --delete-session-id <id>
  lapp doctor [path]
  lapp completions <bash|zsh|fish|powershell>

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
  // Boolean flags that should stay `true` even when written as `--flag=true`.
  const BOOLEAN_NAMES = new Set([
    "help", "version", "continue", "dry-run", "yes", "reveal-secrets", "resolve",
    "allow-plaintext", "debug", "stream", "json", "list-sessions", "no-auth",
    "enabled", "disabled", "force", "apply", "remove-stale", "set-default",
  ]);
  let i = 0;
  while (i < argv.length) {
    const a = argv[i]!;
    // Short forms that don't fit the generic BOOLEAN_NAMES pattern.
    if (a === "-h" || a === "-v" || a === "-c") {
      const name = a === "-h" ? "help" : a === "-v" ? "version" : "continue";
      flags[name] = true; i++; continue;
    }
    if (a === "--") { args.push(...argv.slice(i + 1)); break; }
    // Generic boolean flag: check BOOLEAN_NAMES, and peek at the next
    // token to honor explicit --flag true / --flag false / --flag 0 / --flag 1.
    if (a.startsWith("--")) {
      const boolName = a.slice(2);
      if (BOOLEAN_NAMES.has(boolName)) {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--") &&
            (next === "true" || next === "false" || next === "0" || next === "1")) {
          flags[boolName] = next === "true" || next === "1";
          i += 2;
        } else {
          flags[boolName] = true;
          i++;
        }
        continue;
      }
    }
    if (a.startsWith("--")) {
      // Support `--key=value` (e.g. `--provider=openai`). Split at the
      // FIRST `=` so a value like `a=b` survives intact. The
      // `--key value` form is handled below as a fallback.
      let key: string;
      let inlineValue: string | undefined;
      const eq = a.indexOf("=");
      if (eq !== -1) {
        key = a.slice(2, eq);
        inlineValue = a.slice(eq + 1);
      } else {
        key = a.slice(2);
      }
      if (key === "") {
        args.push(a);
        i++;
        continue;
      }
      if (inlineValue !== undefined) {
        // Treat `--key=` (empty value) as a boolean toggle, matching the
        // existing semantics where a flag with no value defaults to `true`.
        // For boolean-only flags, honor explicit `--flag=false` / `--flag=0`
        // so the user can negate one-way flags; any other value is `true`.
        if (inlineValue === "") {
          flags[key] = true;
        } else if (BOOLEAN_NAMES.has(key)) {
          flags[key] = inlineValue !== "false" && inlineValue !== "0";
        } else {
          if (key in flags) {
            const existing = flags[key];
            if (typeof existing === "boolean") {
              flags[key] = [inlineValue];
            } else if (Array.isArray(existing)) {
              flags[key] = [...existing, inlineValue];
            } else {
              flags[key] = [existing as string, inlineValue];
            }
          } else {
            flags[key] = inlineValue;
          }
        }
        i++;
        continue;
      }
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

/**
 * Parse a `--tool` value: `name[:description[:schemaJson]]`. The schema is
 * passed through verbatim to the adapter; defaults to `{ "type": "object" }`
 * when missing or unparseable. The CLI uses this for smoke-testing tool
 * support, so it errs on the side of being permissive.
 */
function parseToolSpec(spec: string): { name: string; description?: string; parameters: Record<string, unknown> } {
  // name is required and must not contain ':'. The description / schema may
  // contain ':', so split at most twice — indexOf rather than split(':')
  // to preserve colons inside the JSON schema.
  const firstColon = spec.indexOf(":");
  if (firstColon === -1) {
    return { name: spec, parameters: { type: "object", properties: {} } };
  }
  const name = spec.slice(0, firstColon);
  const rest = spec.slice(firstColon + 1);
  const secondColon = rest.indexOf(":");
  let description: string | undefined;
  let schemaJson: string | undefined;
  if (secondColon === -1) {
    description = rest;
  } else {
    description = rest.slice(0, secondColon);
    schemaJson = rest.slice(secondColon + 1);
  }
  let parameters: Record<string, unknown> = { type: "object", properties: {} };
  if (schemaJson && schemaJson.length > 0) {
    try {
      const parsed = JSON.parse(schemaJson) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        parameters = parsed as Record<string, unknown>;
      }
    } catch {
      // Keep the default — a bad schema shouldn't crash the chat command.
    }
  }
  return { name, ...(description ? { description } : {}), parameters };
}

/** True when a base URL points at a loopback address (localhost / 127.0.0.1 / ::1). */
function isLoopbackUrl(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false;
  try {
    const url = new URL(baseUrl);
    const host = url.hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "0.0.0.0";
  } catch {
    return false;
  }
}

/**
 * Read stdin to a string. Used for `lapp chat -` (pipe mode).
 * ponytail: synchronous buffer collection, handles the one-shot pipe case;
 * interactive TUI/REPL is a different product.
 */
function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    // Quick check: if stdin is a TTY, return empty immediately so the
    // caller can bail with a clear message instead of hanging.
    if (process.stdin.isTTY) { resolve(""); return; }
    const chunks: Buffer[] = [];
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => chunks.push(Buffer.from(chunk, "utf8")));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", () => resolve(""));
    // Resume stdin if it's paused (common in piped environments).
    if ((process.stdin as unknown as { isPaused?: () => boolean }).isPaused?.()) {
      process.stdin.resume();
    }
  });
}

/** Human-readable relative time for `--list-sessions`. */
function timeAgo(ts: number): string {
  // Clamp to at-most-now so clock drift / future timestamps don't
  // produce negative durations.
  const diff = Math.max(0, Date.now() - ts);
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  return `${days}d ago`;
}

// ---------------------------------------------------------------------------
// Shell completions (P1.5)
// ---------------------------------------------------------------------------

interface CmdDef {
  name: string;
  subs?: string[];
  flags?: string[];
  flagArgs?: string[];  // flags that take values (complete empty after them)
  positionalMeta?: string;
}

const COMMANDS: CmdDef[] = [
  { name: "validate", flags: [], positionalMeta: "[path]" },
  { name: "inspect", flags: ["--reveal-secrets"], positionalMeta: "[path]" },
  {
    name: "provider", subs: ["add", "set", "remove"],
    flags: ["--id", "--protocol", "--protocol-base-url", "--protocol-header", "--base-url", "--secret", "--auth-type", "--auth-header", "--auth-query-param", "--no-auth", "--model", "--name", "--header", "--link", "--enabled", "--disabled", "--force"],
    flagArgs: ["--id", "--protocol", "--protocol-base-url", "--protocol-header", "--base-url", "--secret", "--auth-type", "--auth-header", "--auth-query-param", "--model", "--name", "--header", "--link"],
  },
  {
    name: "model", subs: ["add", "set", "remove"],
    flags: ["--provider", "--id", "--alias", "--type", "--capability", "--input-modality", "--output-modality", "--context-window", "--max-output-tokens", "--model-protocol", "--link", "--metadata", "--metadata-json", "--enabled", "--disabled"],
    flagArgs: ["--provider", "--id", "--alias", "--type", "--capability", "--input-modality", "--output-modality", "--context-window", "--max-output-tokens", "--model-protocol", "--link", "--metadata", "--metadata-json"],
  },
  {
    name: "models", subs: ["list", "sync"],
    flags: ["--provider", "--apply", "--remove-stale", "--set-default", "--kind"],
    flagArgs: ["--provider", "--kind"],
  },
  {
    name: "default", subs: ["set"],
    flags: ["--provider", "--model", "--kind"],
    flagArgs: ["--provider", "--model", "--kind"],
  },
  {
    name: "env",
    flags: ["--format", "--resolve", "--allow-plaintext"],
    flagArgs: ["--format"],
  },
  { name: "presets", flags: [] },
  { name: "ping", positionalMeta: "[provider[/model]] [path]" },
  {
    name: "chat",
    flags: ["--provider", "--model", "--stream", "--tool", "--session", "--continue", "--system", "--file", "--json", "--debug", "--list-sessions", "--delete-session", "--delete-session-id"],
    flagArgs: ["--provider", "--model", "--tool", "--session", "--system", "--file", "--delete-session", "--delete-session-id"],
    positionalMeta: "[provider[/model]] <message> [path]",
  },
  { name: "doctor", positionalMeta: "[path]" },
  { name: "help" },
  { name: "version" },
];

function bashCompletions(): string {
  const cmds = COMMANDS.map((c) => c.name).join(" ");
  return `_lapp() {
  local cur prev words cword
  _init_completion || return
  COMPREPLY=()

  case \$prev in
    --format) COMPREPLY=( \$(compgen -W "bash zsh fish powershell cmd" -- "\$cur") ); return ;;
    --auth-type) COMPREPLY=( \$(compgen -W "bearer header query none" -- "\$cur") ); return ;;
    --kind) COMPREPLY=( \$(compgen -W "chat embedding image tts video" -- "\$cur") ); return ;;
    --type) COMPREPLY=( \$(compgen -W "chat embedding image tts video rerank" -- "\$cur") ); return ;;
  esac

  if [[ \$cword -eq 1 ]]; then
    COMPREPLY=( \$(compgen -W "${cmds}" -- "\$cur") )
  fi
}
complete -F _lapp lapp`;
}

function zshCompletions(): string {
  const cmds = COMMANDS.map((c) => c.name).join(" ");
  return `#compdef lapp
_lapp() {
  local -a commands
  commands=(${cmds})
  _arguments "1:command:(${cmds})"
}
_lapp`;
}

function fishCompletions(): string {
  const cmds = COMMANDS.map((c) => `"${c.name}"`).join(" ");
  return `# Fish completion for lapp
complete -c lapp -f
complete -c lapp -n "not __fish_seen_subcommand_from ${cmds}" -a "${cmds}"`;
}

function powershellCompletions(): string {
  const cmds = COMMANDS.map((c) => `'${c.name}'`).join(", ");
  return `Register-ArgumentCompleter -Native -CommandName lapp -ScriptBlock {
  param(\$wordToComplete, \$commandAst, \$cursorPosition)
  \$commands = @(${cmds})
  if (\$commandAst.CommandElements.Count -eq 1) {
    \$commands | Where-Object { \$_ -like "\$wordToComplete*" } | ForEach-Object { [System.Management.Automation.CompletionResult]::new(\$_, \$_, 'ParameterValue', \$_) }
  }
}`;
}

async function cmdCompletions(args: string[]): Promise<number> {
  const shell = args[0];
  switch (shell) {
    case "bash": console.log(bashCompletions()); return 0;
    case "zsh": console.log(zshCompletions()); return 0;
    case "fish": console.log(fishCompletions()); return 0;
    case "powershell": console.log(powershellCompletions()); return 0;
    default:
      console.error(`completions: unknown shell '${shell ?? "(none)"}'. Supported: bash, zsh, fish, powershell`);
      return 2;
  }
}

// ---------------------------------------------------------------------------
// Debug fetch wrapper (P2.1)
// ---------------------------------------------------------------------------

/**
 * Wrap fetch with request/response logging to stderr. Used by
 * `--debug` so users can inspect what's being sent and received.
 * Auth headers and secret-bearing body fields are redacted.
 */
function debugFetch(realFetch: typeof globalThis.fetch): typeof globalThis.fetch {
  return async (input, init) => {
    const url = typeof input === "string" ? input : "url" in input ? (input as Request).url : String(input);
    const method = init?.method ?? "GET";
    const headers: Record<string, string> = {};
    if (init?.headers) {
      try {
        if (init.headers instanceof Headers) {
          init.headers.forEach((v, k) => { headers[k] = v; });
        } else {
          for (const [k, v] of Object.entries(init.headers as Record<string, string>)) {
            headers[k] = v as string;
          }
        }
      } catch { /* leave headers empty — debug must not break the request */ }
    }
    for (const k of Object.keys(headers)) {
      if (/^(authorization|x-api-key|cookie|proxy-authorization)$/i.test(k)) headers[k] = "<redacted>";
    }
    // Capture the separator (? or &) so we preserve it in the replacement
    // instead of always emitting ? — a second &api_key=... in the URL should
    // not become ?api_key=... and break the query-string structure.
    const safeUrl = url.replace(
      /([?&])(api_key|apikey|api-token|api_token|access_token|private_token|token|key|secret|password|passwd)=[^&\s]*/gi,
      (_m, sep, p) => `${sep}${p}=<redacted>`,
    );
    console.error(`[debug] request: ${method} ${safeUrl}`);
    if (init?.body) {
      let s = "";
      if (typeof init.body === "string") {
        s = init.body;
      } else if (init.body instanceof URLSearchParams) {
        s = init.body.toString();
      } else if (init.body instanceof FormData || init.body instanceof Blob || init.body instanceof ArrayBuffer) {
        s = "<non-string body skipped>";
      } else {
        try {
          s = JSON.stringify(init.body);
        } catch {
          s = "<unserializable body skipped>";
        }
      }
      if (s) console.error(`[debug] request body: ${redactAll(s).slice(0, 800)}`);
    }
    const resp = await realFetch(input, init);
    console.error(`[debug] response: ${resp.status} ${resp.statusText}`);
    // Clone so the caller can still read the body. Keep it short — the
    // full body is printed as text/JSON by cmdChat itself.
    try {
      const cloned = resp.clone();
      const text = await cloned.text();
      console.error(`[debug] response body: ${redactAll(text).slice(0, 800)}`);
    } catch { /* ignore */ }
    return resp;
  };
}

// ---------------------------------------------------------------------------
// Multi-value parsing helpers (for --header 'k: v', --link k=v, --metadata,
// and the multi-protocol --protocol / --protocol-base-url / --protocol-header
// block).
// ---------------------------------------------------------------------------

/**
 * Parse a single `--header 'k: v'` / `--protocol-header 'k: v'` spec. Splits at
 * the FIRST colon so a value containing `:` (e.g. a URL) survives intact. Trims
 * both sides. Throws a usage error if there is no colon.
 */
function parseHeaderSpec(spec: string): [string, string] {
  const idx = spec.indexOf(":");
  if (idx === -1) {
    throw new Error(`invalid header spec (expected 'Name: value'): ${spec}`);
  }
  return [spec.slice(0, idx).trim(), spec.slice(idx + 1).trim()];
}

/** Parse a repeatable `--header 'k: v'` array into a header map. */
function parseHeaderSpecs(arr: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of arr) {
    const [k, v] = parseHeaderSpec(s);
    out[k] = v;
  }
  return out;
}

/**
 * Parse a repeatable `--link k=v` / `--metadata k=v` array into a string map.
 * Splits at the first `=`. Throws if an entry has no `=`.
 */
function parseKeyValueEquals(arr: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of arr) {
    const idx = s.indexOf("=");
    if (idx === -1) {
      throw new Error(`invalid k=v spec (expected 'key=value'): ${s}`);
    }
    out[s.slice(0, idx).trim()] = s.slice(idx + 1).trim();
  }
  return out;
}

/** Parse a CLI-supplied numeric field value. Rejects NaN, Infinity, negative,
 *  and non-integer inputs. Returns a non-negative integer or throws. */
function parsePositiveInteger(raw: string, label: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
    throw new Error(`--${label} must be a non-negative integer, got: ${raw}`);
  }
  return n;
}

/**
 * Parsed multi-protocol block. Each entry is a protocol id with optional
 * per-protocol baseUrl / requestHeaders overrides, gathered from
 * `--protocol` + `--protocol-base-url` + `--protocol-header`.
 */
export interface ParsedProtocolEntry extends PresetProtocolObject {}

export interface ParsedProtocolBlock {
  protocols: ParsedProtocolEntry[];
  /** Argv with protocol-block tokens removed; pass this to parseFlags. */
  remainingArgv: string[];
}

/**
 * Scan argv for the multi-protocol block
 * (`--protocol <id>` / `--protocol-base-url <url>` / `--protocol-header 'k: v'`,
 * each optionally repeated). The block does NOT have to lead argv — the scan
 * finds `--protocol` tokens wherever they appear. `--protocol-base-url` /
 * `--protocol-header` attach to the most recent `--protocol`.
 *
 * This is intentionally a separate scan from `parseFlags` because `parseFlags`
 * collapses repeated keys into arrays and loses the positional adjacency
 * between `--protocol` and its trailing `--protocol-header` flags. We pull the
 * block tokens out of argv, then hand the remainder to `parseFlags`.
 *
 * `--protocol-base-url` is rejected if it ends with `/` (spec: baseUrl must
 * not end with `/`); `--protocol-base-url` / `--protocol-header` without a
 * preceding `--protocol` is a usage error.
 */
export function parseProtocolBlock(argv: string[]): ParsedProtocolBlock {
  const protocols: ParsedProtocolEntry[] = [];
  const remainingArgv: string[] = [];
  let i = 0;
  let current: ParsedProtocolEntry | null = null;
  while (i < argv.length) {
    const a = argv[i]!;
    if (a === "--protocol") {
      const id = argv[i + 1];
      if (id === undefined || id.startsWith("--")) {
        throw new Error("--protocol requires a value");
      }
      // Push the previous entry (if any) before starting a new one.
      // A non-protocol token appearing between two --protocol blocks does
      // NOT flush current; only a new --protocol or end-of-argv does.
      if (current) protocols.push(current);
      current = { id };
      i += 2;
      continue;
    }
    if (a === "--protocol-base-url") {
      if (!current) throw new Error("--protocol-base-url requires a preceding --protocol");
      const url = argv[i + 1];
      if (url === undefined || url.startsWith("--")) {
        throw new Error("--protocol-base-url requires a value");
      }
      if (url.endsWith("/")) {
        throw new Error(`--protocol-base-url must not end with '/': ${url}`);
      }
      current.baseUrl = url;
      i += 2;
      continue;
    }
    if (a === "--protocol-header") {
      if (!current) throw new Error("--protocol-header requires a preceding --protocol");
      const spec = argv[i + 1];
      if (spec === undefined || spec.startsWith("--")) {
        throw new Error("--protocol-header requires a value");
      }
      const [k, v] = parseHeaderSpec(spec);
      current.requestHeaders = { ...(current.requestHeaders ?? {}), [k]: v };
      i += 2;
      continue;
    }
    // Not a protocol block token — keep it in remaining argv for the
    // main parser. Non-block tokens between --protocol blocks are fine:
    // the adjacency only matters within a single block entry.
    // ponytail: finalize-current-on-non-protocol would let `--secret`
    // interleave safely, but the current design keeps simplicity —
    // interleaved non-block flags don't break anything.
    remainingArgv.push(a);
    i++;
  }
  if (current) protocols.push(current);
  return { protocols, remainingArgv };
}

/**
 * Resolve whether a provider (by id, or by the resolved default target when no
 * explicit provider is given) should be called with `allowUnauthenticated`.
 *
 * The SDK stays fail-fast on unresolved secrets; the CLI decides here by
 * inspecting the provider's `auth` block. A provider counts as unauthenticated
 * when it has no `auth` block at all, `auth.type === "none"`, or no
 * `auth.secret`. This makes the documented `lapp init --no-auth && lapp chat`
 * flow for Ollama actually work (previously `chat`/`ping` threw
 * "auth.secret is missing or empty" because they never passed
 * `allowUnauthenticated`).
 */
export function resolveAllowUnauthenticated(profile: LappProfile, providerId?: string): boolean {
  let pid = providerId;
  if (!pid) {
    pid = profile.global?.defaultModel?.providerId;
  }
  if (!pid) {
    const firstEnabled = profile.providers.find((p) => p.config.enabled !== false);
    pid = firstEnabled?.config.id;
  }
  if (!pid) return false;
  const p = profile.providers.find((x) => x.config.id === pid);
  if (!p) return false;
  const auth = p.config.auth;
  if (!auth) return true;
  if (auth.type === "none") return true;
  if (auth.secret === undefined || auth.secret === "") return true;
  return false;
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
  /Bearer\s+[A-Za-z0-9._-]{8,}/gi,                 // Authorization: Bearer (case-insensitive)
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
  // fs.existsSync is documented not to throw on filesystem errors.
  return fs.existsSync(p);
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
    const protocolEntries = p.protocols ?? [{ id: p.protocol }];
    const protocols = protocolEntries.length > 1 ? protocolEntries.map((x) => x.id).join(", ") : p.protocol;
    console.log(`  - ${p.id}${p.name ? ` (${p.name})` : ""} [${protocols}]${p.enabled ? "" : " (disabled)"}${p.coreProtocol ? "" : " (non-core)"}`);
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
  if (summary.global) {
    const defaultKeys = [
      ["defaultModel", "chat"],
      ["defaultEmbeddingModel", "embedding"],
      ["defaultImageModel", "image"],
      ["defaultTextToSpeechModel", "tts"],
      ["defaultVideoModel", "video"],
    ] as const;
    for (const [key, label] of defaultKeys) {
      const ref = summary.global[key];
      if (ref) {
        console.log(`global.${label}: ${ref.providerId}/${ref.model}`);
      }
    }
  }
  printDiagnostics(profile);
  return 0;
}

function loadOrCreate(root: string, manifest?: boolean): LappProfile {
  if (exists(root)) return loadProfile({ path: root });
  return createProfile({ rootDir: root, manifest: manifest === true ? true : undefined });
}

/**
 * Build the `upsertProvider` input for `provider add|set` from the parsed
 * flags. Resolution order:
 *
 *   1. Multi-protocol block (`flags["__protocols"]`, set by `main` from the
 *      `--protocol` / `--protocol-base-url` / `--protocol-header` argv scan).
 *      When present, this fully drives `protocols`; preset and legacy
 *      single-protocol flags are ignored for the protocols field.
 *   2. Known preset (`--id` matches a preset) — fills `protocols`, `baseUrl`,
 *      `auth` from the preset, with explicit flags overriding individual
 *      pieces. Used only when no multi-protocol block and the user did not
 *      supply `--protocol` / `--base-url` / `--secret` / `--auth-type` /
 *      `--no-auth` to bypass it.
 *   3. Legacy: a single `--protocol` + `--base-url` (+ optional `--secret`).
 *
 * Throws a usage Error (message) on missing required input; the caller wraps it
 * into exit code 2.
 */
export function buildProviderInput(
  id: string,
  flags: Record<string, unknown>,
): {
  input: Parameters<typeof upsertProvider>[1];
  defaultModel?: string;
} {
  const blockProtocols = flags["__protocols"] as ParsedProtocolEntry[] | undefined;
  const protocolFlag = flagString(flags, "protocol");
  const baseUrlFlag = flagString(flags, "base-url");
  const secretFlag = flagString(flags, "secret");
  const authTypeFlag = flagString(flags, "auth-type");
  const noAuth = flags["no-auth"] === true;
  const hasExplicitAuth = noAuth || authTypeFlag !== undefined || secretFlag !== undefined;
  const hasExplicitProtocol = blockProtocols !== undefined || protocolFlag !== undefined;

  // --- Auth block (shared across all branches) -----------------------------
  // auth.type "none" via --no-auth; explicit --auth-type wins; otherwise a
  // secret produces { secret } (bearer is the SDK default when type omitted).
  function buildAuth(presetAuth?: { type: "none" } | { secret: string }): {
    type: "none" } | { type: string; secret: string } | { secret: string } | { type: string } | undefined {
    if (noAuth) return { type: "none" };
    if (authTypeFlag) {
      if (authTypeFlag === "none") return { type: "none" };
      if (secretFlag === undefined) {
        throw new Error(`--auth-type ${authTypeFlag} requires --secret (a secret ref like env://MY_KEY)`);
      }
      const base: { type: string; secret: string; header?: string; queryParam?: string } = { type: authTypeFlag, secret: secretFlag };
      const header = flagString(flags, "auth-header");
      if (header) base.header = header;
      const qp = flagString(flags, "auth-query-param");
      if (qp) base.queryParam = qp;
      return base;
    }
    if (secretFlag !== undefined) {
      const base: { secret: string; header?: string; queryParam?: string } = { secret: secretFlag };
      const header = flagString(flags, "auth-header");
      if (header) base.header = header;
      const qp = flagString(flags, "auth-query-param");
      if (qp) base.queryParam = qp;
      return base;
    }
    // No explicit auth flags: fall back to the preset's auth (may be undefined).
    return presetAuth;
  }

  // --- Branch 1: multi-protocol block --------------------------------------
  if (blockProtocols && blockProtocols.length > 0) {
    // The block already carries per-protocol baseUrl/headers; the provider
    // baseUrl is the explicit --base-url if given, else the first entry's
    // baseUrl, else required. Every protocol entry without its own baseUrl
    // inherits the provider-level baseUrl so resolution never falls back to
    // an undefined provider baseUrl.
    const baseUrl = baseUrlFlag ?? blockProtocols[0]!.baseUrl;
    if (!baseUrl) {
      throw new Error("provider add with --protocol block requires --base-url (or --protocol-base-url on the first entry)");
    }
    // Enforce baseUrl trailing-slash invariant (CLAUDE.md).
    if (baseUrl.endsWith("/")) {
      throw new Error(`--base-url must not end with '/': ${baseUrl}`);
    }
    const auth = buildAuth();
    const protocols: PresetProtocolObject[] = blockProtocols.map((p) => {
      const out: PresetProtocolObject = { id: p.id, baseUrl: p.baseUrl ?? baseUrl };
      if (p.requestHeaders) out.requestHeaders = p.requestHeaders;
      return out;
    });
    return {
      input: {
        id,
        baseUrl,
        protocols,
        ...(auth ? { auth } : {}),
      },
    };
  }

  // --- Branch 2: known preset ----------------------------------------------
  const preset = getPreset(id);
  if (preset && !hasExplicitProtocol && !baseUrlFlag && !hasExplicitAuth) {
    const res = applyPreset(id, {
      baseUrl: baseUrlFlag ?? undefined,
      secret: secretFlag ?? undefined,
      noAuth: noAuth || undefined,
      model: flagString(flags, "model") ?? undefined,
    });
    // Apply CLI overrides the preset didn't cover (name, headers, links,
    // enabled, auth.header/queryParam on top of a preset secret).
    const name = flagString(flags, "name");
    const headerArr = flagArray(flags, "header");
    const linkArr = flagArray(flags, "link");
    const enabled = resolveEnabled(flags);
    // defaultModel is not a ProviderInput field; keep it separate so
    // upsertProvider never sees it.
    const { defaultModel: _presetDm, ...presetInput } = res.input;
    const input = {
      ...presetInput,
      ...(name !== undefined ? { name } : {}),
      ...(headerArr.length ? { requestHeaders: parseHeaderSpecs(headerArr) } : {}),
      ...(linkArr.length ? { links: parseKeyValueEquals(linkArr) } : {}),
      ...(enabled !== undefined ? { enabled } : {}),
    };
    return { input, ...(_presetDm ? { defaultModel: _presetDm } : {} ) };
  }

  // --- Branch 3: legacy single protocol ------------------------------------
  if (!protocolFlag || !baseUrlFlag) {
    if (preset) {
      // Explicit flags (--protocol, --base-url, --secret, --auth-type,
      // --no-auth) bypass the preset — the user is saying "I know what
      // I want." When they supply some but not all required fields, tell
      // them what's missing instead of silently guessing.
      throw new Error(
        `provider add: --protocol and --base-url are required when any explicit flag bypasses preset '${id}' (got protocol=${protocolFlag ?? "(none)"} base-url=${baseUrlFlag ?? "(none)"}). Omit --protocol, --base-url, --secret, --auth-type, and --no-auth to use the preset, or supply both --protocol and --base-url.` +
        `\n  Example (preset): lapp provider add --id ${id} --yes` +
        `\n  Example (explicit): lapp provider add --id ${id} --protocol <p> --base-url <url> --secret <ref> --yes`,
      );
    }
    throw new Error("provider add requires --id (or a known preset), --protocol, --base-url");
  }
  const auth = buildAuth();
  const name = flagString(flags, "name");
  const headerArr = flagArray(flags, "header");
  const linkArr = flagArray(flags, "link");
  const enabled = resolveEnabled(flags);
  // Enforce baseUrl trailing-slash invariant (CLAUDE.md). Branch 1 validates
  // via parseProtocolBlock; Branch 2 uses preset baseUrls (validated by
  // review). Branch 3 is the hand-typed path — validate here.
  if (baseUrlFlag.endsWith("/")) {
    throw new Error(`--base-url must not end with '/': ${baseUrlFlag}`);
  }
  return {
    input: {
      id,
      protocol: protocolFlag,
      baseUrl: baseUrlFlag,
      ...(auth ? { auth } : {}),
      ...(name !== undefined ? { name } : {}),
      ...(headerArr.length ? { requestHeaders: parseHeaderSpecs(headerArr) } : {}),
      ...(linkArr.length ? { links: parseKeyValueEquals(linkArr) } : {}),
      ...(enabled !== undefined ? { enabled } : {}),
    },
  };
}

/** Resolve --enabled / --disabled into a boolean, or undefined when neither. */
function resolveEnabled(flags: Record<string, unknown>): boolean | undefined {
  if (flags["enabled"] === true) return true;
  if (flags["enabled"] === false) return false;
  if (flags["disabled"] === true) return false;
  if (flags["disabled"] === false) return true;
  return undefined;
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
  if (sub === "add" || sub === "set") {
    const id = flagString(flags, "id");
    if (!id) {
      console.error("provider add|set requires --id (a provider id or a known preset)");
      return 2;
    }
    // `add` absorbs the old `init` destructive-reset semantics via --force:
    // when the profile already exists and --force is set, start from a fresh
    // empty tree (with manifest) so the new provider replaces everything.
    // `set --force` does the same (resets the profile, then applies the
    // overlay — consistent with the usage line advertising --force for both
    // add|set). Without --force, both add and set operate on the existing tree.
    const force = flags["force"] === true;
    const profileExists = exists(root);
    const existing = profileExists ? loadProfile({ path: root, skipValidate: true }) : null;
    if (force && existing && (existing.providers.length > 0 || existing.global || existing.manifest)) {
      console.error(
        `--force will reset profile at ${root}, removing ${existing.providers.length} existing provider(s).`,
      );
    }
    // Fresh tree (with manifest) for a non-existent root, or for --force.
    const fresh = !profileExists || force;
    let profile = fresh
      ? createProfile({ rootDir: root, manifest: true })
      : loadOrCreate(root);
    let built: { input: Parameters<typeof upsertProvider>[1]; defaultModel?: string };
    try {
      built = buildProviderInput(id, flags);
    } catch (err) {
      console.error((err as Error).message);
      return 2;
    }
    profile = upsertProvider(profile, built.input);
    // --model: add the model and set it as the chat default in one command
    // (absorbs the old `init --model` convenience). For `set`, --model only
    // sets the default (the provider must already have the model). A preset's
    // suggested default model is only auto-added for `add`, never for `set`.
    const modelId = flagString(flags, "model") ?? (sub === "add" ? built.defaultModel : undefined);
    if (modelId) {
      if (sub === "add") {
        profile = upsertModel(profile, { providerId: id, id: modelId, type: "chat" });
      }
      profile = setDefaultModel(profile, { providerId: id, model: modelId });
    }
    return await maybeWrite(profile, flags);
  }
  if (sub === "remove") {
    const id = flagString(flags, "id");
    if (!id) { console.error("provider remove requires --id"); return 2; }
    const profile = loadOrCreate(root);
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
    // For `add`: default aliases to [id] so the model is addressable by id.
    // For `set`: omit aliases when --alias is not supplied so the overlay-
    // only invariant (CLAUDE.md row 7) holds — upsertModel preserves the
    // existing aliases instead of silently wiping them.
    const aliasArray = flagArray(flags, "alias");
    const isUpdate = sub === "set" && (flags["alias"] === undefined || aliasArray.length === 0);

    // Parse the now-reachable model fields. The old code read
    // `flags.links` / `flags.metadata` as objects, but parseFlags only ever
    // produces string | string[] | boolean — so those branches were dead.
    // Route through the k=v / JSON helpers instead.
    let linkInput: Record<string, string> | undefined;
    let metadataInput: Record<string, unknown> | undefined;
    try {
      const linkArr = flagArray(flags, "link");
      if (linkArr.length) linkInput = parseKeyValueEquals(linkArr);
      const metaArr = flagArray(flags, "metadata");
      const metaJson = flagString(flags, "metadata-json");
      if (metaJson) {
        const parsed = JSON.parse(metaJson) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          metadataInput = parsed as Record<string, unknown>;
        } else {
          throw new Error("--metadata-json must be a JSON object");
        }
      } else if (metaArr.length) {
        metadataInput = parseKeyValueEquals(metaArr);
      }
    } catch (err) {
      console.error((err as Error).message);
      return 2;
    }

    const capabilityArr = flagArray(flags, "capability");
    const inputModArr = flagArray(flags, "input-modality");
    const outputModArr = flagArray(flags, "output-modality");
    const contextWindow = flagString(flags, "context-window");
    const maxOutputTokens = flagString(flags, "max-output-tokens");
    const modelProtocol = flagString(flags, "model-protocol");
    const enabled = resolveEnabled(flags);
    // Validate numeric fields: reject NaN, negative, and non-integer values
    // before they reach upsertModel (which only checks typeof === "number").
    const cw = contextWindow !== undefined ? parsePositiveInteger(contextWindow, "context-window") : undefined;
    const mot = maxOutputTokens !== undefined ? parsePositiveInteger(maxOutputTokens, "max-output-tokens") : undefined;

    const next = upsertModel(profile, {
      providerId,
      id,
      ...(isUpdate ? {} : { aliases: aliasArray.length ? aliasArray : [id] }),
      type: flagString(flags, "type") ?? "chat",
      ...(capabilityArr.length ? { capabilities: capabilityArr } : {}),
      ...(inputModArr.length ? { inputModalities: inputModArr } : {}),
      ...(outputModArr.length ? { outputModalities: outputModArr } : {}),
      ...(cw !== undefined ? { contextWindow: cw } : {}),
      ...(mot !== undefined ? { maxOutputTokens: mot } : {}),
      ...(modelProtocol !== undefined ? { protocol: modelProtocol } : {}),
      ...(enabled !== undefined ? { enabled } : {}),
      ...(linkInput ? { links: linkInput } : {}),
      ...(metadataInput ? { metadata: metadataInput } : {}),
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

async function cmdModels(args: string[], flags: Record<string, unknown>): Promise<number> {
  const sub = args[0];
  const root = args.find(looksLikePath) ? resolveLappRoot(args.find(looksLikePath)!) : resolveLappRoot();

  if (sub === "list") {
    const profile = loadProfile({ path: root });
    for (const p of profile.providers) {
      console.log(`${p.config.id}: ${p.models?.models.map((m) => m.id).join(", ") ?? "(no models)"}`);
    }
    return 0;
  }

  if (sub === "sync") {
    if (!exists(root)) {
      console.error(`profile does not exist: ${root}`);
      return 1;
    }
    const providerId = flagString(flags, "provider");
    if (!providerId) { console.error("models sync requires --provider"); return 2; }
    const profile = loadProfile({ path: root });
    const provider = profile.providers.find((p) => p.config.id === providerId);
    if (!provider) {
      console.error(`provider not found in profile: ${providerId}`);
      return 1;
    }
    // `lapp models sync` is the primary use case for local/self-hosted
    // providers (Ollama etc.) which often carry no auth secret. Only allow
    // unauthenticated calls when the provider is explicitly no-auth or points
    // at a loopback address; remote providers with a missing secret must fail
    // fast per the secrets invariant.
    const authType = (provider.config.auth as { type?: string } | undefined)?.type;
    const allowUnauthenticated =
      authType === "none" ||
      (provider.config.auth === undefined && isLoopbackUrl(provider.config.baseUrl));
    const result = await syncProviderModels(profile, providerId, {
      resolveSecrets: true,
      allowUnauthenticated,
    });
    console.log(`synced models for ${providerId}:`);
    console.log(`  added: ${result.added.length}`);
    console.log(`  updated: ${result.updated.length}`);
    console.log(`  removed: ${result.removed.length}`);
    // --set-default requires --apply: setting a default to a model that was
    // never written would leave a dangling global reference. Checked early here
    // (before the dry-run/!apply bypass below) so the user gets a clear error
    // instead of a silent skip.
    if (flags["set-default"] === true && (flags.apply !== true || flags["dry-run"] === true)) {
      console.error("--set-default requires --apply (and cannot be combined with --dry-run)");
      return 2;
    }
    if (flags["dry-run"] === true || flags.apply !== true) {
      if (result.added.length) {
        console.log("  added ids: " + result.added.map((m) => m.id).join(", "));
      }
      if (result.updated.length) {
        console.log("  updated ids: " + result.updated.map((m) => m.id).join(", "));
      }
      if (result.removed.length) {
        console.log("  removed ids: " + result.removed.map((m) => m.id).join(", "));
      }
      if (flags.apply !== true) {
        console.log("pass --apply --yes to write changes.");
      }
      return 0;
    }
    const removeStale = Boolean(flags["remove-stale"]);
    const merged = applySyncedModels(provider.models, result);
    // If --remove-stale is set, also drop provider-sourced entries that the
    // provider no longer reports. Manual entries (source="manual") are kept
    // even when not in the fetched list, so a curated model survives a sync.
    const finalModels: typeof merged = removeStale
      ? { ...merged, models: merged.models.filter((m) => m.source !== "provider" || result.models.some((f) => f.id === m.id)) }
      : merged;
    // --set-default: resolve the candidate BEFORE writing so a dry sync
    // (empty result) doesn't first wipe the provider's models on disk and
    // then bail.
    let setDefaultRef: { key: ReturnType<typeof kindToDefaultKey>; providerId: string; model: string } | null = null;
    if (flags["set-default"] === true) {
      const kind = flagString(flags, "kind") ?? "chat";
      const key = kindToDefaultKey(kind);
      if (!key) { console.error(`invalid --kind: ${kind}`); return 2; }
      const candidate = result.models.find((m) => (m.type ?? "chat") === kind);
      if (!candidate) {
        console.error(`--set-default: no synced model found for kind '${kind}'`);
        return 1;
      }
      setDefaultRef = { key, providerId, model: candidate.id };
    }
    let next = replaceProviderModels(profile, providerId, finalModels.models.length > 0 ? finalModels : null);
    if (setDefaultRef) {
      next = setDefaultModelRef(next, setDefaultRef.key!, { providerId: setDefaultRef.providerId, model: setDefaultRef.model });
      console.log(`set default ${flagString(flags, "kind") ?? "chat"}: ${setDefaultRef.providerId}/${setDefaultRef.model}`);
    }
    return await maybeWrite(next, flags);
  }

  console.error(`unknown models subcommand: ${sub ?? "(none)"}`);
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
  const profile = ensureGlobal(loadOrCreate(root));
  if (sub === "set") {
    const providerId = flagString(flags, "provider");
    const model = flagString(flags, "model");
    if (!providerId || !model) { console.error("default set requires --provider, --model"); return 2; }
    const kind = flagString(flags, "kind") ?? "chat";
    const key = kindToDefaultKey(kind);
    if (!key) { console.error(`invalid --kind: ${kind}`); return 2; }
    const next = setDefaultModelRef(profile, key, { providerId, model });
    return await maybeWrite(next, flags);
  }
  console.error(`unknown default subcommand: ${sub ?? "(none)"}`);
  return 2;
}

/** Map CLI --kind value to the corresponding GlobalConfig key. */
function kindToDefaultKey(kind: string): "defaultModel" | "defaultEmbeddingModel" | "defaultImageModel" | "defaultTextToSpeechModel" | "defaultVideoModel" | undefined {
  switch (kind) {
    case "chat": return "defaultModel";
    case "embedding": return "defaultEmbeddingModel";
    case "image": return "defaultImageModel";
    case "tts": return "defaultTextToSpeechModel";
    case "video": return "defaultVideoModel";
    default: return undefined;
  }
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
    // Auto-allow-unauthenticated for no-auth providers (Ollama etc.) so
    // `lapp ping` against a `--no-auth` provider doesn't throw
    // "auth.secret is missing or empty". The SDK stays fail-fast; the CLI
    // decides here from the loaded profile.
    allowUnauthenticated: resolveAllowUnauthenticated(profile, target.provider),
  });
  const result = await client.testConnection();
  if (result.ok) {
    console.log(`pong: ${result.provider}/${result.model} (${result.protocol})`);
    return 0;
  }
  console.error(`ping failed: ${redactAll(result.message ?? "unknown")}`);
  return 1;
}

/**
 * Resolve a `--file` attachment path to an absolute path, rejecting absolute
 * inputs and traversal outside the current working directory. This prevents
 * `lapp chat --file /etc/passwd` or `--file ../../.env` from exfiltrating
 * sensitive files to a provider.
 */
function resolveAttachmentPath(raw: string): string {
  const resolved = path.resolve(raw);
  const rel = path.relative(process.cwd(), resolved);
  if (path.isAbsolute(raw) || rel.startsWith("..") || rel.includes("..")) {
    throw new Error(`file path must be relative and within the current working directory: ${raw}`);
  }
  return resolved;
}

async function cmdChat(args: string[], flags: Record<string, unknown>): Promise<number> {
  const pathArg = args.find(looksLikePath);
  const positional = args.filter((a) => !looksLikePath(a));
  const root = pathArg ? resolveLappRoot(pathArg) : resolveLappRoot();
  const cliHome = resolveLappCliHome();

  // --list-sessions / --delete-session (no message required)
  if (flags["list-sessions"]) {
    const sessions = listSessions(cliHome);
    if (sessions.length === 0) {
      console.log("no sessions yet.");
      return 0;
    }
    for (const s of sessions) {
      const age = timeAgo(new Date(s.updatedAt).getTime());
      const target = s.provider && s.model ? ` ${s.provider}/${s.model}` : "";
      const sys = s.systemPrompt ? ` [system]` : "";
      console.log(`${s.name.padEnd(20)} ${String(s.messageCount).padStart(3)} msgs${target}${sys}  ${age}`);
    }
    return 0;
  }

  if (flags["delete-session-id"]) {
    const id = flagString(flags, "delete-session-id");
    if (!id) { console.error("--delete-session-id requires a value"); return 2; }
    if (!listSessions(cliHome).some((s) => s.id === id)) {
      console.error(`session not found: ${id}`);
      return 1;
    }
    deleteSession(cliHome, id);
    console.log(`deleted session: ${id}`);
    return 0;
  }

  if (flags["delete-session"]) {
    const name = flagString(flags, "delete-session");
    if (!name) { console.error("--delete-session requires a value"); return 2; }
    // Match by name (display name). Names are not required to be unique, so
    // reject ambiguous matches and surface the ids so the user can retry with
    // --delete-session-id.
    const sessions = listSessions(cliHome);
    const matches = sessions.filter((s) => s.name === name);
    if (matches.length === 0) {
      console.error(`session not found: ${name}`);
      return 1;
    }
    if (matches.length > 1) {
      console.error(`session name '${name}' matches ${matches.length} sessions; use --delete-session-id with one of:`);
      for (const s of matches) {
        console.error(`  ${s.id} (${s.updatedAt})`);
      }
      return 1;
    }
    deleteSession(cliHome, matches[0]!.id);
    console.log(`deleted session: ${name}`);
    return 0;
  }

  if (positional.length === 0) {
    console.error("chat requires a <message>");
    return 2;
  }

  // --- Session resolution ----------------------------------------------------
  const useContinue = flags["continue"] === true;
  const sessionName = flagString(flags, "session");
  if (useContinue && sessionName) {
    console.error("--continue and --session are mutually exclusive");
    return 2;
  }

  let sessionMeta: SessionMeta | null = null;
  if (useContinue) {
    sessionMeta = getLatestSession(cliHome);
    if (!sessionMeta) {
      console.error("no previous session to continue — start one with `lapp chat --session <name> <message>`");
      return 1;
    }
  } else if (sessionName) {
    // Find existing session by name, or create a new id for a new one.
    const sessions = listSessions(cliHome);
    sessionMeta = sessions.find((s) => s.name === sessionName) ?? null;
    if (!sessionMeta) {
      // New session — will be created on save.
    }
  }

  // --- Target resolution -----------------------------------------------------
  const flagProvider = flagString(flags, "provider");
  const flagModel = flagString(flags, "model");
  if ((flagProvider && !flagModel) || (!flagProvider && flagModel)) {
    console.error("chat --provider and --model must be supplied together");
    return 2;
  }

  const profile = loadProfile({ path: root });

  let targetToken: string | undefined;
  let message: string;
  if (flagProvider && flagModel) {
    message = positional.join(" ");
  } else {
    const first = positional[0]!;
    const targetShape = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.exec(first);
    if (targetShape) {
      const [prov] = first.split("/");
      const provLower = prov!.toLowerCase();
      const providerKnown = profile.providers.some((p) => p.config.id === provLower);
      if (providerKnown) {
        targetToken = first;
        message = positional.slice(1).join(" ");
      } else {
        message = positional.join(" ");
      }
    } else {
      message = positional.join(" ");
    }
  }
  if (message === "") {
    console.error("chat requires a <message>");
    return 2;
  }
  const target = targetToken ? parseTarget(targetToken) : {};
  const providerId = flagProvider ?? target.provider ?? sessionMeta?.provider;
  const modelId = flagModel ?? target.model ?? sessionMeta?.model;

  // --- Stdin pipe ------------------------------------------------------------
  if (message === "-") {
    message = await readStdin();
    if (message === "") {
      console.error("chat: no input on stdin");
      return 2;
    }
  }

  const enabledProviders = profile.providers.filter((p) => p.config.enabled !== false);
  if (enabledProviders.length === 0) {
    console.error("no enabled providers in profile — run `lapp provider add` to create one, then `lapp chat`.");
    return 1;
  }
  const client = createLappClient({
    profile,
    provider: providerId,
    model: modelId,
    resolveSecrets: true,
    allowUnauthenticated: resolveAllowUnauthenticated(profile, providerId),
    ...(flags.debug ? { fetchImpl: debugFetch(globalThis.fetch) } : {}),
  });

  // --- System prompt ---------------------------------------------------------
  const systemFlag = flagString(flags, "system");
  const systemPrompt = systemFlag ?? sessionMeta?.systemPrompt;
  const systemMessages = systemPrompt ? [{ role: "system" as const, content: systemPrompt }] : [];

  // --- Session history -------------------------------------------------------
  let historyMessages: ChatMessage[] = [];
  let sessionId: string | undefined;
  if (sessionMeta) {
    sessionId = sessionMeta.id;
    historyMessages = loadSession(cliHome, sessionId);
  } else if (sessionName) {
    sessionId = generateSessionId(sessionName);
  }

  // Build the full message array: system + history + current user message
  const currentUser: ChatMessage = { role: "user", content: message };
  const allMessages = [...systemMessages, ...historyMessages, currentUser];

  // --- File attachments (text only) ------------------------------------------
  const filePaths = flagArray(flags, "file");
  if (filePaths.length > 0) {
    let fileContent = "";
    for (const fp of filePaths) {
      let resolved: string;
      try {
        resolved = resolveAttachmentPath(fp);
      } catch (err) {
        console.error(`warning: cannot read file: ${fp} (${(err as Error).message})`);
        continue;
      }
      try {
        const content = fs.readFileSync(resolved, "utf8");
        fileContent += `\n\n--- File: ${fp} ---\n${content}`;
      } catch (err) {
        console.error(`warning: cannot read file: ${fp} (${(err as Error).message})`);
      }
    }
    if (fileContent) {
      // Append file content to the last user message
      allMessages[allMessages.length - 1] = {
        role: "user",
        content: allMessages[allMessages.length - 1]!.content + fileContent,
      };
    }
  }

  // --- JSON output mode ------------------------------------------------------
  const jsonMode = flags["json"] === true;

  // --- Tool loop -------------------------------------------------------------
  const toolSpecs = flagArray(flags, "tool");
  if (toolSpecs.length > 0) {
    const tools = toolSpecs.map((spec) => parseToolSpec(spec));
    const handlers: Record<string, (args: Record<string, unknown>) => string> = {};
    for (const t of tools) handlers[t.name] = () => "(stub)";
    const out = await client.executeWithTools(
      { messages: allMessages },
      tools,
      handlers,
    );
    for (const m of out.messages) {
      if (m.role === "tool") {
        console.error(`\n[tool_result ${m.name ?? ""}(${m.toolCallId ?? ""}): ${m.content}]`);
      }
    }
    // Save the conversation if in session mode
    if (sessionId) {
      // Persist the full tool-call transcript so session replay preserves
      // tool results. Save the user message once (bumps messageCount),
      // append intermediate tool/tool-result messages directly to the
      // JSONL without bumping count, and save the final assistant message
      // (bumps count) — matching the non-stream save pattern.
      saveSession(cliHome, sessionId, currentUser, {
        name: sessionMeta?.name ?? sessionName,
        provider: client.providerId,
        model: client.model,
        systemPrompt,
      });
      let lastAssistantIndex = -1;
      for (let i = out.messages.length - 1; i >= 0; i--) {
        if (out.messages[i]!.role === "assistant") {
          lastAssistantIndex = i;
          break;
        }
      }
      for (let i = 0; i < out.messages.length; i++) {
        const m = out.messages[i]!;
        // User message was already saved above. Append every non-user message
        // except the final assistant, which is saved last so it bumps
        // messageCount once for the assistant turn.
        if (m.role !== "user" && i !== lastAssistantIndex) {
          appendToSessionFile(cliHome, sessionId, m);
        }
      }
      if (lastAssistantIndex >= 0) {
        saveSession(cliHome, sessionId, out.messages[lastAssistantIndex]!, {
          name: sessionMeta?.name ?? sessionName,
          provider: client.providerId,
          model: client.model,
          systemPrompt,
        });
      }
    }
    if (jsonMode) {
      console.log(JSON.stringify({
        text: out.text,
        provider: client.providerId,
        model: client.model,
        messages: out.messages.length,
      }));
    } else {
      console.log(out.text);
    }
    return 0;
  }

  // --- Stream mode -----------------------------------------------------------
  if (flags.stream) {
    const stream = client.stream({ messages: allMessages });
    let streamFailed = false;
    let fullText = "";
    let usageInfo: { inputTokens?: number; outputTokens?: number; totalTokens?: number } = {};
    let finishReason = "";
    for await (const ev of stream) {
      if (ev.kind === "delta") {
        fullText += ev.text;
        if (!jsonMode) process.stdout.write(ev.text);
      } else if (ev.kind === "tool-call") {
        console.error(`\n[tool_call: ${ev.name}(${ev.arguments})]`);
      } else if (ev.kind === "usage") {
        usageInfo = { inputTokens: ev.inputTokens, outputTokens: ev.outputTokens, totalTokens: ev.totalTokens };
        if (!jsonMode) {
          const usage = [ev.inputTokens, ev.outputTokens, ev.totalTokens]
            .map((n, i) => n !== undefined ? ["in", "out", "total"][i] + "=" + n : "")
            .filter(Boolean)
            .join(" ");
          if (usage) console.error(`\nusage: ${usage}`);
        }
      } else if (ev.kind === "finish") {
        finishReason = ev.reason;
        if (!jsonMode) console.error(`\nfinish: ${ev.reason}`);
      } else if (ev.kind === "error") {
        if (!jsonMode) console.error(`\nstream error: ${redactAll(ev.message)}`);
        streamFailed = true;
      }
    }
    if (!jsonMode) process.stdout.write("\n");

    // Save session
    if (sessionId && !streamFailed) {
      saveSession(cliHome, sessionId, currentUser, {
        name: sessionMeta?.name ?? sessionName,
        provider: client.providerId,
        model: client.model,
        systemPrompt,
      });
      saveSession(cliHome, sessionId, { role: "assistant", content: fullText });
    }

    if (jsonMode) {
      console.log(JSON.stringify({ text: fullText, provider: client.providerId, model: client.model, ...usageInfo, ...(finishReason ? { finishReason } : {}) }));
    }
    return streamFailed ? 1 : 0;
  }

  // --- Non-stream ------------------------------------------------------------
  const resp = await client.chat({ messages: allMessages });

  // Save session
  if (sessionId) {
    saveSession(cliHome, sessionId, currentUser, {
      name: sessionMeta?.name ?? sessionName,
      provider: client.providerId,
      model: client.model,
      systemPrompt,
    });
    saveSession(cliHome, sessionId, { role: "assistant", content: resp.text });
  }

  if (jsonMode) {
    console.log(JSON.stringify({
      text: resp.text,
      provider: resp.provider,
      model: resp.model,
      ...(resp.usage ? { usage: resp.usage } : {}),
      ...(resp.finishReason ? { finishReason: resp.finishReason } : {}),
      ...(resp.toolCalls?.length ? { toolCalls: resp.toolCalls } : {}),
    }));
  } else {
    console.log(resp.text);
  }
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
        console.log(`  unsupported protocol: ${p.config.id} -> ${err.protocol}`);
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
    // Non-zero exit when there are real changes to apply but the user did not
    // confirm. A forgotten --yes previously returned 0, which CI scripts read
    // as success and silently skipped the write. An empty plan still exits 0
    // (a genuine no-op).
    return plan.changes.length === 0 ? 0 : 1;
  }
  await writeProfileAtomic(profile, { before });
  console.log("written.");
  return 0;
}

/**
 * List the built-in provider presets (`lapp presets`). Pure read; no profile
 * interaction.
 */
async function cmdPresets(): Promise<number> {
  for (const p of listPresets()) {
    const protoIds = p.protocols.map((x) => (typeof x === "string" ? x : x.id)).join("|");
    const auth = p.noAuth ? "no-auth" : (p.suggestedSecret ?? "—");
    console.log(`${p.id.padEnd(14)} ${p.displayName.padEnd(20)} protocols=${protoIds}  auth=${auth}  baseUrl=${p.baseUrl}`);
    if (p.notes) console.log(`                 ${p.notes}`);
  }
  console.log("");
  console.log("Use a preset id with: lapp provider add --id <preset> [--model <id>] [--yes]");
  console.log("Extended protocols (e.g. gemini-generate-content) are not presets; edit provider.json by hand.");
  return 0;
}

type Command =
  | "validate" | "inspect" | "provider" | "model" | "models" | "default"
  | "env" | "ping" | "chat" | "doctor" | "presets" | "completions" | "help" | "version";

async function main(): Promise<number> {
  const rawArgv = process.argv.slice(2);
  // Pull the multi-protocol block out of argv before parseFlags collapses
  // repeated --protocol flags into an array (which loses the positional
  // adjacency between a --protocol and its trailing --protocol-base-url /
  // --protocol-header). The scan finds the block anywhere in argv; the
  // remainder goes to parseFlags.
  let block: ParsedProtocolBlock = { protocols: [], remainingArgv: rawArgv };
  try {
    block = parseProtocolBlock(rawArgv);
  } catch (err) {
    console.error((err as Error).message);
    return 2;
  }
  const { args, flags } = parseFlags(block.remainingArgv);
  if (block.protocols.length > 0) {
    // Stash on the flags object under an internal key. flagString / flagArray
    // look up exact keys, so they ignore this; cmdProvider reads it.
    (flags as Record<string, unknown>)["__protocols"] = block.protocols;
  }
  if (flags.help) { console.log(usage()); return 0; }
  if (flags.version) { console.log(VERSION); return 0; }

  const cmd = (args.shift() ?? "help") as Command;
  switch (cmd) {
    case "validate": return await cmdValidate(args);
    case "inspect": return await cmdInspect(args, flags);
    case "provider": return await cmdProvider(args, flags);
    case "model": return await cmdModel(args, flags);
    case "models": return await cmdModels(args, flags);
    case "default": return await cmdDefault(args, flags);
    case "env": return await cmdEnv(args, flags);
    case "ping": return await cmdPing(args);
    case "chat": return await cmdChat(args, flags);
    case "doctor": return await cmdDoctor(args);
    case "presets": return await cmdPresets();
    case "completions": return await cmdCompletions(args);
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
  parseToolSpec,
  parseHeaderSpec,
  parseHeaderSpecs,
  parseKeyValueEquals,
  exists,
  printDiagnostics,
  loadOrCreate,
  maybeWrite,
  cmdValidate,
  cmdInspect,
  cmdProvider,
  cmdModel,
  cmdModels,
  cmdDefault,
  cmdEnv,
  cmdPing,
  cmdChat,
  cmdCompletions,
  cmdDoctor,
  cmdPresets,
  readStdin,
  timeAgo,
  main,
};
export { applyPreset, getPreset, listPresets, PRESETS } from "./presets.js";
export type { ProviderPreset, PresetProtocolObject, PresetResolution } from "./presets.js";
export {
  resolveLappCliHome,
  ensureSessionsDir,
  loadSession,
  saveSession,
  appendToSessionFile,
  listSessions,
  deleteSession,
  getLatestSession,
  generateSessionId,
} from "./sessions.js";
export type { SessionMeta } from "./sessions.js";
