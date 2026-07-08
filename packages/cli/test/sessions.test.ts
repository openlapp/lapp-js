/**
 * Unit tests for session persistence (packages/cli/src/sessions.ts).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  resolveLappCliHome,
  ensureSessionsDir,
  loadSession,
  saveSession,
  appendToSessionFile,
  listSessions,
  deleteSession,
  getLatestSession,
  generateSessionId,
  type SessionMeta,
} from "../src/sessions.js";

function tmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "lapp-cli-sessions-"));
}

describe("resolveLappCliHome", () => {
  it("returns ~/.lapp-cli by default", () => {
    const home = resolveLappCliHome();
    expect(home).toContain(".lapp-cli");
  });

  it("respects LAPP_CLI_HOME", () => {
    const prev = process.env.LAPP_CLI_HOME;
    process.env.LAPP_CLI_HOME = "/custom/lapp-cli";
    try {
      expect(resolveLappCliHome()).toBe(path.resolve("/custom/lapp-cli"));
    } finally {
      if (prev === undefined) delete process.env.LAPP_CLI_HOME;
      else process.env.LAPP_CLI_HOME = prev;
    }
  });
});

describe("session CRUD", () => {
  let home: string;

  beforeEach(() => {
    home = tmpHome();
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("ensureSessionsDir creates the directory", () => {
    const dir = ensureSessionsDir(home);
    expect(fs.existsSync(dir)).toBe(true);
    expect(dir.endsWith("sessions")).toBe(true);
  });

  it("saveSession creates a JSONL file and updates the index", () => {
    const id = generateSessionId("test");
    const meta = saveSession(home, id, { role: "user", content: "hello" }, { name: "test", provider: "openai", model: "gpt-4o" });

    expect(meta.name).toBe("test");
    expect(meta.provider).toBe("openai");
    expect(meta.model).toBe("gpt-4o");
    expect(meta.messageCount).toBe(1);

    // Verify JSONL content
    const messages = loadSession(home, id);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual({ role: "user", content: "hello" });

    // Verify index
    const sessions = listSessions(home);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.id).toBe(id);
    expect(sessions[0]!.name).toBe("test");
  });

  it("saveSession appends to existing session", () => {
    const id = generateSessionId("chat");
    saveSession(home, id, { role: "user", content: "first" }, { name: "chat" });
    saveSession(home, id, { role: "assistant", content: "second" });

    const messages = loadSession(home, id);
    expect(messages).toHaveLength(2);
    expect(messages[0]!.content).toBe("first");
    expect(messages[1]!.content).toBe("second");

    const sessions = listSessions(home);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.messageCount).toBe(2);
  });

  it("saveSession preserves existing meta when not supplied", () => {
    const id = generateSessionId("chat");
    saveSession(home, id, { role: "user", content: "hi" }, { name: "chat", provider: "openai", model: "gpt-4o" });

    // Append without providing meta — should keep previous values
    saveSession(home, id, { role: "assistant", content: "hello" });

    const sessions = listSessions(home);
    expect(sessions[0]!.name).toBe("chat");
    expect(sessions[0]!.provider).toBe("openai");
    expect(sessions[0]!.model).toBe("gpt-4o");
  });

  it("saveSession persists systemPrompt in meta", () => {
    const id = generateSessionId("sys");
    saveSession(home, id, { role: "user", content: "hi" }, { name: "sys", systemPrompt: "You are a pirate." });

    const sessions = listSessions(home);
    expect(sessions[0]!.systemPrompt).toBe("You are a pirate.");
  });

  it("loadSession returns empty array for non-existent session", () => {
    expect(loadSession(home, "nonexistent")).toEqual([]);
  });

  it("listSessions sorts newest first", () => {
    const a = generateSessionId("a");
    const b = generateSessionId("b");
    saveSession(home, a, { role: "user", content: "a" }, { name: "a" });
    // Small delay so timestamps differ
    saveSession(home, b, { role: "user", content: "b" }, { name: "b" });

    const sessions = listSessions(home);
    expect(sessions).toHaveLength(2);
    expect(sessions[0]!.name).toBe("b"); // newest first
    expect(sessions[1]!.name).toBe("a");
  });

  it("deleteSession removes JSONL and index entry", () => {
    const id = generateSessionId("del");
    saveSession(home, id, { role: "user", content: "x" }, { name: "del" });

    deleteSession(home, id);

    expect(listSessions(home)).toHaveLength(0);
    expect(fs.existsSync(path.join(home, "sessions", `${id}.jsonl`))).toBe(false);
  });

  it("deleteSession is a no-op for non-existent session", () => {
    expect(() => deleteSession(home, "nope")).not.toThrow();
  });

  it("getLatestSession returns the most recently active session", () => {
    const a = generateSessionId("old");
    const b = generateSessionId("new");
    saveSession(home, a, { role: "user", content: "old" }, { name: "old" });
    saveSession(home, b, { role: "user", content: "new" }, { name: "new" });

    const latest = getLatestSession(home);
    expect(latest?.name).toBe("new");
  });

  it("getLatestSession returns null when no sessions exist", () => {
    expect(getLatestSession(home)).toBeNull();
  });

  it("generateSessionId is unique and named", () => {
    const id1 = generateSessionId("my chat");
    const id2 = generateSessionId("my chat");
    expect(id1).not.toBe(id2);
    expect(id1).toMatch(/^my-chat-[0-9a-f]{8}$/);
  });
});

describe("index corruption recovery", () => {
  let home: string;

  beforeEach(() => {
    home = tmpHome();
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("recovers from corrupt sessions.json and renames the corrupt file", () => {
    ensureSessionsDir(home);
    const indexPath = path.join(home, "sessions", "sessions.json");
    fs.writeFileSync(indexPath, "not json", "utf8");

    // Should not throw — starts fresh
    const id = generateSessionId("ok");
    saveSession(home, id, { role: "user", content: "ok" }, { name: "ok" });

    expect(listSessions(home)).toHaveLength(1);
    // The corrupt file should have been renamed, not silently overwritten
    expect(fs.existsSync(indexPath + ".corrupt")).toBe(true);
  });

  it("recovers from missing sessions directory", () => {
    const id = generateSessionId("fresh");
    saveSession(home, id, { role: "user", content: "fresh" }, { name: "fresh" });
    expect(loadSession(home, id)).toHaveLength(1);
  });

  it("appendToSessionFile writes a line without updating the index", () => {
    const id = generateSessionId("batch");
    saveSession(home, id, { role: "user", content: "hello" }, { name: "batch" });

    // Append an intermediate tool message without bumping count
    appendToSessionFile(home, id, { role: "tool", content: "result" });

    const messages = loadSession(home, id);
    expect(messages).toHaveLength(2);
    expect(messages[1]!.role).toBe("tool");

    // The index messageCount should still be 1 (not 2)
    const sessions = listSessions(home);
    expect(sessions[0]!.messageCount).toBe(1);
  });
});
