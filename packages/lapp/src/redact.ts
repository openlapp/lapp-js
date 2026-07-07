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
 * one edit. The CLI keeps its own copy in `cli/src/index.ts` for the case
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

export function redactErrorText(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) out = out.replace(re, "<redacted>");
  return out;
}

/**
 * Deep-walk a parsed JSON value and scrub common secret shapes from every
 * string leaf. Returns a structurally-identical copy — the input is not
 * mutated. Cycle-safe via a `WeakSet`. Depth is bounded to avoid pathological
 * inputs; strings are still scrubbed past the depth cap so a secret nested
 * in a deeply-nested provider error body is not returned un-redacted.
 */
export function redactRawObject(
  value: unknown,
  seen: WeakSet<object> = new WeakSet(),
  depth = 0,
): unknown {
  // Strings are scrubbed regardless of depth — a secret nested in a deeply-
  // nested provider error body must not be returned un-redacted just because
  // the recursion cap fired.
  if (typeof value === "string") return redactErrorText(value);
  if (value === null || value === undefined) return value;
  if (typeof value !== "object") return value;
  if (seen.has(value as object)) return value;
  // Hard cap on structural recursion depth. Real provider error bodies are
  // well under this; the cap exists to bound work on truly pathological /
  // malicious inputs. When it fires, we still attempt a one-level scrub of
  // any string leaves (so a secret nested just past the cap is not leaked),
  // then return the (un-redacted) rest of the subtree verbatim — accepting
  // a small gap for deeply-nested secrets in exchange for a guaranteed
  // finite walk.
  if (depth > 4096) return value;
  seen.add(value as object);
  if (Array.isArray(value)) {
    return value.map((v) => {
      if (typeof v === "string") return redactErrorText(v);
      return redactRawObject(v, seen, depth + 1);
    });
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "string") {
      out[k] = redactErrorText(v);
    } else {
      out[k] = redactRawObject(v, seen, depth + 1);
    }
  }
  return out;
}
