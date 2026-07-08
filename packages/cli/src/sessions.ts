/**
 * Session persistence for `lapp` CLI.
 *
 * Sessions live under `~/.lapp-cli/sessions/` — NOT `~/.lapp/`, which is the
 * protocol profile directory (spec-defined, multi-application). The CLI runtime
 * state is kept separate so admin tools can reuse the same session store later.
 *
 * Storage layout:
 *   ~/.lapp-cli/
 *     sessions/
 *       sessions.json         # index: { sessions: SessionMeta[] }
 *       <uuid>.jsonl          # one ChatMessage per line
 *
 * `LAPP_CLI_HOME` overrides `~/.lapp-cli`, mirroring `LAPP_HOME` for profiles.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import type { ChatMessage } from "@openlapp/lapp";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SessionMeta {
  id: string;
  name: string;
  provider?: string;
  model?: string;
  /** System prompt persisted on first --system call. */
  systemPrompt?: string;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
}

interface SessionsIndex {
  sessions: SessionMeta[];
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/** Resolve the CLI data home. `LAPP_CLI_HOME` > `~/.lapp-cli`. */
export function resolveLappCliHome(): string {
  if (process.env.LAPP_CLI_HOME) return path.resolve(process.env.LAPP_CLI_HOME);
  return path.join(os.homedir(), ".lapp-cli");
}

function sessionsDir(home: string): string {
  return path.join(home, "sessions");
}

function indexPath(home: string): string {
  return path.join(sessionsDir(home), "sessions.json");
}

function sessionFile(home: string, id: string): string {
  return path.join(sessionsDir(home), `${id}.jsonl`);
}

/** Ensure `~/.lapp-cli/sessions/` exists. Returns the sessions dir path. */
export function ensureSessionsDir(home: string): string {
  const dir = sessionsDir(home);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ---------------------------------------------------------------------------
// Index read/write
// ---------------------------------------------------------------------------

function readIndex(home: string): SessionsIndex {
  const p = indexPath(home);
  try {
    const raw = fs.readFileSync(p, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && Array.isArray((parsed as SessionsIndex).sessions)) {
      return parsed as SessionsIndex;
    }
    // Valid JSON but wrong shape — treat as empty rather than corrupt.
  } catch {
    // Corrupt JSON — rename the file so it isn't silently overwritten.
    try { fs.renameSync(p, p + ".corrupt"); } catch { /* best-effort */ }
  }
  return { sessions: [] };
}

function writeIndex(home: string, index: SessionsIndex): void {
  ensureSessionsDir(home);
  const p = indexPath(home);
  const tmp = p + ".tmp";
  // Atomic write: temp file + rename so a crash mid-write cannot leave a
  // partially-written sessions.json.
  fs.writeFileSync(tmp, JSON.stringify(index), "utf8");
  fs.renameSync(tmp, p);
}

// ---------------------------------------------------------------------------
// Session CRUD
// ---------------------------------------------------------------------------

/** Load all messages from a session JSONL file.
 *  Each line is parsed independently so one corrupt line doesn't drop the
 *  entire history (e.g. a crash mid-write that left a truncated tail). */
export function loadSession(home: string, id: string): ChatMessage[] {
  const file = sessionFile(home, id);
  try {
    const raw = fs.readFileSync(file, "utf8");
    const messages: ChatMessage[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "") continue;
      try {
        messages.push(JSON.parse(trimmed) as ChatMessage);
      } catch {
        // Skip one corrupt line; keep everything before it.
      }
    }
    return messages;
  } catch {
    return [];
  }
}

/** Append a raw line to the session JSONL without touching the index.
 *  Useful for persisting intermediate tool-call/tool-result messages
 *  that belong to the same turn and shouldn't inflate messageCount. */
export function appendToSessionFile(home: string, id: string, message: ChatMessage): void {
  ensureSessionsDir(home);
  fs.appendFileSync(sessionFile(home, id), JSON.stringify(message) + "\n", "utf8");
}

/** Append a message to the session JSONL and update the index. */
export function saveSession(
  home: string,
  id: string,
  message: ChatMessage,
  meta?: { name?: string; provider?: string; model?: string; systemPrompt?: string },
): SessionMeta {
  ensureSessionsDir(home);

  // Append one line to the JSONL
  fs.appendFileSync(sessionFile(home, id), JSON.stringify(message) + "\n", "utf8");

  // Update index
  const index = readIndex(home);
  const existingIndex = index.sessions.findIndex((s) => s.id === id);
  const existing = existingIndex === -1 ? undefined : index.sessions[existingIndex];
  const now = new Date().toISOString();
  const messageCount = (existing?.messageCount ?? 0) + 1;

  const entry: SessionMeta = {
    id,
    name: meta?.name ?? existing?.name ?? id,
    provider: meta?.provider ?? existing?.provider,
    model: meta?.model ?? existing?.model,
    systemPrompt: meta?.systemPrompt ?? existing?.systemPrompt,
    messageCount,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  if (existingIndex !== -1) {
    index.sessions.splice(existingIndex, 1);
  }
  index.sessions.push(entry);

  writeIndex(home, index);
  return entry;
}

/** List all sessions, newest first. */
export function listSessions(home: string): SessionMeta[] {
  return readIndex(home).sessions
    .map((session, index) => ({ session, index }))
    .sort((a, b) => (
      new Date(b.session.updatedAt).getTime() - new Date(a.session.updatedAt).getTime()
      || b.index - a.index
    ))
    .map(({ session }) => session);
}

/** Delete a session (JSONL + index entry). No-op if the session doesn't exist. */
export function deleteSession(home: string, id: string): void {
  const index = readIndex(home);
  const idx = index.sessions.findIndex((s) => s.id === id);
  if (idx === -1) return;

  index.sessions.splice(idx, 1);
  writeIndex(home, index);

  try {
    fs.unlinkSync(sessionFile(home, id));
  } catch (err: unknown) {
    // ENOENT: file already gone — fine. Any other error (EACCES, EBUSY, etc.)
    // means the file still exists but the index entry is already removed, which
    // leaves an orphan. Surface it so the caller knows.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }
}

/** Get the most recently active session. */
export function getLatestSession(home: string): SessionMeta | null {
  const sessions = listSessions(home);
  return sessions[0] ?? null;
}

/** Generate a unique session id from a name + random suffix. */
export function generateSessionId(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  const suffix = crypto.randomBytes(4).toString("hex");
  return `${slug}-${suffix}`;
}
