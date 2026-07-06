/**
 * Secret parsing and resolution.
 *
 * v1 supports runtime resolution only for:
 *   - plaintext secret strings
 *   - `env://NAME`
 *
 * `keychain://` and `file://` are parsed as references but runtime resolution
 * returns `UnsupportedSecretSchemeError`. Unknown URI schemes are parsed but
 * also unsupported for resolution.
 *
 * Default behavior (per design §4):
 *   - never print full secrets unless explicitly requested
 *   - require an explicit SDK option to resolve secret values
 */

import process from "node:process";
import {
  MissingEnvSecretError,
  UnsupportedSecretSchemeError,
  type SecretRef,
  type SecretScheme,
} from "../types.js";

const SECRET_SCHEMES = new Set<SecretScheme>(["env", "keychain", "file"]);

/** Parse a secret string into a typed reference. */
export function parseSecretRef(raw: string): SecretRef {
  if (typeof raw !== "string" || raw.trim() === "") {
    return { raw: "", scheme: "plaintext", plaintext: true };
  }

  const match = raw.match(/^([A-Za-z][A-Za-z0-9+.-]*):\/\//);
  if (!match) {
    return { raw, scheme: "plaintext", plaintext: true };
  }

  const scheme = match[1]!.toLowerCase() as SecretScheme;
  // Only classify as a non-plaintext ref if the scheme is one we recognize.
  // A plaintext key that happens to contain "://" (e.g. "sk-abc://xyz",
  // "https://internal-vault/…") must NOT be misrouted to the unsupported
  // branch; treat unknown schemes as plaintext so the value can still be used
  // (and so redactSecret can still display the redacted form).
  if (!SECRET_SCHEMES.has(scheme)) {
    return { raw, scheme: "plaintext", plaintext: true };
  }
  const reference = raw.slice(match[0].length);
  return { raw, scheme, reference, plaintext: false };
}

/** Redact a secret for display. */
export function redactSecret(raw: string | undefined): string {
  if (typeof raw !== "string" || raw === "") return "<unset>";
  const ref = parseSecretRef(raw);
  if (ref.scheme === "env" && ref.reference) return `env://${ref.reference}`;
  if (ref.scheme === "keychain" && ref.reference) return `keychain://${ref.reference}`;
  if (ref.scheme === "file" && ref.reference) return `file://<redacted>`;
  // Plaintext (including plaintext values that contain "://") — never reveal.
  return "<redacted>";
}

export interface ResolveSecretOptions {
  /** Resolve `env://NAME` by reading `process.env`. Required to actually resolve. */
  resolve?: boolean;
  /** Custom env source (for tests); defaults to `process.env`. */
  env?: Record<string, string | undefined>;
}

export type ResolveResult =
  | { ok: true; value: string; scheme: SecretScheme }
  | { ok: false; reason: "unsupported" | "missing" | "unset"; scheme: SecretScheme; error: Error };

/**
 * Resolve a secret value. Never reads `process.env` unless `resolve: true`.
 *
 * Returns a discriminated result instead of throwing when the secret is simply
 * missing or unsupported, so callers (e.g. `testConnection`) can report cleanly.
 */
export function resolveSecret(
  raw: string | undefined,
  options: ResolveSecretOptions = {},
): ResolveResult {
  if (typeof raw !== "string" || raw.trim() === "") {
    return {
      ok: false,
      reason: "unset",
      scheme: "plaintext",
      error: new Error("auth.secret is missing or empty"),
    };
  }

  const ref = parseSecretRef(raw);

  if (ref.scheme === "plaintext") {
    return { ok: true, value: raw, scheme: "plaintext" };
  }

  if (ref.scheme === "env") {
    if (!options.resolve) {
      return {
        ok: false,
        reason: "unsupported",
        scheme: "env",
        error: new Error("env:// resolution requires explicit `resolve: true`"),
      };
    }
    const env = options.env ?? process.env;
    const name = ref.reference ?? "";
    const value = env[name];
    if (value === undefined || value === "") {
      return {
        ok: false,
        reason: "missing",
        scheme: "env",
        error: new MissingEnvSecretError(name),
      };
    }
    return { ok: true, value, scheme: "env" };
  }

  // keychain://, file://, unknown — parsed but unsupported for runtime resolution.
  return {
    ok: false,
    reason: "unsupported",
    scheme: ref.scheme,
    error: new UnsupportedSecretSchemeError(ref.scheme),
  };
}

export { UnsupportedSecretSchemeError, MissingEnvSecretError } from "../types.js";