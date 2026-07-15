/**
 * Shared redaction for untrusted provider text (error bodies, echoed headers).
 *
 * This is a defense-in-depth layer alongside the SDK's scheme-aware
 * `redactSecret`: the text we receive from providers can contain credential
 * shapes the SDK never resolves, so we scrub common patterns from every
 * string leaf before it reaches Error.message, `err.raw`, or the CLI's
 * stdout/stderr.
 *
 * A single canonical copy lives here so adding a new secret pattern (e.g. an
 * AWS key or Slack token) covers the client, the sync layer, and the CLI in
 * one edit. The CLI keeps its own copy in `cli/src/output.ts` for the case
 * where the SDK is not importable (e.g. before `pnpm build`); that copy is
 * intentionally mirrored and updated in lockstep.
 */

export const SECRET_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{8,}\b/g,        // OpenAI / DeepSeek / Anthropic
  /\bsk-ant-[A-Za-z0-9_-]{8,}\b/g,    // explicit ant
  /\bsk-or-[A-Za-z0-9_-]{8,}\b/g,     // OpenRouter
  /\bgho_[A-Za-z0-9]{8,}\b/g,         // GitHub OAuth
  /\bghp_[A-Za-z0-9]{8,}\b/g,         // GitHub PAT
  /\bxai-[A-Za-z0-9]{8,}\b/g,         // xAI
  /\bAIza[0-9A-Za-z_-]{8,}\b/g,       // Google API key
  /Bearer\s+[A-Za-z0-9._-]{8,}/g,     // Authorization: Bearer ...
];

export function redactErrorText(
  text: string,
  sensitiveValues: readonly string[] = [],
): string {
  let out = text;
  const literalValues = new Set<string>();
  for (const value of sensitiveValues) {
    if (!value) continue;
    literalValues.add(value);
    try { literalValues.add(encodeURIComponent(value)); } catch { /* keep literal redaction */ }
    try {
      literalValues.add(new URLSearchParams({ value }).toString().slice("value=".length));
    } catch { /* keep literal redaction */ }
  }
  for (const value of [...literalValues].sort((a, b) => b.length - a.length)) {
    out = out.split(value).join("<redacted>");
  }
  for (const re of SECRET_PATTERNS) out = out.replace(re, "<redacted>");
  return out;
}

/**
 * Deep-walk a parsed JSON value and scrub secret shapes and resolved values
 * from keys and string leaves. The input is not mutated. Cycles and values
 * beyond the recursion cap become fixed markers instead of returning an
 * unredacted subtree.
 */
export function redactRawObject(
  value: unknown,
  sensitiveValues: readonly string[] = [],
  seen: WeakSet<object> = new WeakSet(),
  depth = 0,
): unknown {
  // Strings are scrubbed regardless of depth — a secret nested in a deeply-
  // nested provider error body must not be returned un-redacted just because
  // the recursion cap fired.
  if (typeof value === "string") return redactErrorText(value, sensitiveValues);
  if (value === null || value === undefined) return value;
  if (typeof value !== "object") return value;
  if (seen.has(value as object)) return "<circular>";
  if (depth > 256) return "<redacted>";
  seen.add(value as object);
  if (Array.isArray(value)) {
    return value.map((v) => {
      if (typeof v === "string") return redactErrorText(v, sensitiveValues);
      return redactRawObject(v, sensitiveValues, seen, depth + 1);
    });
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const key = redactErrorText(k, sensitiveValues);
    if (typeof v === "string") {
      out[key] = redactErrorText(v, sensitiveValues);
    } else {
      out[key] = redactRawObject(v, sensitiveValues, seen, depth + 1);
    }
  }
  return out;
}
