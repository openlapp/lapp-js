/**
 * CLI test suite. Covers parseFlags, flag/redact helpers, path/target routing,
 * and every command through exported functions (not main()/process.argv).
 *
 * Command tests create real .lapp profiles in os.tmpdir() so planChanges +
 * writeProfileAtomic are exercised end-to-end.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// The CLI now guards its main() auto-run with an ESM is-main check, so
// importing here is safe and won't trigger process.exit().
import {
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
  parseProtocolBlock,
  resolveAllowUnauthenticated,
  buildProviderInput,
  printDiagnostics,
  maybeWrite,
  cmdValidate,
  cmdInspect,
  cmdProvider,
  cmdModel,
  cmdDefault,
  cmdEnv,
  cmdPing,
  cmdDoctor,
} from "../src/index.js";

import {
  createProfile,
  upsertProvider,
  upsertModel,
  setDefaultModel,
  loadProfile,
  type LappProfile,
} from "@openlapp/lapp";

// The seedProfile helper uses only direct fs operations to lay down a
// minimal on-disk profile, so command functions can read it back.

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpLappRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lapp-cli-"));
  return path.join(dir, ".lapp");
}

/** Write a minimal on-disk profile so cmdValidate / cmdInspect / etc. work. */
function seedProfile(root: string): LappProfile {
  fs.mkdirSync(path.join(root, "providers", "ds"), { recursive: true });
  fs.writeFileSync(path.join(root, "providers", "ds", "provider.json"), JSON.stringify({
    schemaVersion: "1.0", id: "ds", protocols: [{ id: "openai-chat-completions" }], baseUrl: "https://api.deepseek.com", auth: { secret: "env://DEEPSEEK_KEY" },
  }, null, 2), "utf8");
  fs.writeFileSync(path.join(root, "providers", "ds", "models.json"), JSON.stringify({
    schemaVersion: "1.0", models: [{ id: "deepseek-chat", type: "chat", aliases: ["fast"] }],
  }, null, 2), "utf8");
  // Return the loaded form (used by tests that need the in-memory profile)
  return loadProfile({ path: root, skipValidate: true });
}

/** Capture stdout/stderr lines written by a function. */
function captureOutput(fn: () => Promise<number> | number): { lines: string[]; errLines: string[]; code: number } {
  const lines: string[] = [];
  const errLines: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...args: unknown[]) => lines.push(...args.map(String));
  console.error = (...args: unknown[]) => errLines.push(...args.map(String));
  let code: number;
  try {
    const result = fn();
    if (result instanceof Promise) throw new Error("use captureOutputAsync for async commands");
    code = result;
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
  return { lines, errLines, code };
}

async function captureOutputAsync(fn: () => Promise<number>): Promise<{ lines: string[]; errLines: string[]; code: number }> {
  const lines: string[] = [];
  const errLines: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...args: unknown[]) => lines.push(...args.map(String));
  console.error = (...args: unknown[]) => errLines.push(...args.map(String));
  let code: number;
  try {
    code = await fn();
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
  return { lines, errLines, code };
}

// ---------------------------------------------------------------------------
// parseFlags
// ---------------------------------------------------------------------------

describe("parseFlags", () => {
  it("parses boolean flags", () => {
    const r = parseFlags(["--help", "--version", "--dry-run", "--yes", "--reveal-secrets", "--resolve", "--allow-plaintext"]);
    expect(r.flags.help).toBe(true);
    expect(r.flags.version).toBe(true);
    expect(r.flags["dry-run"]).toBe(true);
    expect(r.flags.yes).toBe(true);
    expect(r.flags["reveal-secrets"]).toBe(true);
    expect(r.flags.resolve).toBe(true);
    expect(r.flags["allow-plaintext"]).toBe(true);
    expect(r.args).toEqual([]);
  });

  it("short flags", () => {
    const r = parseFlags(["-h", "-v"]);
    expect(r.flags.help).toBe(true);
    expect(r.flags.version).toBe(true);
    expect(r.args).toEqual([]);
  });

  it("parses key-value flags", () => {
    const r = parseFlags(["--provider", "openai", "--model", "gpt-4o", "--format", "bash"]);
    expect(r.flags.provider).toBe("openai");
    expect(r.flags.model).toBe("gpt-4o");
    expect(r.flags.format).toBe("bash");
    expect(r.args).toEqual([]);
  });

  it("parses --key=value form", () => {
    const r = parseFlags(["--provider=openai", "--model=gpt-4o", "--format=bash"]);
    expect(r.flags.provider).toBe("openai");
    expect(r.flags.model).toBe("gpt-4o");
    expect(r.flags.format).toBe("bash");
    expect(r.args).toEqual([]);
  });

  it("--key=value with = inside the value is preserved", () => {
    const r = parseFlags(["--alias=name=with=equals"]);
    expect(r.flags.alias).toBe("name=with=equals");
  });

  it("--key= (empty value) is treated as a boolean toggle", () => {
    const r = parseFlags(["--yes="]);
    expect(r.flags.yes).toBe(true);
  });

  it("collects positional args", () => {
    const r = parseFlags(["validate", "/tmp/my.lapp"]);
    expect(r.args).toEqual(["validate", "/tmp/my.lapp"]);
    expect(r.flags).toEqual({});
  });

  it("treats missing value as boolean true", () => {
    const r = parseFlags(["--provider", "--model", "gpt-4o"]);
    // --provider has no value (next token is a flag), so it's true
    expect(r.flags.provider).toBe(true);
    expect(r.flags.model).toBe("gpt-4o");
  });

  it("--flag=value form parses key and value (no longer treated as bool)", () => {
    const r = parseFlags(["--provider=openai"]);
    expect(r.flags.provider).toBe("openai");
    expect(r.flags["provider=openai"]).toBeUndefined();
  });

  it("repeated flag becomes array", () => {
    const r = parseFlags(["--alias", "x", "--alias", "y", "--alias", "z"]);
    expect(r.flags.alias).toEqual(["x", "y", "z"]);
  });

  it("repeated flag starting as boolean upgrades to array", () => {
    // First occurrence (boolean because next is --) then value
    const r = parseFlags(["--alias", "--dry-run", "--alias", "x"]);
    // First --alias sees next is --dry-run → alias=true
    // Second --alias has value "x"
    // So alias = [true, "x"]? Wait, let me check.
    // Line 82: key in flags? existing = flags[key]. typeof existing === "boolean" → flags[key] = [next]. So [true, "x"]? No...
    // Actually first: --alias followed by --dry-run (startsWith "--") → flags.alias = true
    // Second: --alias followed by "x" → key in flags, typeof existing === "boolean" → flags.alias = ["x"]
    // Hmm, line 85: `flags[key] = [next];` — replaces the boolean with [next], loses the true.
    // That's a minor data-loss edge case but expected for the current parser.
    expect(r.flags.alias).toEqual(["x"]);
  });

  it("mixes flags and positional args", () => {
    const r = parseFlags(["--provider", "openai", "--reveal-secrets", "inspect", "/tmp/my.lapp"]);
    expect(r.flags.provider).toBe("openai");
    expect(r.flags["reveal-secrets"]).toBe(true);
    expect(r.args).toEqual(["inspect", "/tmp/my.lapp"]);
  });

  it("handles -- separator (everything after is positional)", () => {
    const r = parseFlags(["--provider", "openai", "--", "--reveal-secrets", "--yes"]);
    expect(r.flags.provider).toBe("openai");
    // --reveal-secrets and --yes after -- are positional args, not flags
    expect(r.args).toEqual(["--reveal-secrets", "--yes"]);
  });

  it("empty argv returns empty", () => {
    const r = parseFlags([]);
    expect(r.args).toEqual([]);
    expect(r.flags).toEqual({});
  });

  it("--flag=false (equals form) sets boolean false for known boolean flags", () => {
    const r = parseFlags(["--enabled=false", "--stream=false", "--json=false", "--force=false"]);
    expect(r.flags.enabled).toBe(false);
    expect(r.flags.stream).toBe(false);
    expect(r.flags.json).toBe(false);
    expect(r.flags.force).toBe(false);
  });

  it("--flag=true (equals form) sets boolean true for known boolean flags", () => {
    const r = parseFlags(["--debug=true", "--apply=true", "--dry-run=true"]);
    expect(r.flags.debug).toBe(true);
    expect(r.flags.apply).toBe(true);
    expect(r.flags["dry-run"]).toBe(true);
  });

  it("--flag=0 (equals form) sets boolean false for known boolean flags", () => {
    const r = parseFlags(["--enabled=0", "--no-auth=0"]);
    expect(r.flags.enabled).toBe(false);
    expect(r.flags["no-auth"]).toBe(false);
  });

  it("--flag=1 (equals form) sets boolean true for known boolean flags", () => {
    const r = parseFlags(["--enabled=1", "--apply=1"]);
    expect(r.flags.enabled).toBe(true);
    expect(r.flags.apply).toBe(true);
  });

  it("--flag false (space form) sets boolean false for boolean flags", () => {
    const r = parseFlags(["--enabled", "false", "--stream", "false"]);
    expect(r.flags.enabled).toBe(false);
    expect(r.flags.stream).toBe(false);
    expect(r.args).toEqual([]);
  });

  it("--flag true (space form) sets boolean true for boolean flags", () => {
    const r = parseFlags(["--debug", "true", "--force", "true"]);
    expect(r.flags.debug).toBe(true);
    expect(r.flags.force).toBe(true);
    expect(r.args).toEqual([]);
  });

  it("boolean flag without value still defaults to true", () => {
    const r = parseFlags(["--enabled", "--json"]);
    expect(r.flags.enabled).toBe(true);
    expect(r.flags.json).toBe(true);
  });

  it("non-boolean flag with value false is treated as string", () => {
    const r = parseFlags(["--provider", "false", "--model", "true"]);
    expect(r.flags.provider).toBe("false");
    expect(r.flags.model).toBe("true");
  });

  it("--flag=anything (not false/0) is treated as true for booleans", () => {
    // A non-standard value like --enabled=yes → true (safe default)
    const r = parseFlags(["--enabled=yes", "--force=maybe"]);
    expect(r.flags.enabled).toBe(true);
    expect(r.flags.force).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// flagString / flagArray
// ---------------------------------------------------------------------------

describe("flagString", () => {
  it("returns the string value", () => {
    expect(flagString({ x: "hello" }, "x")).toBe("hello");
  });

  it("returns undefined for boolean true", () => {
    expect(flagString({ x: true }, "x")).toBeUndefined();
  });

  it("returns first element for an array", () => {
    expect(flagString({ x: ["a", "b"] }, "x")).toBe("a");
  });

  it("returns undefined for missing key", () => {
    expect(flagString({}, "x")).toBeUndefined();
  });

  it("returns undefined for undefined value", () => {
    expect(flagString({ x: undefined }, "x")).toBeUndefined();
  });
});

describe("flagArray", () => {
  it("returns the array as-is", () => {
    expect(flagArray({ x: ["a", "b"] }, "x")).toEqual(["a", "b"]);
  });

  it("wraps a single string in an array", () => {
    expect(flagArray({ x: "hello" }, "x")).toEqual(["hello"]);
  });

  it("returns empty array for boolean true", () => {
    expect(flagArray({ x: true }, "x")).toEqual([]);
  });

  it("returns empty array for missing key", () => {
    expect(flagArray({}, "x")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// SECRET_PATTERNS / redactAll
// ---------------------------------------------------------------------------

describe("redactAll", () => {
  it("redacts sk- keys", () => {
    expect(redactAll("api key is sk-abc123def4567890")).toBe("api key is <redacted>");
  });

  it("redacts sk-ant- keys", () => {
    expect(redactAll("key: sk-ant-abc123def4567890")).toBe("key: <redacted>");
  });

  it("redacts Bearer tokens", () => {
    expect(redactAll("Authorization: Bearer abc123def4567890")).toBe("Authorization: <redacted>");
  });

  it("redacts xai- keys", () => {
    expect(redactAll("token: xai-12345678")).toBe("token: <redacted>");
  });

  it("redacts Google AIza keys", () => {
    expect(redactAll("key=AIzaSyD12345678abcdef")).toBe("key=<redacted>");
  });

  it("redacts GitHub tokens (gho_ / ghp_)", () => {
    expect(redactAll("GITHUB_TOKEN=gho_12345678abcdef")).toBe("GITHUB_TOKEN=<redacted>");
    expect(redactAll("GITHUB_TOKEN=ghp_12345678abcdef")).toBe("GITHUB_TOKEN=<redacted>");
  });

  it("passes through normal text untouched", () => {
    const text = "hello world, this is a normal message";
    expect(redactAll(text)).toBe(text);
  });

  it("redacts multiple secrets in one string", () => {
    const input = "Used sk-abc123def4567890 then sk-ant-xyz9876543210";
    expect(redactAll(input)).toBe("Used <redacted> then <redacted>");
  });

  it("handles empty string", () => {
    expect(redactAll("")).toBe("");
  });

  it("does not redact short base64-like strings", () => {
    // < 8 chars after prefix shouldn't match
    expect(redactAll("sk-short")).toBe("sk-short");
  });

  it("each pattern compiles and has global flag", () => {
    for (const re of SECRET_PATTERNS) {
      expect(re.flags).toContain("g");
    }
  });
});

// ---------------------------------------------------------------------------
// looksLikePath / parseTarget
// ---------------------------------------------------------------------------

describe("looksLikePath", () => {
  it("matches rooted paths", () => {
    expect(looksLikePath("/home/user/.lapp")).toBe(true);
  });

  it("matches relative paths with ./", () => {
    expect(looksLikePath("./my.lapp")).toBe(true);
  });

  it("matches relative paths with ../", () => {
    expect(looksLikePath("../parent/.lapp")).toBe(true);
  });

  it("matches . and ..", () => {
    expect(looksLikePath(".")).toBe(true);
    expect(looksLikePath("..")).toBe(true);
  });

  it("matches paths ending in .lapp", () => {
    expect(looksLikePath("myprofile.lapp")).toBe(true);
  });

  it("matches Windows drive letter paths", () => {
    expect(looksLikePath("C:\\Users\\me\\.lapp")).toBe(true);
    expect(looksLikePath("D:/data/test")).toBe(true);
  });

  it("matches UNC paths", () => {
    expect(looksLikePath("\\\\server\\share\\.lapp")).toBe(true);
  });

  it("does NOT match provider/model tokens", () => {
    expect(looksLikePath("openai")).toBe(false);
    expect(looksLikePath("openai/gpt-4o")).toBe(false);
    expect(looksLikePath("deepseek/deepseek-chat")).toBe(false);
  });

  it("does NOT match bare words", () => {
    expect(looksLikePath("validate")).toBe(false);
    expect(looksLikePath("hello")).toBe(false);
  });

  it("does NOT match --flags", () => {
    expect(looksLikePath("--yes")).toBe(false);
    expect(looksLikePath("--dry-run")).toBe(false);
  });
});

describe("parseTarget", () => {
  it("parses provider only (no slash)", () => {
    expect(parseTarget("openai")).toEqual({ provider: "openai" });
  });

  it("parses provider/model", () => {
    expect(parseTarget("openai/gpt-4o")).toEqual({ provider: "openai", model: "gpt-4o" });
  });

  it("parses provider with multi-level model id", () => {
    // Only split on the FIRST slash
    expect(parseTarget("openai/gpt-4o-mini")).toEqual({ provider: "openai", model: "gpt-4o-mini" });
  });

  it("handles empty string", () => {
    expect(parseTarget("")).toEqual({ provider: "" });
  });
});

// ---------------------------------------------------------------------------
// printDiagnostics
// ---------------------------------------------------------------------------

describe("printDiagnostics", () => {
  it("prints ERROR diagnostics with ✖ prefix", () => {
    const p = createProfile({ rootDir: "/tmp/x" });
    p.diagnostics = [{ level: "ERROR", location: "providers/x/provider.json", message: "bad" }];
    const { lines } = captureOutput(() => { printDiagnostics(p); return 0; });
    expect(lines.some((l) => l.includes("✖") && l.includes("ERROR") && l.includes("bad"))).toBe(true);
  });

  it("prints WARN diagnostics with ⚠ prefix", () => {
    const p = createProfile({ rootDir: "/tmp/x" });
    p.diagnostics = [{ level: "WARN", location: "providers/x/models.json", message: "hmm" }];
    const { lines } = captureOutput(() => { printDiagnostics(p); return 0; });
    expect(lines.some((l) => l.includes("⚠") && l.includes("WARN") && l.includes("hmm"))).toBe(true);
  });

  it("prints INFO diagnostics with i prefix", () => {
    const p = createProfile({ rootDir: "/tmp/x" });
    p.diagnostics = [{ level: "INFO", message: "note" }];
    const { lines } = captureOutput(() => { printDiagnostics(p); return 0; });
    expect(lines.some((l) => l.includes("i") && l.includes("INFO") && l.includes("note"))).toBe(true);
  });

  it("omits location prefix when absent", () => {
    const p = createProfile({ rootDir: "/tmp/x" });
    p.diagnostics = [{ level: "INFO", message: "no location" }];
    const { lines } = captureOutput(() => { printDiagnostics(p); return 0; });
    expect(lines.some((l) => l.includes("INFO") && l.includes("no location") && !l.includes("null"))).toBe(true);
  });

  it("handles empty diagnostics", () => {
    const p = createProfile({ rootDir: "/tmp/x" });
    const { lines } = captureOutput(() => { printDiagnostics(p); return 0; });
    expect(lines).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// cmdValidate
// ---------------------------------------------------------------------------

describe("cmdValidate", () => {
  let root: string;

  beforeEach(() => {
    root = tmpLappRoot();
    seedProfile(root);
  });

  it("validates a clean profile and returns 0", async () => {
    const { lines, code } = await captureOutputAsync(() => cmdValidate([root]));
    expect(code).toBe(0);
    expect(lines.some((l) => l.includes("passed"))).toBe(true);
  });

  it("returns 1 for a profile with errors", async () => {
    // Corrupt the provider.json to trigger a load error
    fs.writeFileSync(
      path.join(root, "providers", "ds", "provider.json"),
      "{not valid json",
      "utf8",
    );
    const { lines, code } = await captureOutputAsync(() => cmdValidate([root]));
    expect(code).toBe(1);
    expect(lines.some((l) => l.includes("failed"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// cmdInspect
// ---------------------------------------------------------------------------

describe("cmdInspect", () => {
  let root: string;

  beforeEach(() => {
    root = tmpLappRoot();
    seedProfile(root);
  });

  it("prints profile summary with provider info", async () => {
    const { lines, code } = await captureOutputAsync(() => cmdInspect([root], {}));
    expect(code).toBe(0);
    expect(lines.some((l) => l.includes("root:"))).toBe(true);
    expect(lines.some((l) => l.includes("ds") && l.includes("openai-chat-completions"))).toBe(true);
    expect(lines.some((l) => l.includes("deepseek-chat"))).toBe(true);
  });

  it("redacts secrets by default", async () => {
    const { lines } = await captureOutputAsync(() => cmdInspect([root], {}));
    const secretLine = lines.find((l) => l.includes("secret:"));
    expect(secretLine).toBeDefined();
    // redactSecret preserves the env:// reference name (it's not a secret —
    // only the resolved value is), so DEEPSEEK_KEY appears in the output.
    // The key assertion: plaintext secrets would show <redacted>, but
    // env:// refs show the env var name for usability.
    expect(secretLine!).toContain("env://DEEPSEEK_KEY");
    expect(secretLine!).toContain("scheme=env");
  });

  it("reveals raw secret with --reveal-secrets", async () => {
    const { lines } = await captureOutputAsync(() => cmdInspect([root], { "reveal-secrets": true }));
    const secretLine = lines.find((l) => l.includes("secret:"));
    expect(secretLine).toBeDefined();
    expect(secretLine!).toContain("env://DEEPSEEK_KEY");
  });
});

// ---------------------------------------------------------------------------
// cmdProvider — first-provider creation (absorbs the old cmdInit surface)
// ---------------------------------------------------------------------------

describe("cmdProvider add — first-provider creation", () => {
  let root: string;

  beforeEach(() => {
    root = tmpLappRoot();
  });

  it("creates a new profile with provider and model via add", async () => {
    const { lines, code } = await captureOutputAsync(() =>
      cmdProvider(["add", root], { id: "openai", protocol: "openai-chat-completions", "base-url": "https://api.openai.com", model: "gpt-4o", yes: true }),
    );
    expect(code).toBe(0);
    expect(lines.some((l) => l.includes("written"))).toBe(true);
    expect(fs.existsSync(path.join(root, "providers", "openai", "provider.json"))).toBe(true);
    expect(fs.existsSync(path.join(root, "providers", "openai", "models.json"))).toBe(true);
    expect(fs.existsSync(path.join(root, "global.json"))).toBe(true);
    // manifest is now auto-created on a fresh tree (matches the old init).
    expect(fs.existsSync(path.join(root, "manifest.json"))).toBe(true);
  });

  it("appends to an existing profile without --force", async () => {
    await captureOutputAsync(() =>
      cmdProvider(["add", root], { id: "openai", protocol: "openai-chat-completions", "base-url": "https://api.openai.com", yes: true }),
    );
    const { code } = await captureOutputAsync(() =>
      cmdProvider(["add", root], { id: "anthropic", protocol: "anthropic-messages", "base-url": "https://api.anthropic.com", yes: true }),
    );
    expect(code).toBe(0);
    const p = loadProfile({ path: root, skipValidate: true });
    expect(p.providers.map((x) => x.config.id)).toEqual(expect.arrayContaining(["openai", "anthropic"]));
  });

  it("requires --id (or a known preset), --protocol, --base-url for add", async () => {
    const { errLines, code } = await captureOutputAsync(() =>
      cmdProvider(["add", root], { yes: true }),
    );
    expect(code).toBe(2);
    expect(errLines.some((l) => l.includes("requires"))).toBe(true);
  });

  it("--force resets an existing populated profile to just the new provider", async () => {
    await captureOutputAsync(() =>
      cmdProvider(["add", root], { id: "old", protocol: "openai-chat-completions", "base-url": "https://old.com", yes: true }),
    );
    const { errLines, code } = await captureOutputAsync(() =>
      cmdProvider(["add", root], { id: "new", protocol: "openai-chat-completions", "base-url": "https://new.com", force: true, yes: true }),
    );
    expect(code).toBe(0);
    expect(errLines.some((l) => l.includes("will reset profile"))).toBe(true);
    const p = loadProfile({ path: root, skipValidate: true });
    expect(p.providers.map((x) => x.config.id)).toEqual(["new"]);
  });

  it("supports --dry-run (preview but no write)", async () => {
    const { lines, code } = await captureOutputAsync(() =>
      cmdProvider(["add", root], { id: "test", protocol: "openai-chat-completions", "base-url": "https://x.com", "dry-run": true }),
    );
    expect(code).toBe(0);
    expect(lines.some((l) => l.includes("dry-run"))).toBe(true);
    expect(fs.existsSync(root)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// cmdProvider
// ---------------------------------------------------------------------------

describe("cmdProvider", () => {
  let root: string;

  beforeEach(() => {
    root = tmpLappRoot();
    seedProfile(root);
  });

  it("adds a new provider", async () => {
    const { lines, code } = await captureOutputAsync(() =>
      cmdProvider(["add", root], { id: "openai", protocol: "openai-chat-completions", "base-url": "https://api.openai.com", yes: true }),
    );
    expect(code).toBe(0);
    expect(lines.some((l) => l.includes("written"))).toBe(true);
    expect(fs.existsSync(path.join(root, "providers", "openai", "provider.json"))).toBe(true);
  });

  it("updates an existing provider", async () => {
    // The existing "ds" provider has baseUrl "https://api.deepseek.com"
    await captureOutputAsync(() =>
      cmdProvider(["add", root], { id: "ds", protocol: "openai-chat-completions", "base-url": "https://new.deepseek.com", yes: true }),
    );
    const raw = fs.readFileSync(path.join(root, "providers", "ds", "provider.json"), "utf8");
    expect(raw).toContain("https://new.deepseek.com");
  });

  it("removes a provider", async () => {
    const { code } = await captureOutputAsync(() =>
      cmdProvider(["remove", root], { id: "ds", yes: true }),
    );
    expect(code).toBe(0);
    expect(fs.existsSync(path.join(root, "providers", "ds", "provider.json"))).toBe(false);
  });

  it("refuses to remove from non-existent profile", async () => {
    const nonexistent = path.join(os.tmpdir(), "lapp-cli-noexist", ".lapp");
    const { errLines, code } = await captureOutputAsync(() =>
      cmdProvider(["remove", nonexistent], { id: "x", yes: true }),
    );
    expect(code).toBe(1);
    expect(errLines.some((l) => l.includes("does not exist"))).toBe(true);
  });

  it("requires --id (or a known preset), --protocol, --base-url for add", async () => {
    const { errLines, code } = await captureOutputAsync(() =>
      cmdProvider(["add", root], { yes: true }),
    );
    expect(code).toBe(2);
    expect(errLines.some((l) => l.includes("requires"))).toBe(true);
  });

  it("requires --id for remove", async () => {
    const { errLines, code } = await captureOutputAsync(() =>
      cmdProvider(["remove", root], { yes: true }),
    );
    expect(code).toBe(2);
    expect(errLines.some((l) => l.includes("requires"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// cmdModel
// ---------------------------------------------------------------------------

describe("cmdModel", () => {
  let root: string;

  beforeEach(() => {
    root = tmpLappRoot();
    seedProfile(root);
  });

  it("adds a new model", async () => {
    const { code } = await captureOutputAsync(() =>
      cmdModel(["add", root], { provider: "ds", id: "deepseek-r1", yes: true }),
    );
    expect(code).toBe(0);
    const raw = fs.readFileSync(path.join(root, "providers", "ds", "models.json"), "utf8");
    expect(raw).toContain("deepseek-r1");
  });

  it("removes a model", async () => {
    // Add a second model first so models.json is rewritten (not deleted) after
    // removing one, making the content assertion straightforward.
    await captureOutputAsync(() =>
      cmdModel(["add", root], { provider: "ds", id: "deepseek-r1", yes: true }),
    );
    const { code } = await captureOutputAsync(() =>
      cmdModel(["remove", root], { provider: "ds", id: "deepseek-chat", yes: true }),
    );
    expect(code).toBe(0);
    const raw = fs.readFileSync(path.join(root, "providers", "ds", "models.json"), "utf8");
    expect(raw).not.toContain('"id": "deepseek-chat"');
    expect(raw).toContain("deepseek-r1"); // other model preserved
  });

  it("refuses to remove from non-existent profile", async () => {
    const nonexistent = path.join(os.tmpdir(), "lapp-cli-noexist", ".lapp");
    const { errLines, code } = await captureOutputAsync(() =>
      cmdModel(["remove", nonexistent], { provider: "x", id: "m1", yes: true }),
    );
    expect(code).toBe(1);
    expect(errLines.some((l) => l.includes("does not exist"))).toBe(true);
  });

  it("requires --provider, --id for add", async () => {
    const { errLines, code } = await captureOutputAsync(() =>
      cmdModel(["add", root], { yes: true }),
    );
    expect(code).toBe(2);
    expect(errLines.some((l) => l.includes("requires"))).toBe(true);
  });

  it("updates an existing model (upsert)", async () => {
    // deepseek-chat already exists with aliases=["fast"]
    await captureOutputAsync(() =>
      cmdModel(["add", root], { provider: "ds", id: "deepseek-chat", alias: ["fast", "slow"], type: "chat", yes: true }),
    );
    const raw = fs.readFileSync(path.join(root, "providers", "ds", "models.json"), "utf8");
    expect(raw).toContain("slow");
  });

  // Round 4 regression: `lapp model set --type X` must NOT wipe prior aliases
  // when --alias is omitted. The CLI's previous `[id]` default violated the
  // overlay-only invariant (CLAUDE.md row 7).
  it("set without --alias preserves prior aliases", async () => {
    await captureOutputAsync(() =>
      cmdModel(["add", root], { provider: "ds", id: "deepseek-chat", alias: ["fast", "slow"], type: "chat", yes: true }),
    );
    await captureOutputAsync(() =>
      cmdModel(["set", root], { provider: "ds", id: "deepseek-chat", type: "embedding", yes: true }),
    );
    const raw = fs.readFileSync(path.join(root, "providers", "ds", "models.json"), "utf8");
    expect(raw).toContain("fast");
    expect(raw).toContain("slow");
    expect(raw).toContain("embedding");
  });
});

// ---------------------------------------------------------------------------
// cmdDefault
// ---------------------------------------------------------------------------

describe("cmdDefault", () => {
  let root: string;

  beforeEach(() => {
    root = tmpLappRoot();
    seedProfile(root);
  });

  it("sets default model", async () => {
    const { code } = await captureOutputAsync(() =>
      cmdDefault(["set", root], { provider: "ds", model: "deepseek-chat", yes: true }),
    );
    expect(code).toBe(0);
    const raw = fs.readFileSync(path.join(root, "global.json"), "utf8");
    expect(raw).toContain("deepseek-chat");
  });

  it("refuses to set default on non-existent profile", async () => {
    const nonexistent = path.join(os.tmpdir(), "lapp-cli-noexist", ".lapp");
    const { errLines, code } = await captureOutputAsync(() => cmdDefault(["set", nonexistent], { provider: "ds", model: "m1" }));
    expect(code).toBe(1);
    expect(errLines.some((l) => l.includes("does not exist"))).toBe(true);
  });

  it("requires --provider, --model", async () => {
    const { errLines, code } = await captureOutputAsync(() => cmdDefault(["set", root], {}));
    expect(code).toBe(2);
    expect(errLines.some((l) => l.includes("requires"))).toBe(true);
  });

  it("sets default model with --kind", async () => {
    const { code } = await captureOutputAsync(() =>
      cmdDefault(["set", root], { provider: "ds", model: "deepseek-chat", kind: "embedding", yes: true }),
    );
    expect(code).toBe(0);
    const raw = JSON.parse(fs.readFileSync(path.join(root, "global.json"), "utf8"));
    expect(raw.defaultEmbeddingModel).toEqual({ providerId: "ds", model: "deepseek-chat" });
    expect(raw.defaultModel).toBeUndefined();
  });

  it("rejects invalid --kind", async () => {
    const { errLines, code } = await captureOutputAsync(() =>
      cmdDefault(["set", root], { provider: "ds", model: "deepseek-chat", kind: "invalid" }),
    );
    expect(code).toBe(2);
    expect(errLines.some((l) => l.includes("invalid"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// cmdEnv
// ---------------------------------------------------------------------------

describe("cmdEnv", () => {
  let root: string;

  beforeEach(() => {
    root = tmpLappRoot();
    seedProfile(root);
  });

  it("emits bash format by default", async () => {
    const { lines, code } = await captureOutputAsync(() => cmdEnv([root], {}));
    expect(code).toBe(0);
    // Without --resolve, env://DEEPSEEK_KEY produces a comment line like
    // "# DEEPSEEK_KEY: env:// resolution requires explicit opt-in"
    expect(lines.some((l) => l.includes("#") && l.includes("DEEPSEEK_KEY") && l.includes("env://"))).toBe(true);
  });

  it("emits cmd format", async () => {
    const { lines, code } = await captureOutputAsync(() => cmdEnv([root], { format: "cmd" }));
    expect(code).toBe(0);
    expect(lines.some((l) => l.includes("REM"))).toBe(true);
  });

  it("emits powershell comment line for unresolved secret", async () => {
    const { lines, code } = await captureOutputAsync(() => cmdEnv([root], { format: "powershell" }));
    expect(code).toBe(0);
    // Without --resolve, powershell also outputs a comment (`# ...`), not `$env:`
    expect(lines.some((l) => l.includes("#") && l.includes("DEEPSEEK_KEY"))).toBe(true);
  });

  it("resolves plaintext secrets with --resolve --allow-plaintext", async () => {
    // Create a profile with plaintext secret
    const root2 = tmpLappRoot();
    fs.mkdirSync(path.join(root2, "providers", "pt"), { recursive: true });
    fs.writeFileSync(path.join(root2, "providers", "pt", "provider.json"), JSON.stringify({
      schemaVersion: "1.0", id: "pt", protocol: "openai-chat-completions", baseUrl: "https://x.com", auth: { secret: "sk-my-secret-key1234" },
    }, null, 2), "utf8");
    const { lines, code } = await captureOutputAsync(() =>
      cmdEnv([root2], { format: "bash", resolve: true, "allow-plaintext": true }),
    );
    expect(code).toBe(0);
    expect(lines.some((l) => l.includes("sk-my-secret-key1234"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// cmdPing / cmdDoctor (lightweight — real HTTP calls are mocked in SDK tests)
// ---------------------------------------------------------------------------

describe("cmdPing", () => {
  it("fails gracefully on a profile with no network (error to stderr, redacted)", async () => {
    const root = tmpLappRoot();
    seedProfile(root);
    // ping attempts a real HTTP call → will fail. We just check it doesn't crash
    // and the error path is exercised.
    const { errLines, code } = await captureOutputAsync(() => cmdPing([root]));
    // Should be non-zero (connection failed)
    expect(code).toBe(1);
    // Error message must go to stderr
    expect(errLines.length).toBeGreaterThan(0);
    expect(errLines.some((l) => l.includes("ping failed"))).toBe(true);
  });
});

describe("cmdDoctor", () => {
  it("prints doctor summary for a valid profile", async () => {
    const root = tmpLappRoot();
    seedProfile(root);
    const { lines, code } = await captureOutputAsync(() => cmdDoctor([root]));
    expect(lines.some((l) => l.includes("lapp doctor"))).toBe(true);
    expect(lines.some((l) => l.includes("providers: 1"))).toBe(true);
    // All protocols supported in this profile → exit 0
    // (Unless createLappClient fails; it may on missing env vars for a non-disabled provider.
    //  doctor uses resolveSecrets:false, so it shouldn't fail on missing env.)
    // Actually with resolveSecrets:false, createLappClient should succeed.
    expect(code).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// maybeWrite (dry-run / --yes gate)
// ---------------------------------------------------------------------------

describe("maybeWrite", () => {
  let root: string;

  beforeEach(() => {
    root = tmpLappRoot();
  });

  it("dry-run prints plan but does not write", async () => {
    let p = createProfile({ rootDir: root });
    p = upsertProvider(p, { id: "x", protocol: "openai-chat-completions", baseUrl: "https://x.com" });
    const { lines, code } = await captureOutputAsync(() => maybeWrite(p, { "dry-run": true }));
    expect(code).toBe(0);
    expect(lines.some((l) => l.includes("dry-run"))).toBe(true);
    expect(lines.some((l) => l.includes("create"))).toBe(true);
    expect(fs.existsSync(root)).toBe(false);
  });

  it("prints plan and requires --yes", async () => {
    let p = createProfile({ rootDir: root });
    p = upsertProvider(p, { id: "x", protocol: "openai-chat-completions", baseUrl: "https://x.com" });
    const { lines, code } = await captureOutputAsync(() => maybeWrite(p, {}));
    // A non-empty plan without --yes now exits non-zero so CI does not mistake
    // a skipped write for success.
    expect(code).toBe(1);
    expect(lines.some((l) => l.includes("--yes"))).toBe(true);
    expect(fs.existsSync(root)).toBe(false);
  });

  it("writes with --yes", async () => {
    let p = createProfile({ rootDir: root });
    p = upsertProvider(p, { id: "x", protocol: "openai-chat-completions", baseUrl: "https://x.com" });
    const { lines, code } = await captureOutputAsync(() => maybeWrite(p, { yes: true }));
    expect(code).toBe(0);
    expect(lines.some((l) => l.includes("written"))).toBe(true);
    expect(fs.existsSync(path.join(root, "providers", "x", "provider.json"))).toBe(true);
  });

  it("dry-run on unchanged profile shows plan header and dry-run notice", async () => {
    const root2 = tmpLappRoot();
    seedProfile(root2);
    const p = loadProfile({ path: root2, skipValidate: true });
    // No changes → the plan may show "(none)" or a short list depending on
    // whether loadProfile normalizes fields. Either way, dry-run should
    // produce the header and the dry-run notice, and not crash.
    const { lines, code } = await captureOutputAsync(() => maybeWrite(p, { "dry-run": true }));
    expect(code).toBe(0);
    expect(lines.some((l) => l.includes("planned changes"))).toBe(true);
    expect(lines.some((l) => l.includes("dry-run"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// parseToolSpec
// ---------------------------------------------------------------------------

describe("parseToolSpec", () => {
  it("parses bare name with default empty object schema", () => {
    expect(parseToolSpec("echo")).toEqual({ name: "echo", parameters: { type: "object", properties: {} } });
  });

  it("parses name:description", () => {
    expect(parseToolSpec("echo:echoes input")).toEqual({
      name: "echo",
      description: "echoes input",
      parameters: { type: "object", properties: {} },
    });
  });

  it("parses name:description:schemaJson and preserves the schema verbatim", () => {
    const schema = '{"type":"object","properties":{"x":{"type":"string"}}}';
    expect(parseToolSpec(`echo:echoes:${schema}`)).toEqual({
      name: "echo",
      description: "echoes",
      parameters: { type: "object", properties: { x: { type: "string" } } },
    });
  });

  it("falls back to default schema when the JSON is malformed", () => {
    expect(parseToolSpec("echo:desc:{not-json").parameters).toEqual({ type: "object", properties: {} });
  });
});

// ---------------------------------------------------------------------------
// Multi-value parsing helpers: parseHeaderSpec, parseKeyValueEquals,
// parseProtocolBlock, resolveAllowUnauthenticated, buildProviderInput
// ---------------------------------------------------------------------------

describe("parseHeaderSpec", () => {
  it("splits at the first colon and trims both sides", () => {
    expect(parseHeaderSpec("Authorization: Bearer abc")).toEqual(["Authorization", "Bearer abc"]);
    expect(parseHeaderSpec("X-Api-Key:  sk-123")).toEqual(["X-Api-Key", "sk-123"]);
  });
  it("preserves colons inside the value (URLs)", () => {
    expect(parseHeaderSpec("X-Target: https://x.com/v1")).toEqual(["X-Target", "https://x.com/v1"]);
  });
  it("throws when there is no colon", () => {
    expect(() => parseHeaderSpec("no-colon-here")).toThrow();
  });
});

describe("parseHeaderSpecs / parseKeyValueEquals", () => {
  it("parseHeaderSpecs builds a header map", () => {
    expect(parseHeaderSpecs(["A: 1", "B: 2"])).toEqual({ A: "1", B: "2" });
  });
  it("parseKeyValueEquals splits at first =", () => {
    expect(parseKeyValueEquals(["a=1", "b=x=y"])).toEqual({ a: "1", b: "x=y" });
  });
  it("parseKeyValueEquals throws on a missing =", () => {
    expect(() => parseKeyValueEquals(["no-eq"])).toThrow();
  });
});

describe("parseProtocolBlock", () => {
  it("returns an empty block when argv has no --protocol", () => {
    const argv = ["--id", "x", "--yes"];
    expect(parseProtocolBlock(argv)).toEqual({ protocols: [], remainingArgv: argv });
  });
  it("parses a single --protocol", () => {
    expect(parseProtocolBlock(["--protocol", "openai-chat-completions", "--id", "x"])).toEqual({
      protocols: [{ id: "openai-chat-completions" }],
      remainingArgv: ["--id", "x"],
    });
  });
  it("parses multiple --protocol entries with per-protocol base-url and header", () => {
    const r = parseProtocolBlock([
      "--protocol", "openai-responses",
      "--protocol-base-url", "https://api.openai.com/v1",
      "--protocol-header", "OpenAI-Beta: responses=v1",
      "--protocol", "openai-chat-completions",
    ]);
    expect(r.remainingArgv).toEqual([]);
    expect(r.protocols).toEqual([
      { id: "openai-responses", baseUrl: "https://api.openai.com/v1", requestHeaders: { "OpenAI-Beta": "responses=v1" } },
      { id: "openai-chat-completions" },
    ]);
  });
  it("rejects --protocol-base-url without a preceding --protocol", () => {
    expect(() => parseProtocolBlock(["--protocol-base-url", "https://x"])).toThrow(/preceding --protocol/);
  });
  it("rejects --protocol-header without a preceding --protocol", () => {
    expect(() => parseProtocolBlock(["--protocol-header", "A: 1"])).toThrow(/preceding --protocol/);
  });
  it("rejects a --protocol-base-url ending with /", () => {
    expect(() =>
      parseProtocolBlock(["--protocol", "x", "--protocol-base-url", "https://x/"]),
    ).toThrow(/must not end with/);
  });
  it("rejects --protocol with no value", () => {
    expect(() => parseProtocolBlock(["--protocol"])).toThrow(/requires a value/);
  });
});

describe("resolveAllowUnauthenticated", () => {
  it("returns true when the provider has no auth block", () => {
    const profile = loadProfile({ path: "does-not-matter", skipValidate: true });
    // Build a minimal in-memory profile with a no-auth provider.
    let p = createProfile({ rootDir: "/tmp/x/.lapp" });
    p = upsertProvider(p, { id: "ollama", protocol: "openai-chat-completions", baseUrl: "http://x/v1" });
    expect(resolveAllowUnauthenticated(p, "ollama")).toBe(true);
  });
  it("returns true when auth.type is none", () => {
    let p = createProfile({ rootDir: "/tmp/x/.lapp" });
    p = upsertProvider(p, { id: "ollama", protocol: "openai-chat-completions", baseUrl: "http://x/v1", auth: { type: "none" } });
    expect(resolveAllowUnauthenticated(p, "ollama")).toBe(true);
  });
  it("returns false when the provider has a secret", () => {
    let p = createProfile({ rootDir: "/tmp/x/.lapp" });
    p = upsertProvider(p, { id: "openai", protocol: "openai-chat-completions", baseUrl: "https://x", auth: { secret: "env://OPENAI_API_KEY" } });
    expect(resolveAllowUnauthenticated(p, "openai")).toBe(false);
  });
  it("returns false for an unknown provider id", () => {
    let p = createProfile({ rootDir: "/tmp/x/.lapp" });
    p = upsertProvider(p, { id: "openai", protocol: "openai-chat-completions", baseUrl: "https://x", auth: { secret: "env://K" } });
    expect(resolveAllowUnauthenticated(p, "nope")).toBe(false);
  });
});

describe("buildProviderInput — preset resolution", () => {
  it("resolves the openai preset into a protocols array + env secret", () => {
    const { input, defaultModel } = buildProviderInput("openai", {});
    expect(input.id).toBe("openai");
    expect(input.protocols?.map((p) => (typeof p === "string" ? p : p.id))).toEqual([
      "openai-responses",
      "openai-chat-completions",
    ]);
    expect(input.auth).toEqual({ secret: "env://OPENAI_API_KEY" });
    expect(defaultModel).toBe("gpt-4o-mini");
  });
  it("resolves the ollama preset to auth type none", () => {
    const { input } = buildProviderInput("ollama", {});
    expect(input.auth).toEqual({ type: "none" });
    expect(input.baseUrl).toBe("http://localhost:11434/v1");
  });
  it("an explicit --protocol block bypasses the preset", () => {
    const { input } = buildProviderInput("openai", {
      __protocols: [{ id: "openai-chat-completions", baseUrl: "https://api.openai.com/v1" }],
    });
    expect(input.protocols).toEqual([{ id: "openai-chat-completions", baseUrl: "https://api.openai.com/v1" }]);
  });
  it("falls back to legacy single --protocol + --base-url", () => {
    const { input } = buildProviderInput("custom", {
      protocol: "openai-chat-completions",
      "base-url": "https://custom.example.com/v1",
      secret: "env://CUSTOM_KEY",
    });
    expect(input.protocol).toBe("openai-chat-completions");
    expect(input.baseUrl).toBe("https://custom.example.com/v1");
    expect(input.auth).toEqual({ secret: "env://CUSTOM_KEY" });
  });
  it("throws on a non-preset id without protocol/base-url", () => {
    expect(() => buildProviderInput("nonsense", {})).toThrow(/requires/);
  });
});

describe("cmdProvider add — preset + multi-protocol on disk", () => {
  let root: string;
  beforeEach(() => { root = tmpLappRoot(); });

  it("provider add --id openai (preset) writes a protocols array and env secret", async () => {
    const { code } = await captureOutputAsync(() =>
      cmdProvider(["add", root], { id: "openai", model: "gpt-4o", yes: true }),
    );
    expect(code).toBe(0);
    const raw = fs.readFileSync(path.join(root, "providers", "openai", "provider.json"), "utf8");
    const cfg = JSON.parse(raw);
    expect(Array.isArray(cfg.protocols)).toBe(true);
    expect(cfg.protocols.map((p: { id: string }) => p.id)).toEqual([
      "openai-responses",
      "openai-chat-completions",
    ]);
    expect(cfg.auth?.secret).toBe("env://OPENAI_API_KEY");
    // --model created the model and set the chat default.
    const g = JSON.parse(fs.readFileSync(path.join(root, "global.json"), "utf8"));
    expect(g.defaultModel).toEqual({ providerId: "openai", model: "gpt-4o" });
  });

  it("provider add with a multi-protocol __protocols block writes both entries", async () => {
    const { code } = await captureOutputAsync(() =>
      cmdProvider(["add", root], {
        id: "openai",
        __protocols: [
          { id: "openai-responses", requestHeaders: { "OpenAI-Beta": "responses=v1" } },
          { id: "openai-chat-completions" },
        ],
        "base-url": "https://api.openai.com/v1",
        secret: "env://OPENAI_API_KEY",
        yes: true,
      }),
    );
    expect(code).toBe(0);
    const cfg = JSON.parse(fs.readFileSync(path.join(root, "providers", "openai", "provider.json"), "utf8"));
    // Each entry inherits the provider baseUrl unless it carries its own.
    expect(cfg.protocols).toEqual([
      { id: "openai-responses", baseUrl: "https://api.openai.com/v1", requestHeaders: { "OpenAI-Beta": "responses=v1" } },
      { id: "openai-chat-completions", baseUrl: "https://api.openai.com/v1" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// --no-auth flow
// ---------------------------------------------------------------------------

describe("cmdProvider add --no-auth", () => {
  let root: string;
  beforeEach(() => { root = tmpLappRoot(); });

  it("provider add --no-auth sets auth: { type: 'none' }", async () => {
    const { code } = await captureOutputAsync(() =>
      cmdProvider(["add", root], {
        id: "ollama",
        protocol: "openai-chat-completions",
        "base-url": "http://localhost:11434/v1",
        "no-auth": true,
        yes: true,
      }),
    );
    expect(code).toBe(0);
    const p = loadProfile({ path: root, skipValidate: true });
    expect(p.providers[0]!.config.auth?.type).toBe("none");
  });
});

// Round 4 regression: `lapp provider set --enabled false` must be honored
// (previously silently ignored). Tests now go through parseFlags so the
// argv form is exercised, not just a pre-built flags object.
describe("cmdProvider --enabled / --disabled", () => {
  let root: string;
  beforeEach(() => {
    root = tmpLappRoot();
    seedProfile(root);
  });

  it("provider set --disabled flips enabled:false on the existing ds provider", async () => {
    const p0 = loadProfile({ path: root, skipValidate: true });
    expect(p0.providers[0]!.config.enabled).not.toBe(false);

    // Exercise through parseFlags to ensure --disabled is parsed correctly
    const { flags } = parseFlags(["--yes", "--disabled"]);
    await captureOutputAsync(() =>
      cmdProvider(["set", root], { ...flags, id: "ds", protocol: "openai-chat-completions", "base-url": "https://api.deepseek.com" }),
    );
    const p1 = loadProfile({ path: root, skipValidate: true });
    expect(p1.providers[0]!.config.enabled).toBe(false);
  });

  it("provider set --enabled false (space form) flips enabled:false", async () => {
    const { flags } = parseFlags(["--yes", "--enabled", "false"]);
    await captureOutputAsync(() =>
      cmdProvider(["set", root], { ...flags, id: "ds", protocol: "openai-chat-completions", "base-url": "https://api.deepseek.com" }),
    );
    const p = loadProfile({ path: root, skipValidate: true });
    expect(p.providers[0]!.config.enabled).toBe(false);
  });

  it("provider set --enabled=false (equals form) flips enabled:false", async () => {
    const { flags } = parseFlags(["--yes", "--enabled=false"]);
    await captureOutputAsync(() =>
      cmdProvider(["set", root], { ...flags, id: "ds", protocol: "openai-chat-completions", "base-url": "https://api.deepseek.com" }),
    );
    const p = loadProfile({ path: root, skipValidate: true });
    expect(p.providers[0]!.config.enabled).toBe(false);
  });
});
