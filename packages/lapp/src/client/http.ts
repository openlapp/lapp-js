/**
 * Shared HTTP helpers for the protocol adapters.
 *
 * `buildAuthHeaders` is the canonical place to enforce the auth-header dedup
 * discipline (CLAUDE.md row 16) and the requestHeaders overlay. Extracted so
 * adding a new sensitive header (or a new auth scheme) is a one-line edit
 * instead of three.
 *
 * Keep the auth-strip set tight to just the two known credential header
 * names; user-supplied `requestHeaders` that carry their own non-auth
 * metadata (X-Tenant-Id, X-Trace-Id, etc.) flow through untouched.
 */

import type { AdapterContext } from "./adapter.js";

const AUTH_HEADER_STRIP = new Set(["authorization", "x-api-key"]);

export function buildAuthHeaders(ctx: AdapterContext): Record<string, string> {
  const cleanRequestHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(ctx.requestHeaders ?? {})) {
    if (AUTH_HEADER_STRIP.has(k.toLowerCase())) continue;
    cleanRequestHeaders[k] = v;
  }
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...cleanRequestHeaders,
  };
  if (!ctx.secret) return headers;
  const headerName = ctx.authHeader ?? "Authorization";
  const authType = ctx.authType ?? "bearer";
  if (authType === "bearer") {
    headers[headerName] = `Bearer ${ctx.secret}`;
  } else if (authType === "custom-header") {
    headers[headerName] = ctx.secret;
  } else {
    // Unknown auth type — fall back to bearer to match the common case.
    headers[headerName] = `Bearer ${ctx.secret}`;
  }
  return headers;
}

/** Like `buildAuthHeaders` but adds an extra fixed header (e.g. anthropic-version). */
export function buildAuthHeadersWith(
  ctx: AdapterContext,
  extra: Record<string, string>,
): Record<string, string> {
  return { ...buildAuthHeaders(ctx), ...extra };
}
