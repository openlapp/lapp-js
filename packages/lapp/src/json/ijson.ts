import { TextDecoder } from "node:util";

const UTF8 = new TextDecoder("utf-8", { fatal: true });

export type IJsonFindingCode =
  | "IJSON_INVALID_UTF8"
  | "INVALID_JSON"
  | "IJSON_DUPLICATE_KEY"
  | "IJSON_NONFINITE_NUMBER"
  | "IJSON_UNSAFE_INTEGER"
  | "IJSON_INVALID_UNICODE";

export interface IJsonFinding {
  code: IJsonFindingCode;
  /** RFC 6901 JSON Pointer, or the empty string for the document itself. */
  pointer: string;
  message: string;
}

export interface IJsonParseResult {
  ok: boolean;
  value?: unknown;
  findings: IJsonFinding[];
}

function escapePointerSegment(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

export function iJsonPointerJoin(pointer: string, segment: string | number): string {
  return `${pointer}/${escapePointerSegment(String(segment))}`;
}

/**
 * Find duplicate object members without letting `JSON.parse` silently keep only
 * the final value. Call this only after `JSON.parse` has proved the grammar.
 */
function duplicateMemberPointers(text: string): string[] {
  let index = 0;
  const duplicates: string[] = [];

  function whitespace(): void {
    while (index < text.length && /[\u0009\u000A\u000D\u0020]/.test(text[index]!)) index += 1;
  }

  function stringToken(): string {
    const start = index;
    index += 1;
    while (index < text.length) {
      if (text[index] === "\\") {
        index += 2;
        continue;
      }
      if (text[index] === "\"") {
        index += 1;
        return JSON.parse(text.slice(start, index)) as string;
      }
      index += 1;
    }
    throw new Error("unterminated JSON string after successful parse");
  }

  function value(pointer: string): void {
    whitespace();
    const token = text[index];
    if (token === "{") {
      object(pointer);
      return;
    }
    if (token === "[") {
      array(pointer);
      return;
    }
    if (token === "\"") {
      stringToken();
      return;
    }
    const match = text.slice(index).match(
      /^(?:-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?|true|false|null)/,
    );
    if (!match) throw new Error("invalid JSON token after successful parse");
    index += match[0].length;
  }

  function object(pointer: string): void {
    index += 1;
    whitespace();
    const seen = new Set<string>();
    if (text[index] === "}") {
      index += 1;
      return;
    }
    while (index < text.length) {
      whitespace();
      const key = stringToken();
      const memberPointer = iJsonPointerJoin(pointer, key);
      if (seen.has(key)) duplicates.push(memberPointer);
      seen.add(key);
      whitespace();
      index += 1; // Colon; JSON.parse already proved the grammar.
      value(memberPointer);
      whitespace();
      if (text[index] === "}") {
        index += 1;
        return;
      }
      index += 1; // Comma.
    }
  }

  function array(pointer: string): void {
    index += 1;
    whitespace();
    if (text[index] === "]") {
      index += 1;
      return;
    }
    let item = 0;
    while (index < text.length) {
      value(iJsonPointerJoin(pointer, item));
      item += 1;
      whitespace();
      if (text[index] === "]") {
        index += 1;
        return;
      }
      index += 1; // Comma.
    }
  }

  value("");
  return duplicates;
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

/** Inspect a JSON-shaped in-memory value for the I-JSON scalar restrictions. */
export function inspectIJsonValue(
  value: unknown,
  pointer = "",
  findings: IJsonFinding[] = [],
): IJsonFinding[] {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      findings.push({
        code: "IJSON_NONFINITE_NUMBER",
        pointer,
        message: "numbers must be finite IEEE 754 binary64 values",
      });
    } else if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      findings.push({
        code: "IJSON_UNSAFE_INTEGER",
        pointer,
        message: "integers must be between -9007199254740991 and 9007199254740991",
      });
    }
    return findings;
  }
  if (typeof value === "string") {
    if (hasUnpairedSurrogate(value)) {
      findings.push({
        code: "IJSON_INVALID_UNICODE",
        pointer,
        message: "strings must contain only Unicode scalar values",
      });
    }
    return findings;
  }
  if (!value || typeof value !== "object") return findings;
  if (Array.isArray(value)) {
    value.forEach((entry, item) => inspectIJsonValue(
      entry,
      iJsonPointerJoin(pointer, item),
      findings,
    ));
    return findings;
  }
  for (const [key, entry] of Object.entries(value)) {
    const memberPointer = iJsonPointerJoin(pointer, key);
    if (hasUnpairedSurrogate(key)) {
      findings.push({
        code: "IJSON_INVALID_UNICODE",
        pointer: memberPointer,
        message: "object member names must contain only Unicode scalar values",
      });
    }
    inspectIJsonValue(entry, memberPointer, findings);
  }
  return findings;
}

/** Parse strict UTF-8 I-JSON without silently discarding duplicate members. */
export function parseIJson(bytes: Uint8Array): IJsonParseResult {
  let text: string;
  try {
    text = UTF8.decode(bytes);
  } catch {
    return {
      ok: false,
      findings: [{
        code: "IJSON_INVALID_UTF8",
        pointer: "",
        message: "document must be valid UTF-8",
      }],
    };
  }

  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return {
      ok: false,
      findings: [{
        code: "INVALID_JSON",
        pointer: "",
        message: "document is not valid JSON",
      }],
    };
  }

  const findings: IJsonFinding[] = duplicateMemberPointers(text).map((pointer) => ({
    code: "IJSON_DUPLICATE_KEY",
    pointer,
    message: "object member names must be unique",
  }));
  inspectIJsonValue(value, "", findings);
  return { ok: findings.length === 0, value, findings };
}
