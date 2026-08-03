import { AuthError, type AuthEnvelopeV1 } from "../../types.js";
import type { AuthDriver, AuthDriverContext, AuthLoginProposal } from "../driver.js";
import { collectAuthStream, computeAuthConfigDigest } from "../driver.js";
import {
  configString,
  credentialString,
  expiresAt,
  formPost,
  jwtPayload,
  responseJson,
  streamChatCompletions,
} from "./shared.js";

export const XAI_GROK_DRIVER_ID = "xai-grok";

function validateEndpoint(value: unknown): string {
  if (typeof value !== "string") throw new AuthError("AUTH_DRIVER_NOT_SUPPORTED", "xAI endpoint is not configured");
  let url: URL;
  try { url = new URL(value); } catch {
    throw new AuthError("AUTH_DRIVER_NOT_SUPPORTED", "xAI endpoint is not a valid URL");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new AuthError("AUTH_DRIVER_NOT_SUPPORTED", "xAI endpoint must be an HTTPS URL without credentials or fragment");
  }
  return url.toString();
}

function envelopeFromToken(
  context: AuthDriverContext,
  payload: Record<string, unknown>,
  tokenEndpoint: string,
  previous?: AuthEnvelopeV1,
): AuthEnvelopeV1 {
  const accessToken = typeof payload.access_token === "string" ? payload.access_token.trim() : "";
  const refreshToken = typeof payload.refresh_token === "string"
    ? payload.refresh_token.trim()
    : (previous ? credentialString(previous, "refreshToken") : undefined) ?? "";
  if (!accessToken || !refreshToken) {
    throw new AuthError(previous ? "AUTH_REFRESH_FAILED" : "AUTH_LOGIN_FAILED", "xAI token response is incomplete");
  }
  const jwtExp = jwtPayload(accessToken)?.exp;
  return {
    version: 1,
    authId: context.source.config.id,
    driver: XAI_GROK_DRIVER_ID,
    configDigest: computeAuthConfigDigest(context.source.config),
    generation: (previous?.generation ?? 0) + 1,
    credentials: {
      accessToken,
      refreshToken,
      tokenType: typeof payload.token_type === "string" ? payload.token_type : "Bearer",
      expiresAt: typeof jwtExp === "number"
        ? new Date(jwtExp * 1_000).toISOString()
        : expiresAt(payload.expires_in, 15 * 60),
      ...(typeof payload.id_token === "string" && payload.id_token
        ? { idToken: payload.id_token }
        : {}),
      tokenEndpoint,
    },
  };
}

function wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(resolve, milliseconds);
    signal?.addEventListener("abort", () => {
      clearTimeout(timeout);
      reject(signal.reason ?? new Error("aborted"));
    }, { once: true });
  });
}

export const xaiGrokAuthDriver: AuthDriver = {
  id: XAI_GROK_DRIVER_ID,

  async proposeLogin(context, options = {}): Promise<AuthLoginProposal> {
    const clientId = configString(context, "clientId");
    const scope = configString(context, "scope");
    const discoveryUrl = validateEndpoint(configString(context, "discoveryUrl"));
    const deviceCodeUrl = validateEndpoint(configString(context, "deviceCodeUrl"));
    const discoveryResponse = await context.fetchImpl(discoveryUrl, {
      headers: { accept: "application/json" },
      redirect: "error",
      signal: options.signal,
    });
    const discovery = await responseJson(discoveryResponse, "login");
    const tokenEndpoint = validateEndpoint(discovery.token_endpoint);
    const device = await formPost(
      context.fetchImpl,
      deviceCodeUrl,
      { client_id: clientId, scope },
      "login",
      options.signal,
    );
    const deviceCode = typeof device.device_code === "string" ? device.device_code : "";
    const userCode = typeof device.user_code === "string" ? device.user_code : "";
    const verificationUri = typeof device.verification_uri_complete === "string"
      ? device.verification_uri_complete
      : typeof device.verification_uri === "string" ? device.verification_uri : "";
    const lifetimeSeconds = typeof device.expires_in === "number" ? device.expires_in : 900;
    let intervalMs = Math.max(1, typeof device.interval === "number" ? device.interval : 5) * 1_000;
    if (!deviceCode || !userCode || !verificationUri) {
      throw new AuthError("AUTH_LOGIN_FAILED", "xAI device authorization response is incomplete");
    }
    const deadline = Date.now() + lifetimeSeconds * 1_000;
    return {
      verificationUri,
      userCode,
      expiresAt: new Date(deadline).toISOString(),
      intervalMs,
      async complete(completeOptions = {}) {
        const signal = completeOptions.signal ?? options.signal;
        while (Date.now() < deadline) {
          signal?.throwIfAborted();
          await wait(intervalMs, signal);
          const response = await context.fetchImpl(tokenEndpoint, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
            body: new URLSearchParams({
              grant_type: "urn:ietf:params:oauth:grant-type:device_code",
              client_id: clientId,
              device_code: deviceCode,
            }),
            redirect: "error",
            signal,
          });
          if (response.ok) return envelopeFromToken(context, await responseJson(response, "login"), tokenEndpoint);
          let pending: unknown;
          try { pending = await response.json(); } catch { /* mapped below */ }
          const code = typeof pending === "object" && pending !== null
            ? (pending as { error?: unknown }).error
            : undefined;
          if (code === "authorization_pending") continue;
          if (code === "slow_down") {
            intervalMs = Math.min(intervalMs + 1_000, 30_000);
            continue;
          }
          throw new AuthError("AUTH_LOGIN_FAILED", `xAI device authorization failed with HTTP ${response.status}`, response.status);
        }
        throw new AuthError("AUTH_LOGIN_FAILED", "xAI device authorization timed out");
      },
    };
  },

  async refresh(context, envelope, options = {}) {
    const refreshToken = credentialString(envelope, "refreshToken");
    if (!refreshToken) throw new AuthError("AUTH_REFRESH_FAILED", "xAI refresh token is missing");
    const tokenEndpoint = validateEndpoint(credentialString(envelope, "tokenEndpoint"));
    const payload = await formPost(context.fetchImpl, tokenEndpoint, {
      grant_type: "refresh_token",
      client_id: configString(context, "clientId"),
      refresh_token: refreshToken,
    }, "refresh", options.signal);
    return envelopeFromToken(context, payload, tokenEndpoint, envelope);
  },

  send(context, envelope, input) {
    return collectAuthStream(context, input, this.stream(context, envelope, input));
  },

  stream(context, envelope, input) {
    if (context.protocol !== "openai-chat-completions") {
      throw new AuthError(
        "AUTH_DRIVER_NOT_SUPPORTED",
        "xAI Grok requires the openai-chat-completions protocol",
      );
    }
    return streamChatCompletions(context, envelope, input, {
      baseUrl: validateEndpoint(configString(context, "inferenceBaseUrl")),
    });
  },
};
