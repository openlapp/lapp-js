/**
 * Environment export (`lapp env`).
 *
 * Emits shell-compatible statements for the secrets referenced by a profile,
 * so users can source the output and feed tools that read provider keys from
 * the environment (Aider, Continue.dev, Codex CLI, …).
 *
 * Secrets are still resolved only with explicit opt-in (same policy as
 * `secret/`). Without `resolve: true`, the exporter emits a redacted/comment
 * line and never prints a real value.
 */

import type { LappProfile } from "../types.js";
import { parseSecretRef, resolveSecret } from "../secret/index.js";

export type ExportFormat = "bash" | "zsh" | "fish" | "powershell" | "cmd";

export interface ExportEnvOptions {
  format: ExportFormat;
  /** Resolve `env://` references from the env source and emit real values. */
  resolve?: boolean;
  /** Custom env source (for tests). */
  env?: Record<string, string | undefined>;
  /**
   * Allow emitting plaintext secrets when `resolve: true`. Default false;
   * plaintext secrets are never emitted unless this is explicitly set.
   */
  allowPlaintext?: boolean;
}

interface ExportEntry {
  name: string;
  value: string | null; // null = could not resolve / unsupported
  reason?: string;
}

/** Derive a conventional env var name from provider id. */
export function deriveEnvName(providerId: string): string {
  const upper = providerId.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  // POSIX env var names must begin with a letter or underscore; a
  // digit-leading id (e.g. "1provider") would otherwise produce an
  // invalid name like "1PROVIDER_API_KEY" that the shell rejects.
  const safe = /^[A-Z_]/.test(upper) ? upper : `_${upper}`;
  return `${safe}_API_KEY`;
}

/**
 * Returns true if `name` would collide with an entry already emitted, so the
 * caller can skip a second export line instead of letting the second value
 * silently overwrite the first when the output is sourced.
 */
export function envNameCollision(
  name: string,
  seen: Set<string>,
  providerId: string,
): boolean {
  if (!seen.has(name)) {
    seen.add(name);
    return false;
  }
  return true;
}

/** Collect (name, value) entries for all enabled providers' secrets. */
export function collectExportEntries(
  profile: LappProfile,
  options: ExportEnvOptions,
): ExportEntry[] {
  const entries: ExportEntry[] = [];
  const seenNames = new Set<string>();
  for (const provider of profile.providers) {
    // Disabled providers are skipped: a user who turned a provider off
    // explicitly does not want its secret emitted to the shell. The
    // discovery layer keeps disabled providers in profile.providers so
    // that writes can round-trip the on-disk file, so we must filter
    // here. (See discovery.ts loadProvider: disabled providers are kept
    // for round-tripping, but their secrets should not be exported.)
    if (provider.config.enabled === false) continue;
    const secretRaw = provider.config.auth?.secret;
    if (typeof secretRaw !== "string" || secretRaw.trim() === "") continue;
    const ref = parseSecretRef(secretRaw);

    let name: string;
    let value: string | null;
    let reason: string | undefined;

    if (ref.scheme === "env") {
      // env:// with no name is malformed (the env var is empty), not an
      // unsupported scheme. Report it as a missing-env diagnostic so the
      // diagnosis matches what resolveSecret would say at runtime.
      if (!ref.reference) {
        name = deriveEnvName(provider.config.id);
        value = null;
        reason = "env:// reference is missing the env var name";
      } else {
        // Sanitize the env-ref name to a POSIX env identifier; a ref like
        // "weird name" or "a&b" would otherwise be emitted unquoted into
        // `export NAME=...` and yield a shell syntax error / injection
        // vector. deriveEnvName's sanitization is bypassed on the env://
        // path (the env name IS the ref), so we apply it here.
        const rawName = ref.reference;
        const sanitized = rawName.replace(/[^A-Za-z0-9_]+/g, "_");
        name = /^[A-Za-z_]/.test(sanitized) ? sanitized : `_${sanitized}`;
        if (name !== rawName) {
          // Tell the user we rewrote their ref name so they can fix it.
          name = `${name}__renamed_from_${rawName.replace(/[^A-Za-z0-9_]/g, "_")}`;
        }
        if (!options.resolve) {
          value = null;
          reason = "env:// resolution requires explicit opt-in";
        } else {
          const result = resolveSecret(secretRaw, { resolve: true, env: options.env });
          if (result.ok) {
            value = result.value;
          } else {
            value = null;
            // Sanitize CR/LF/control chars out of any user-controlled text
            // before it lands in a shell comment line (`# ...` / `REM ...`).
            // A newline in rawName would split the comment and the next line
            // would execute when the output is sourced.
            const stripControl = (s: string): string => s.replace(/[\r\n\t\x00-\x1f\x7f]/g, "?");
            reason = result.reason === "missing"
              ? `missing env var: ${stripControl(rawName)}`
              : stripControl(String(result.error.message));
          }
        }
      }
    } else if (ref.scheme === "plaintext") {
      name = deriveEnvName(provider.config.id);
      if (options.resolve && options.allowPlaintext) {
        value = secretRaw;
      } else {
        value = null;
        reason = options.resolve
          ? "plaintext secret omitted (use --allow-plaintext to emit)"
          : "plaintext secret requires --resolve and --allow-plaintext";
      }
    } else {
      // keychain://, file://, unknown — unsupported for resolution.
      name = deriveEnvName(provider.config.id);
      value = null;
      reason = `unsupported secret scheme: ${ref.scheme}`;
    }

    // Two provider ids that differ only by case (e.g. "OpenAI" and "openai")
    // both map to the same derived env name. Emit a collision diagnostic so
    // the user knows the second export will silently overwrite the first
    // when sourced, instead of dropping the duplicate entry without comment.
    if (value !== null && envNameCollision(name, seenNames, provider.config.id)) {
      value = null;
      reason = `env name collision: ${name} already exported by a different provider`;
    }
    entries.push({ name, value, reason });
  }
  return entries;
}

/** Render entries in the requested shell format. */
export function exportEnv(profile: LappProfile, options: ExportEnvOptions): string {
  const entries = collectExportEntries(profile, options);
  const lines: string[] = [];

  // Shell-quote a value for `cmd.exe` `set NAME=value` (no escapes available
  // for & | < > ^ inside an unquoted value). CMD's set is also case-insensitive
  // for separators — wrap with double quotes (CMD only treats `,` and `;` as
  // special inside double quotes; spaces and `=` are safe).
  const quoteForCmd = (v: string): string => `"${v.replace(/"/g, '""')}"`;

  for (const entry of entries) {
    const value = entry.value ?? "";
    switch (options.format) {
      case "bash":
      case "zsh": {
        if (entry.value !== null) {
          // POSIX single-quote literal: the only character we cannot represent
          // is a single quote itself, encoded as '\'' (close, escape, reopen).
          const safe = value.replace(/'/g, "'\\''");
          lines.push(`export ${entry.name}='${safe}'`);
        } else {
          lines.push(`# ${entry.name}: ${entry.reason ?? "unresolved"}`);
        }
        break;
      }
      case "fish": {
        if (entry.value !== null) {
          // fish single quotes are literal (no escape processing). The only
          // character that cannot appear inside a single-quoted string is `'`
          // itself, encoded as the close/escape/reopen pattern '\'' (works
          // in fish because `\'` outside quotes is a literal single quote).
          // Backslashes are passed through unchanged because they are already
          // literal inside single quotes.
          const safe = value.replace(/'/g, "'\\''");
          lines.push(`set -gx ${entry.name} '${safe}'`);
        } else {
          lines.push(`# ${entry.name}: ${entry.reason ?? "unresolved"}`);
        }
        break;
      }
      case "powershell": {
        if (entry.value !== null) {
          // PowerShell single quotes are literal (no $-interpolation), the
          // safe equivalent of POSIX single quotes. A literal `'` inside is
          // expressed as `''` in PS single-quoted strings.
          const safe = value.replace(/'/g, "''");
          lines.push(`$env:${entry.name} = '${safe}'`);
        } else {
          lines.push(`# ${entry.name}: ${entry.reason ?? "unresolved"}`);
        }
        break;
      }
      case "cmd": {
        if (entry.value !== null) {
          lines.push(`set ${entry.name}=${quoteForCmd(value)}`);
        } else {
          lines.push(`REM ${entry.name}: ${entry.reason ?? "unresolved"}`);
        }
        break;
      }
    }
  }

  return lines.join("\n");
}