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
  const stripped = new Set(AUTH_HEADER_STRIP);
  if (ctx.auth.type === "bearer") stripped.add("authorization");
  if (ctx.auth.type === "header") stripped.add(ctx.auth.name.toLowerCase());
  const cleanRequestHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(ctx.requestHeaders ?? {})) {
    if (stripped.has(k.toLowerCase())) continue;
    cleanRequestHeaders[k] = v;
  }
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...cleanRequestHeaders,
  };
  if (ctx.auth.type === "bearer") {
    headers.Authorization = `Bearer ${ctx.auth.secret}`;
  } else if (ctx.auth.type === "header") {
    headers[ctx.auth.name] = ctx.auth.secret;
  }
  return headers;
}

/** Apply query authentication after the adapter has chosen its final URL. */
export function applyQueryAuth(
  ctx: AdapterContext,
  url: string,
): string {
  if (ctx.auth.type !== "query") return url;
  const parsed = new URL(url);
  parsed.searchParams.set(ctx.auth.name, ctx.auth.secret);
  return parsed.toString();
}

/** Like `buildAuthHeaders` but adds an extra fixed header (e.g. anthropic-version). */
export function buildAuthHeadersWith(
  ctx: AdapterContext,
  extra: Record<string, string>,
): Record<string, string> {
  const headers = buildAuthHeaders(ctx);
  for (const [name, value] of Object.entries(extra)) {
    for (const existing of Object.keys(headers)) {
      if (existing.toLowerCase() === name.toLowerCase()) delete headers[existing];
    }
    headers[name] = value;
  }
  return headers;
}

/** Append a provider endpoint to the URL pathname without losing its query. */
export function appendUrlPath(base: string, suffix: string): string {
  const url = new URL(base);
  const pathname = url.pathname.replace(/\/+$/, "");
  url.pathname = `${pathname}/${suffix.replace(/^\/+/, "")}`;
  return url.toString();
}
