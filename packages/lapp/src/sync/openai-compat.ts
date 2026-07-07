/**
 * OpenAI-compatible model list fetcher.
 *
 * Most OpenAI-compatible providers expose GET {baseUrl}/models returning:
 *   { "data": [ { "id": "...", "owned_by": "...", "created": 1234567890 } ] }
 *
 * Ollama's /v1/models endpoint uses "name" instead of "id", so we accept both.
 */

import type { FetchedModelEntry } from "./types.js";
import { redactErrorText } from "../redact.js";

interface SyncAdapterContext {
  providerId: string;
  protocol: string;
  baseUrl: string;
  secret: string;
  authType?: string;
  authHeader?: string;
  requestHeaders?: Record<string, string>;
}

interface OpenAiCompatListResponse {
  data?: Array<Record<string, unknown>>;
}

function entryId(entry: Record<string, unknown>): string | undefined {
  if (typeof entry.id === "string") return entry.id;
  if (typeof entry.name === "string") return entry.name;
  return undefined;
}

export async function fetchOpenAiCompatModels(
  ctx: SyncAdapterContext,
  fetchImpl: typeof fetch,
  modelsUrl?: string,
): Promise<FetchedModelEntry[]> {
  const base = ctx.baseUrl.replace(/\/+$/, "");
  const url = modelsUrl ? modelsUrl : `${base}/models`;

  // Strip auth-carrying keys from the caller's requestHeaders (same
  // discipline the chat adapters apply) so a user-supplied header with a
  // different case (e.g. "authorization") does NOT produce two distinct
  // auth headers on the sync fetch. Then spread the rest so a provider
  // behind a proxy/SSO that requires a non-auth static header (e.g.
  // X-Tenant-Id) gets it honored on /models the same way chat does.
  const authStrip = new Set(["authorization", "x-api-key"]);
  const cleanRequestHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(ctx.requestHeaders ?? {})) {
    if (authStrip.has(k.toLowerCase())) continue;
    cleanRequestHeaders[k] = v;
  }
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...cleanRequestHeaders,
  };

  if (ctx.secret) {
    const headerName = ctx.authHeader ?? "Authorization";
    const authType = ctx.authType ?? "bearer";
    if (authType === "bearer") {
      headers[headerName] = `Bearer ${ctx.secret}`;
    } else if (authType === "custom-header") {
      headers[headerName] = ctx.secret;
    } else {
      headers[headerName] = `Bearer ${ctx.secret}`;
    }
  }

  const resp = await fetchImpl(url, { method: "GET", headers });
  const text = await resp.text();
  let raw: unknown;
  try {
    raw = text ? JSON.parse(text) : {};
  } catch {
    raw = { _rawText: text };
  }

  if (!resp.ok) {
    // Redact common secret shapes from the error body before embedding it in
    // the thrown Error — a provider that echoes credentials or stack traces
    // could otherwise leak the resolved secret into logs and test output.
    const redacted = redactErrorText(text);
    throw new Error(`provider ${ctx.providerId} returned ${resp.status}: ${redacted}`);
  }

  const payload = raw as OpenAiCompatListResponse;
  const data = Array.isArray(payload.data) ? payload.data : [];

  return data.map((entry) => {
    const id = entryId(entry);
    if (!id) {
      throw new Error(`provider ${ctx.providerId} returned a model entry without id or name`);
    }
    return {
      id,
      name: typeof entry.name === "string" ? entry.name : id,
      ownedBy: typeof entry.owned_by === "string" ? entry.owned_by : undefined,
      created: typeof entry.created === "number" ? entry.created : undefined,
      raw: entry,
    };
  });
}
