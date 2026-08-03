import { createHash } from "node:crypto";
import type { ChatInput, LappResponse, LappStreamEventUnion } from "../client/adapter.js";
import type { AuthEnvelopeV1, AuthSource, AuthSourceConfig, JsonValue } from "../types.js";
import { AuthError } from "../types.js";

export interface AuthDriverContext {
  source: AuthSource;
  modelId: string;
  protocol: string;
  config: Record<string, JsonValue>;
  fetchImpl: typeof fetch;
}

export interface AuthLoginVerification {
  verificationUri: string;
  userCode?: string;
  expiresAt: string;
  intervalMs: number;
}

export interface AuthLoginProposal extends AuthLoginVerification {
  complete(options?: { signal?: AbortSignal }): Promise<AuthEnvelopeV1>;
}

export interface AuthDriver {
  readonly id: string;
  proposeLogin(
    context: AuthDriverContext,
    options?: { signal?: AbortSignal },
  ): Promise<AuthLoginProposal>;
  refresh(
    context: AuthDriverContext,
    envelope: AuthEnvelopeV1,
    options?: { signal?: AbortSignal },
  ): Promise<AuthEnvelopeV1>;
  send(
    context: AuthDriverContext,
    envelope: AuthEnvelopeV1,
    input: ChatInput,
  ): Promise<LappResponse>;
  stream(
    context: AuthDriverContext,
    envelope: AuthEnvelopeV1,
    input: ChatInput,
  ): AsyncIterable<LappStreamEventUnion>;
}

function sortedJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedJson);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
      .map(([key, entry]) => [key, sortedJson(entry)]),
  );
}

/** Bind a grant to the exact portable auth.json definition that authorized it. */
export function computeAuthConfigDigest(config: AuthSourceConfig): string {
  const hash = createHash("sha256");
  hash.update(Buffer.from("lapp-auth-config-v1\0", "ascii"));
  hash.update(JSON.stringify(sortedJson(config)), "utf8");
  return `sha256:${hash.digest("hex")}`;
}

export class AuthDriverRegistry {
  private readonly drivers = new Map<string, AuthDriver>();

  constructor(drivers: readonly AuthDriver[] = []) {
    for (const driver of drivers) this.register(driver);
  }

  register(driver: AuthDriver): this {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(driver.id)) {
      throw new TypeError("invalid auth driver id");
    }
    if (this.drivers.has(driver.id)) throw new Error(`auth driver is already registered: ${driver.id}`);
    this.drivers.set(driver.id, driver);
    return this;
  }

  get(id: string): AuthDriver {
    const driver = this.drivers.get(id);
    if (!driver) throw new AuthError("AUTH_DRIVER_NOT_SUPPORTED", `auth driver is not supported: ${id}`);
    return driver;
  }

  list(): string[] {
    return [...this.drivers.keys()].sort();
  }
}

export async function collectAuthStream(
  context: AuthDriverContext,
  input: ChatInput,
  events: AsyncIterable<LappStreamEventUnion>,
): Promise<LappResponse> {
  let text = "";
  let finishReason: string | undefined;
  let usage: LappResponse["usage"];
  const toolCalls: NonNullable<LappResponse["toolCalls"]> = [];
  for await (const event of events) {
    if (event.kind === "delta") text += event.text;
    else if (event.kind === "finish") finishReason = event.reason;
    else if (event.kind === "usage") {
      usage = {
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
        totalTokens: event.totalTokens,
      };
    } else if (event.kind === "tool-call") {
      let parsed: Record<string, unknown> = {};
      let parseError: string | undefined;
      try {
        const value: unknown = event.arguments ? JSON.parse(event.arguments) : {};
        if (typeof value === "object" && value !== null && !Array.isArray(value)) parsed = value as Record<string, unknown>;
        else parseError = "invalid JSON object in tool call arguments";
      } catch {
        parseError = "invalid JSON in tool call arguments";
      }
      toolCalls.push({
        id: event.id,
        name: event.name,
        arguments: parsed,
        ...(parseError ? { parseError, argumentsRaw: event.arguments } : {}),
      });
    } else if (event.kind === "error") {
      throw new AuthError("AUTH_HTTP_ERROR", event.message);
    }
  }
  return {
    text,
    provider: context.source.config.id,
    model: context.modelId,
    protocol: context.protocol,
    ...(usage ? { usage } : {}),
    ...(finishReason ? { finishReason } : {}),
    ...(toolCalls.length ? { toolCalls } : {}),
    raw: { streamed: true },
  };
}
