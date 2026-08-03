import { AuthError, type AuthEnvelopeV1 } from "../../types.js";
import type { AuthDriver, AuthDriverContext, AuthLoginProposal } from "../driver.js";
import { collectAuthStream, computeAuthConfigDigest } from "../driver.js";
import { configString, credentialString, expiresAt, formPost, jwtPayload, responseJson, streamResponses } from "./shared.js";

export const OPENAI_CODEX_DRIVER_ID = "openai-codex";

function configuredUrl(context: AuthDriverContext, key: string): string {
  let url: URL;
  try { url = new URL(configString(context, key)); } catch {
    throw new AuthError("AUTH_DRIVER_NOT_SUPPORTED", `${key} is not a valid URL`);
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new AuthError("AUTH_DRIVER_NOT_SUPPORTED", `${key} must be an HTTPS URL without credentials or fragment`);
  }
  return url.toString().replace(/\/$/, "");
}

function accountId(payload: Record<string, unknown> | undefined): string | undefined {
  if (!payload) return undefined;
  if (typeof payload.chatgpt_account_id === "string") return payload.chatgpt_account_id;
  const auth = payload["https://api.openai.com/auth"];
  if (typeof auth === "object" && auth !== null && !Array.isArray(auth)) {
    const value = (auth as Record<string, unknown>).chatgpt_account_id;
    if (typeof value === "string") return value;
  }
  return undefined;
}

function codexEnvelope(
  context: AuthDriverContext,
  payload: Record<string, unknown>,
  previous?: AuthEnvelopeV1,
): AuthEnvelopeV1 {
  const accessToken = typeof payload.access_token === "string" ? payload.access_token.trim() : "";
  if (!accessToken) {
    throw new AuthError(previous ? "AUTH_REFRESH_FAILED" : "AUTH_LOGIN_FAILED", "OpenAI token response is incomplete");
  }
  const refreshToken = typeof payload.refresh_token === "string"
    ? payload.refresh_token.trim()
    : previous ? credentialString(previous, "refreshToken") : undefined;
  const idToken = typeof payload.id_token === "string" ? payload.id_token : undefined;
  const accessClaims = jwtPayload(accessToken);
  const idClaims = idToken ? jwtPayload(idToken) : undefined;
  const configuredAccount = context.config.accountId;
  const resolvedAccount = accountId(accessClaims)
    ?? accountId(idClaims)
    ?? (previous ? credentialString(previous, "accountId") : undefined)
    ?? (typeof configuredAccount === "string" ? configuredAccount : undefined);
  if (!resolvedAccount) {
    throw new AuthError(
      previous ? "AUTH_REFRESH_FAILED" : "AUTH_LOGIN_FAILED",
      "OpenAI account id was not present in the OAuth session",
    );
  }
  const exp = accessClaims?.exp;
  return {
    version: 1,
    authId: context.source.config.id,
    driver: OPENAI_CODEX_DRIVER_ID,
    configDigest: computeAuthConfigDigest(context.source.config),
    generation: (previous?.generation ?? 0) + 1,
    credentials: {
      accessToken,
      ...(refreshToken ? { refreshToken } : {}),
      tokenType: typeof payload.token_type === "string" ? payload.token_type : "Bearer",
      expiresAt: typeof exp === "number"
        ? new Date(exp * 1_000).toISOString()
        : expiresAt(payload.expires_in, 3_600),
      accountId: resolvedAccount,
      ...(idToken ? { idToken } : {}),
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

export const openaiCodexAuthDriver: AuthDriver = {
  id: OPENAI_CODEX_DRIVER_ID,

  async proposeLogin(context, options = {}): Promise<AuthLoginProposal> {
    const clientId = configString(context, "clientId");
    const issuer = configuredUrl(context, "issuer");
    const deviceResponse = await context.fetchImpl(`${issuer}/api/accounts/deviceauth/usercode`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ client_id: clientId }),
      redirect: "error",
      signal: options.signal,
    });
    const device = await responseJson(deviceResponse, "login");
    const userCode = typeof device.user_code === "string" ? device.user_code : "";
    const deviceAuthId = typeof device.device_auth_id === "string" ? device.device_auth_id : "";
    const rawInterval = typeof device.interval === "number" ? device.interval : Number(device.interval ?? 5);
    const intervalMs = Math.max(3, Number.isFinite(rawInterval) ? rawInterval : 5) * 1_000;
    if (!userCode || !deviceAuthId) {
      throw new AuthError("AUTH_LOGIN_FAILED", "OpenAI device authorization response is incomplete");
    }
    const deadline = Date.now() + 15 * 60 * 1_000;
    return {
      verificationUri: `${issuer}/codex/device`,
      userCode,
      expiresAt: new Date(deadline).toISOString(),
      intervalMs,
      async complete(completeOptions = {}) {
        const signal = completeOptions.signal ?? options.signal;
        while (Date.now() < deadline) {
          signal?.throwIfAborted();
          await wait(intervalMs, signal);
          const poll = await context.fetchImpl(`${issuer}/api/accounts/deviceauth/token`, {
            method: "POST",
            headers: { "content-type": "application/json", accept: "application/json" },
            body: JSON.stringify({ device_auth_id: deviceAuthId, user_code: userCode }),
            redirect: "error",
            signal,
          });
          if (poll.status === 403 || poll.status === 404) continue;
          const code = await responseJson(poll, "login");
          const authorizationCode = typeof code.authorization_code === "string" ? code.authorization_code : "";
          const codeVerifier = typeof code.code_verifier === "string" ? code.code_verifier : "";
          if (!authorizationCode || !codeVerifier) {
            throw new AuthError("AUTH_LOGIN_FAILED", "OpenAI device authorization exchange is incomplete");
          }
          const tokens = await formPost(context.fetchImpl, `${issuer}/oauth/token`, {
            grant_type: "authorization_code",
            code: authorizationCode,
            redirect_uri: `${issuer}/deviceauth/callback`,
            client_id: clientId,
            code_verifier: codeVerifier,
          }, "login", signal);
          return codexEnvelope(context, tokens);
        }
        throw new AuthError("AUTH_LOGIN_FAILED", "OpenAI device authorization timed out");
      },
    };
  },

  async refresh(context, envelope, options = {}) {
    const refreshToken = credentialString(envelope, "refreshToken");
    if (!refreshToken) throw new AuthError("AUTH_REFRESH_FAILED", "OpenAI refresh token is missing");
    const issuer = configuredUrl(context, "issuer");
    const response = await context.fetchImpl(`${issuer}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        client_id: configString(context, "clientId"),
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
      redirect: "error",
      signal: options.signal,
    });
    return codexEnvelope(context, await responseJson(response, "refresh"), envelope);
  },

  send(context, envelope, input) {
    return collectAuthStream(context, input, this.stream(context, envelope, input));
  },

  stream(context, envelope, input) {
    const account = credentialString(envelope, "accountId");
    if (!account) {
      throw new AuthError("AUTH_RECORD_INVALID", "OpenAI account id is missing from the auth record");
    }
    return streamResponses(context, envelope, input, {
      baseUrl: configuredUrl(context, "inferenceBaseUrl"),
      headers: {
        "ChatGPT-Account-ID": account,
        originator: "openlapp",
      },
      transformBody(body) {
        const include = Array.isArray(body.include)
          ? body.include.filter((entry): entry is string => typeof entry === "string")
          : [];
        if (!include.includes("reasoning.encrypted_content")) include.push("reasoning.encrypted_content");
        return {
          ...body,
          store: false,
          stream: true,
          include,
          ...(body.tools !== undefined ? {
            tool_choice: body.tool_choice ?? "auto",
            parallel_tool_calls: body.parallel_tool_calls ?? true,
          } : {}),
          ...(typeof context.config.reasoningEffort === "string" && body.reasoning === undefined
            ? { reasoning: { effort: context.config.reasoningEffort } }
            : {}),
        };
      },
    });
  },
};
