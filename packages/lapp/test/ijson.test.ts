import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createProfile,
  inspectProfile,
  inspectWriterLock,
  planChanges,
  upsertModel,
  upsertProvider,
  validateProfile,
  validateWriterLockOwner,
  writeProfileAtomic,
  writerLockPaths,
  type Diagnostic,
  type LappProfile,
} from "../src/index.js";
import { parseIJson } from "../src/json/ijson.js";

const roots: string[] = [];

function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lapp-ijson-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const validProvider = JSON.stringify({
  schemaVersion: "1.0",
  id: "demo",
  baseUrl: "https://api.example.com",
  protocols: ["openai-chat-completions"],
  auth: { type: "none" },
});

const validModels = JSON.stringify({
  schemaVersion: "1.0",
  models: [{ id: "demo" }],
});

function inspectFiles(
  provider: string | Uint8Array = validProvider,
  models: string | Uint8Array = validModels,
): Diagnostic[] {
  const root = temporaryRoot();
  const providerDirectory = path.join(root, "providers", "demo");
  fs.mkdirSync(providerDirectory, { recursive: true });
  fs.writeFileSync(path.join(providerDirectory, "provider.json"), provider);
  fs.writeFileSync(path.join(providerDirectory, "models.json"), models);
  return inspectProfile({ path: root }).diagnostics;
}

describe("strict I-JSON parser", () => {
  it.each([
    {
      name: "invalid UTF-8",
      bytes: Uint8Array.of(0xc3, 0x28),
      code: "IJSON_INVALID_UTF8",
      pointer: "",
    },
    {
      name: "invalid JSON token",
      bytes: Buffer.from('{"value":NaN}'),
      code: "INVALID_JSON",
      pointer: "",
    },
    {
      name: "escaped duplicate key",
      bytes: Buffer.from('{"a/b":1,"\\u0061/b":2}'),
      code: "IJSON_DUPLICATE_KEY",
      pointer: "/a~1b",
    },
    {
      name: "lone surrogate",
      bytes: Buffer.from('{"value":"\\ud800"}'),
      code: "IJSON_INVALID_UNICODE",
      pointer: "/value",
    },
    {
      name: "unsafe integer",
      bytes: Buffer.from('{"value":9007199254740992}'),
      code: "IJSON_UNSAFE_INTEGER",
      pointer: "/value",
    },
    {
      name: "overflowing finite syntax",
      bytes: Buffer.from('{"value":1e400}'),
      code: "IJSON_NONFINITE_NUMBER",
      pointer: "/value",
    },
  ])("reports canonical code and pointer for $name", ({ bytes, code, pointer }) => {
    const parsed = parseIJson(bytes);
    expect(parsed.ok).toBe(false);
    expect(parsed.findings).toContainEqual(expect.objectContaining({ code, pointer }));
  });

  it("accepts Unicode scalar pairs and the safe-integer boundaries", () => {
    const parsed = parseIJson(Buffer.from(
      '{"minimum":-9007199254740991,"maximum":9007199254740991,"scalar":"\\ud83d\\ude00"}',
    ));
    expect(parsed).toMatchObject({ ok: true, findings: [] });
  });
});

describe("profile I-JSON diagnostics", () => {
  it.each([
    {
      name: "duplicate provider member",
      provider: '{"schemaVersion":"1.0","id":"demo","\\u0069d":"demo","baseUrl":"https://api.example.com","protocols":["openai-chat-completions"],"auth":{"type":"none"}}',
      code: "IJSON_DUPLICATE_KEY",
      location: "providers/demo/provider.json#/id",
    },
    {
      name: "invalid Unicode",
      provider: '{"schemaVersion":"1.0","id":"demo","name":"\\ud800","baseUrl":"https://api.example.com","protocols":["openai-chat-completions"],"auth":{"type":"none"}}',
      code: "IJSON_INVALID_UNICODE",
      location: "providers/demo/provider.json#/name",
    },
    {
      name: "unsafe extension integer",
      provider: '{"schemaVersion":"1.0","id":"demo","baseUrl":"https://api.example.com","protocols":["openai-chat-completions"],"auth":{"type":"none"},"extensions":{"example.invalid/unsafe":9007199254740992}}',
      code: "IJSON_UNSAFE_INTEGER",
      location: "providers/demo/provider.json#/extensions/example.invalid~1unsafe",
    },
    {
      name: "non-finite number",
      provider: '{"schemaVersion":"1.0","id":"demo","baseUrl":"https://api.example.com","protocols":["openai-chat-completions"],"auth":{"type":"none"},"extensions":{"example.invalid/overflow":1e400}}',
      code: "IJSON_NONFINITE_NUMBER",
      location: "providers/demo/provider.json#/extensions/example.invalid~1overflow",
    },
    {
      name: "invalid UTF-8",
      provider: Uint8Array.of(0xc3, 0x28),
      code: "IJSON_INVALID_UTF8",
      location: "providers/demo/provider.json",
    },
  ])("loads $name with canonical diagnostic identity", ({ provider, code, location }) => {
    expect(inspectFiles(provider)).toContainEqual(expect.objectContaining({
      level: "ERROR",
      code,
      location,
    }));
  });

  it("locates unsafe model integers in the models document", () => {
    const diagnostics = inspectFiles(validProvider,
      '{"schemaVersion":"1.0","models":[{"id":"demo","contextWindow":9007199254740992}]}');
    expect(diagnostics).toContainEqual(expect.objectContaining({
      level: "ERROR",
      code: "IJSON_UNSAFE_INTEGER",
      location: "providers/demo/models.json#/models/0/contextWindow",
    }));
  });

  it("uses a generic invalid-JSON message that cannot echo nearby secrets", () => {
    const secret = "sk-sensitive-never-report";
    const diagnostics = inspectFiles(`{"schemaVersion":"1.0","secret":"${secret}",`);
    const serialized = JSON.stringify(diagnostics);
    expect(serialized).toContain("INVALID_JSON");
    expect(serialized).not.toContain(secret);
  });

  it("applies the same scalar rules to in-memory profiles", () => {
    const profile: LappProfile = {
      providers: [{
        config: {
          schemaVersion: "1.0",
          id: "demo",
          name: "\ud800",
          baseUrl: "https://api.example.com",
          protocols: ["openai-chat-completions"],
          auth: { type: "none" },
          extensions: { "example.invalid/overflow": Number.POSITIVE_INFINITY },
        },
        models: {
          schemaVersion: "1.0",
          models: [{ id: "demo", contextWindow: 9_007_199_254_740_992 }],
        },
      }],
    };
    expect(validateProfile(profile).diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "IJSON_INVALID_UNICODE",
        location: "providers/demo/provider.json#/name",
      }),
      expect.objectContaining({
        code: "IJSON_NONFINITE_NUMBER",
        location: "providers/demo/provider.json#/extensions/example.invalid~1overflow",
      }),
      expect.objectContaining({
        code: "IJSON_UNSAFE_INTEGER",
        location: "providers/demo/models.json#/models/0/contextWindow",
      }),
    ]));
  });

  it("plans and rewrites an on-disk duplicate instead of treating its final value as canonical", async () => {
    const root = temporaryRoot();
    let profile = createProfile({ rootDir: root });
    profile = upsertProvider(profile, {
      id: "demo",
      baseUrl: "https://api.example.com",
      protocols: ["openai-chat-completions"],
      auth: { type: "none" },
    });
    profile = upsertModel(profile, { providerId: "demo", id: "demo" });
    await writeProfileAtomic(profile);

    const providerFile = path.join(root, "providers", "demo", "provider.json");
    const duplicate = fs.readFileSync(providerFile, "utf8")
      .replace('"id": "demo",', '"id": "demo",\n  "\\u0069d": "demo",');
    fs.writeFileSync(providerFile, duplicate);
    expect(planChanges(profile, profile).changes).toContainEqual({
      kind: "modify",
      path: providerFile,
    });

    await writeProfileAtomic(profile);
    expect(inspectProfile({ path: root }).diagnostics)
      .not.toContainEqual(expect.objectContaining({ code: "IJSON_DUPLICATE_KEY" }));
    expect((fs.readFileSync(providerFile, "utf8").match(/"(?:id|\\u0069d)"/g) ?? []))
      .toHaveLength(1);
  });
});

describe("writer-lock owner I-JSON", () => {
  it("rejects a duplicate owner member that JSON.parse would silently accept", () => {
    const stateHome = temporaryRoot();
    const { lockDirectory, ownerFile } = writerLockPaths({ stateHome });
    fs.mkdirSync(lockDirectory, { recursive: true });
    const token = "123e4567-e89b-12d3-a456-426614174000";
    fs.writeFileSync(ownerFile,
      `{"version":1,"token":"${token}","token":"${token}","pid":1,"createdAt":"2026-07-17T00:00:00Z"}`);

    expect(inspectWriterLock({ stateHome })).toMatchObject({
      locked: true,
      ownerValid: false,
    });
  });

  it("accepts only a strict UTF-8 I-JSON owner document", () => {
    const stateHome = temporaryRoot();
    const { lockDirectory, ownerFile } = writerLockPaths({ stateHome });
    fs.mkdirSync(lockDirectory, { recursive: true });
    const owner = {
      version: 1,
      token: "123e4567-e89b-12d3-a456-426614174000",
      pid: 9_007_199_254_740_991,
      createdAt: "2026-07-17T09:30:00.123Z",
    };
    fs.writeFileSync(ownerFile, JSON.stringify(owner));
    expect(inspectWriterLock({ stateHome })).toMatchObject({ ownerValid: true, owner });

    const invalidCases: Array<{ name: string; bytes: string | Uint8Array }> = [
      {
        name: "unsafe pid",
        bytes: '{"version":1,"token":"123e4567-e89b-12d3-a456-426614174000","pid":9007199254740992,"createdAt":"2026-07-17T09:30:00.123Z"}',
      },
      {
        name: "uppercase token",
        bytes: '{"version":1,"token":"123E4567-E89B-12D3-A456-426614174000","pid":1234,"createdAt":"2026-07-17T09:30:00.123Z"}',
      },
      {
        name: "non-UTC timestamp",
        bytes: '{"version":1,"token":"123e4567-e89b-12d3-a456-426614174000","pid":1234,"createdAt":"2026-07-17T17:30:00+08:00"}',
      },
      {
        name: "invalid Gregorian date",
        bytes: '{"version":1,"token":"123e4567-e89b-12d3-a456-426614174000","pid":1234,"createdAt":"2026-02-31T09:30:00Z"}',
      },
      {
        name: "heartbeat field",
        bytes: '{"version":1,"token":"123e4567-e89b-12d3-a456-426614174000","pid":1234,"createdAt":"2026-07-17T09:30:00.123Z","heartbeatAt":"2026-07-17T09:30:01.123Z"}',
      },
      {
        name: "duplicate version",
        bytes: '{"version":1,"version":1,"token":"123e4567-e89b-12d3-a456-426614174000","pid":1234,"createdAt":"2026-07-17T09:30:00Z"}',
      },
      {
        name: "invalid Unicode",
        bytes: '{"version":1,"token":"\\ud800","pid":1234,"createdAt":"2026-07-17T09:30:00Z"}',
      },
      {
        name: "invalid UTF-8",
        bytes: Buffer.from("eyJ2ZXJzaW9uIjoxLP99", "base64"),
      },
    ];
    for (const fixture of invalidCases) {
      fs.writeFileSync(ownerFile, fixture.bytes);
      expect(inspectWriterLock({ stateHome }).ownerValid, fixture.name).toBe(false);
    }
  });

  it("executes every canonical writer-lock owner identity fixture", () => {
    const fixtures = JSON.parse(fs.readFileSync(
      new URL("../conformance/writer-lock-v1.json", import.meta.url),
      "utf8",
    )) as {
      cases: Array<{
        name: string;
        utf8?: string;
        base64?: string;
        expected: string;
      }>;
    };

    for (const fixture of fixtures.cases) {
      const bytes = fixture.utf8 !== undefined
        ? Buffer.from(fixture.utf8, "utf8")
        : Buffer.from(fixture.base64!, "base64");
      const result = validateWriterLockOwner(bytes);
      const actual = result.ok ? "OK" : result.code;
      expect(actual, fixture.name).toBe(fixture.expected);
    }
  });
});
