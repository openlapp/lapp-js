import { describe, it, expect } from "vitest";
import { exportEnv, collectExportEntries, deriveEnvName } from "../src/index.js";
import { loadProfile, createProfile, upsertProvider } from "../src/index.js";
import { lappRoot } from "../../../scripts/lapp-paths.mjs";
import path from "node:path";

const fullExample = path.join(lappRoot, "examples/en/full/.lapp");

describe("deriveEnvName", () => {
  it("uppercases and sanitizes", () => {
    expect(deriveEnvName("deepseek")).toBe("DEEPSEEK_API_KEY");
    expect(deriveEnvName("moonshot-kimi")).toBe("MOONSHOT_KIMI_API_KEY");
  });
});

describe("exportEnv defaults (no resolve)", () => {
  const profile = loadProfile({ path: fullExample });

  it("bash: emits redacted comments for env://", () => {
    const out = exportEnv(profile, { format: "bash" });
    expect(out).toContain("# DEEPSEEK_API_KEY:");
    expect(out).not.toContain("DEEPSEEK_API_KEY=sk-");
    expect(out).not.toMatch(/export DEEPSEEK_API_KEY=/);
  });

  it("fish format", () => {
    const out = exportEnv(profile, { format: "fish" });
    expect(out).toContain("# DEEPSEEK_API_KEY:");
  });

  it("powershell format", () => {
    const out = exportEnv(profile, { format: "powershell" });
    expect(out).toContain("# DEEPSEEK_API_KEY:");
  });

  it("cmd format", () => {
    const out = exportEnv(profile, { format: "cmd" });
    expect(out).toContain("REM DEEPSEEK_API_KEY:");
  });
});

describe("fix coverage for review findings", () => {
  it("disabled providers are skipped from env export even with --resolve", () => {
    let p = createProfile({ rootDir: "/tmp/.lapp" });
    p = upsertProvider(p, {
      id: "live",
      protocol: "openai-chat-completions",
      baseUrl: "https://api.example.com",
      auth: { secret: "env://LIVE_KEY" },
    });
    p = upsertProvider(p, {
      id: "stale",
      protocol: "openai-chat-completions",
      baseUrl: "https://api.example.com",
      enabled: false,
      auth: { secret: "env://STALE_KEY" },
    });
    const out = exportEnv(p, { format: "bash", resolve: true, env: { LIVE_KEY: "live-val", STALE_KEY: "stale-val" } });
    expect(out).toContain("export LIVE_KEY='live-val'");
    expect(out).not.toContain("STALE_KEY");
    expect(out).not.toContain("stale-val");
  });

  it("fish: single quotes inside value are escaped via '\\'' and the value round-trips", () => {
    let p = createProfile({ rootDir: "/tmp/.lapp" });
    p = upsertProvider(p, {
      id: "q",
      protocol: "openai-chat-completions",
      baseUrl: "https://x",
      auth: { secret: "env://Q" },
    });
    const out = exportEnv(p, { format: "fish", resolve: true, env: { Q: "it's a key" } });
    // The correct fish encoding is the POSIX close/escape/reopen pattern.
    expect(out).toContain(`set -gx Q 'it'\\''s a key'`);
  });

  it("fish: backslashes in value are not doubled (fish single quotes are literal)", () => {
    let p = createProfile({ rootDir: "/tmp/.lapp" });
    p = upsertProvider(p, {
      id: "b",
      protocol: "openai-chat-completions",
      baseUrl: "https://x",
      auth: { secret: "env://B" },
    });
    const out = exportEnv(p, { format: "fish", resolve: true, env: { B: "a\\b" } });
    expect(out).toContain(`set -gx B 'a\\b'`);
    expect(out).not.toContain(`'a\\\\b'`);
  });
});

describe("exportEnv with --resolve", () => {
  it("emits real value when env var present", () => {
    const profile = loadProfile({ path: fullExample });
    const out = exportEnv(profile, { format: "bash", resolve: true, env: { DEEPSEEK_API_KEY: "sk-real", MINIMAX_API_KEY: "sk-mm" } });
    expect(out).toContain("export DEEPSEEK_API_KEY='sk-real'");
  });

  it("reports missing env var", () => {
    const profile = loadProfile({ path: fullExample });
    const out = exportEnv(profile, { format: "bash", resolve: true, env: {} });
    expect(out).toMatch(/# DEEPSEEK_API_KEY: missing env var/);
  });
});

describe("exportEnv plaintext policy", () => {
  it("never emits plaintext without allow-plaintext", () => {
    let p = createProfile({ rootDir: "/tmp/.lapp" });
    p = upsertProvider(p, { id: "x", protocol: "openai-chat-completions", baseUrl: "https://x", auth: { secret: "sk-plain" } });
    const out = exportEnv(p, { format: "bash", resolve: true });
    expect(out).toContain("plaintext secret omitted");
    expect(out).not.toContain("sk-plain");
  });

  it("emits plaintext with allow-plaintext", () => {
    let p = createProfile({ rootDir: "/tmp/.lapp" });
    p = upsertProvider(p, { id: "x", protocol: "openai-chat-completions", baseUrl: "https://x", auth: { secret: "sk-plain" } });
    const out = exportEnv(p, { format: "bash", resolve: true, allowPlaintext: true });
    expect(out).toContain("export X_API_KEY='sk-plain'");
  });
});

describe("collectExportEntries keychain/file unsupported", () => {
  it("reports unsupported for keychain://", () => {
    let p = createProfile({ rootDir: "/tmp/.lapp" });
    p = upsertProvider(p, { id: "x", protocol: "openai-chat-completions", baseUrl: "https://x", auth: { secret: "keychain://ns/item" } });
    const entries = collectExportEntries(p, { format: "bash", resolve: true });
    expect(entries[0]!.value).toBeNull();
    expect(entries[0]!.reason).toContain("unsupported");
  });
});

describe("exportEnv shell-quoting security", () => {
  it("bash uses single quotes — no $ or backtick interpolation", () => {
    let p = createProfile({ rootDir: "/tmp/.lapp" });
    p = upsertProvider(p, { id: "x", protocol: "openai-chat-completions", baseUrl: "https://x", auth: { secret: "sk-x" } });
    const out = exportEnv(p, { format: "bash", resolve: true, allowPlaintext: true });
    expect(out).toContain("export X_API_KEY='sk-x'");
    // Sanity: no unquoted $ or ` in the value position.
    expect(out).not.toMatch(/=\$[A-Za-z]/);
  });

  it("bash escapes embedded single quotes via '\\''", () => {
    let p = createProfile({ rootDir: "/tmp/.lapp" });
    p = upsertProvider(p, { id: "x", protocol: "openai-chat-completions", baseUrl: "https://x", auth: { secret: "it's-a-key" } });
    const out = exportEnv(p, { format: "bash", resolve: true, allowPlaintext: true });
    expect(out).toContain("export X_API_KEY='it'\\''s-a-key'");
  });

  it("powershell uses single quotes — no $ interpolation", () => {
    let p = createProfile({ rootDir: "/tmp/.lapp" });
    p = upsertProvider(p, { id: "x", protocol: "openai-chat-completions", baseUrl: "https://x", auth: { secret: "sk-$env:FOO" } });
    const out = exportEnv(p, { format: "powershell", resolve: true, allowPlaintext: true });
    expect(out).toContain("$env:X_API_KEY = 'sk-$env:FOO'");
  });

  it("cmd quotes the value to keep spaces and metacharacters safe", () => {
    let p = createProfile({ rootDir: "/tmp/.lapp" });
    p = upsertProvider(p, { id: "x", protocol: "openai-chat-completions", baseUrl: "https://x", auth: { secret: "sk-a&echo hi" } });
    const out = exportEnv(p, { format: "cmd", resolve: true, allowPlaintext: true });
    expect(out).toContain('set X_API_KEY="sk-a&echo hi"');
  });

  // Regression: a newline in an env:// ref name must not inject a second
  // command line into the shell comment. The unresolved-branch reason text
  // is embedded in `# ...` / `REM ...`; a raw LF would split the comment and
  // the next line would execute when the output is sourced.
  it("newline in env:// ref name is neutralized in the diagnostic comment", () => {
    let p = createProfile({ rootDir: "/tmp/.lapp" });
    p = upsertProvider(p, {
      id: "x",
      protocol: "openai-chat-completions",
      baseUrl: "https://x",
      auth: { secret: "env://foo\nrm -rf ~" },
    });
    const bash = exportEnv(p, { format: "bash", resolve: true, env: {} });
    // The malicious second line must not appear verbatim in the output.
    expect(bash).not.toMatch(/^rm -rf ~$/m);
    // The comment line stays a single line (LF replaced with '?').
    expect(bash).toMatch(/# .*missing env var/);
    const cmd = exportEnv(p, { format: "cmd", resolve: true, env: {} });
    expect(cmd).not.toMatch(/^rm -rf ~$/m);
  });

  // Plaintext with resolve:true but without allowPlaintext → specific reason
  it("plaintext with resolve but without allowPlaintext gives correct reason", () => {
    let p = createProfile({ rootDir: "/tmp/.lapp" });
    p = upsertProvider(p, { id: "pt", protocol: "openai-chat-completions", baseUrl: "https://x", auth: { secret: "sk-my-key" } });
    const out = exportEnv(p, { format: "bash", resolve: true });
    expect(out).toContain("plaintext secret omitted (use --allow-plaintext to emit)");
    expect(out).not.toContain("sk-my-key");
  });

  // Env name collision: two providers' deriveEnvName produce the same name
  it("env name collision between providers emits a collision warning", () => {
    let p = createProfile({ rootDir: "/tmp/.lapp" });
    // Two providers whose ids derive the same env name, with plaintext secrets
    // so values are non-null (collision gate only fires when value !== null)
    p = upsertProvider(p, { id: "test", protocol: "openai-chat-completions", baseUrl: "https://a", auth: { secret: "sk-a" } });
    p = upsertProvider(p, { id: "Test", protocol: "openai-chat-completions", baseUrl: "https://b", auth: { secret: "sk-b" } });
    const entries = collectExportEntries(p, { format: "bash", resolve: true, allowPlaintext: true });
    // Both derive to TEST_API_KEY; second must have collision reason
    const collisions = entries.filter((e) => e.reason?.includes("collision"));
    expect(collisions.length).toBeGreaterThan(0);
  });

  // Plaintext without --resolve gives the "requires --resolve" reason
  it("plaintext without --resolve gives correct reason message", () => {
    let p = createProfile({ rootDir: "/tmp/.lapp" });
    p = upsertProvider(p, { id: "pt", protocol: "openai-chat-completions", baseUrl: "https://x", auth: { secret: "sk-my-key" } });
    const entries = collectExportEntries(p, { format: "bash" });
    expect(entries.some((e) => e.reason?.includes("--resolve and --allow-plaintext"))).toBe(true);
  });

  // env:// with no name (empty reference) produces missing env var diagnostic
  it("env:// with no name reports missing env var name", () => {
    let p = createProfile({ rootDir: "/tmp/.lapp" });
    p = upsertProvider(p, { id: "x", protocol: "openai-chat-completions", baseUrl: "https://x", auth: { secret: "env://" } });
    const entries = collectExportEntries(p, { format: "bash" });
    expect(entries.some((e) => e.reason?.includes("missing the env var name"))).toBe(true);
  });
});