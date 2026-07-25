import { selectConnection } from "../connection.js";
import { applyQueryAuth, buildAuthHeaders } from "../client/http.js";
import type { AdapterContext } from "../client/adapter.js";
import { redactErrorText, redactRawObject } from "../redact.js";
import {
  assertCredentialRequestOrigin,
  createCredentialResolver,
  resolveAuthConfig,
} from "../secret/index.js";
import {
  CredentialError,
  TargetResolutionError,
  type CredentialResolver,
  type JsonValue,
} from "../types.js";
import type { MediaAdapter, MediaRequest, MediaResponse, MediaTransport } from "./internal.js";
import {
  GenerationClientError,
  type AudioStreamEvent,
  type CreateGenerationClientOptions,
  type DownloadArtifactOptions,
  type GenerationArtifact,
  type GenerationEvent,
  type GenerationJob,
  type GenerationOperation,
  type GenerationState,
  type GenerationTerminal,
  type WaitOptions,
} from "./types.js";

const MAX_JSON_RESPONSE_BYTES = 64 * 1024 * 1024;
const MAX_ERROR_RESPONSE_BYTES = 1024 * 1024;
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_WAIT_TIMEOUT_MS = 30 * 60 * 1_000;
const MIN_POLL_INTERVAL_MS = 500;
const MAX_POLL_INTERVAL_MS = 30_000;

export interface InternalGenerationClient<I, O extends GenerationOperation> {
  readonly providerId: string;
  readonly model: string;
  readonly protocol: string;
  readonly features: Readonly<{ jobs: boolean; streaming: boolean }>;
  generate(input: I): Promise<GenerationState<O>>;
  poll(job: GenerationJob<O>): Promise<GenerationState<O>>;
  wait(
    state: GenerationState<O>,
    options?: WaitOptions<O>,
  ): Promise<GenerationTerminal<O>>;
  stream(input: I): AsyncIterable<AudioStreamEvent>;
  downloadArtifact(
    artifact: GenerationArtifact,
    options: DownloadArtifactOptions,
  ): Promise<Uint8Array>;
}

function signalFromInput(value: unknown): AbortSignal | undefined {
  if (typeof value !== "object" || value === null || !("signal" in value)) return undefined;
  const signal = (value as { signal?: unknown }).signal;
  return signal instanceof AbortSignal ? signal : undefined;
}

function checkedPositiveFinite(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new GenerationClientError("INVALID_GENERATION_INPUT", `${name} must be a positive finite number`);
  }
  return value;
}

function checkedNonNegativeFinite(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new GenerationClientError("INVALID_GENERATION_INPUT", `${name} must be a non-negative finite number`);
  }
  return value;
}

async function readBounded(
  response: Response,
  maxBytes: number,
  tooLargeCode: "INVALID_RESPONSE" | "ARTIFACT_TOO_LARGE",
): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (Number.isFinite(length) && length > maxBytes) {
      throw new GenerationClientError(tooLargeCode, "response exceeds the configured size limit");
    }
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new GenerationClientError(tooLargeCode, "response exceeds the configured size limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function responseText(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function redactThrown(error: unknown, sensitiveValues: readonly string[]): Error {
  const source = error instanceof Error ? error : new Error(String(error));
  if (source instanceof CredentialError) {
    return new CredentialError(
      source.code,
      redactErrorText(source.message, sensitiveValues),
      source.causes,
    );
  }
  if (source instanceof GenerationClientError) {
    return new GenerationClientError(
      source.code,
      redactErrorText(source.message, sensitiveValues),
      source.status,
    );
  }
  const redacted = new Error(redactErrorText(source.message, sensitiveValues));
  redacted.name = source.name;
  return redacted;
}

function redactArtifact(
  artifact: GenerationArtifact,
  sensitiveValues: readonly string[],
): GenerationArtifact {
  return {
    ...artifact,
    mediaType: redactErrorText(artifact.mediaType, sensitiveValues),
    source: artifact.source.type === "inline"
      ? { type: "inline", data: artifact.source.data }
      : {
          type: "url",
          url: redactErrorText(artifact.source.url, sensitiveValues),
          auth: artifact.source.auth,
          ...(artifact.source.expiresAt === undefined
            ? {}
            : { expiresAt: redactErrorText(artifact.source.expiresAt, sensitiveValues) }),
        },
  };
}

function redactState<O extends GenerationOperation>(
  state: GenerationState<O>,
  sensitiveValues: readonly string[],
): GenerationState<O> {
  if (state.status === "succeeded") {
    return {
      ...state,
      output: {
        parts: state.output.parts.map((part) => part.type === "text"
          ? { type: "text", text: redactErrorText(part.text, sensitiveValues) }
          : { type: "artifact", artifact: redactArtifact(part.artifact, sensitiveValues) }),
        ...(state.output.providerMetadata === undefined
          ? {}
          : {
              providerMetadata: redactRawObject(
                state.output.providerMetadata,
                sensitiveValues,
              ) as JsonValue,
            }),
      },
    };
  }
  if (state.status === "failed") {
    return {
      ...state,
      failure: {
        ...state.failure,
        message: redactErrorText(state.failure.message, sensitiveValues),
        ...(state.failure.providerCode === undefined
          ? {}
          : { providerCode: redactErrorText(state.failure.providerCode, sensitiveValues) }),
      },
    };
  }
  return state;
}

function validateJob<O extends GenerationOperation>(
  job: GenerationJob<O>,
  operation: O,
  target: { providerId: string; modelId: string; protocol: string },
): void {
  if (
    typeof job.id !== "string"
    || job.id.trim() === ""
    || job.operation !== operation
    || job.provider !== target.providerId
    || job.model !== target.modelId
    || job.protocol !== target.protocol
  ) {
    throw new GenerationClientError(
      "GENERATION_JOB_INVALID",
      "generation job does not belong to this client",
    );
  }
}

function validateState<O extends GenerationOperation>(
  state: GenerationState<O>,
  operation: O,
  target: { providerId: string; modelId: string; protocol: string },
): void {
  if (
    state.target.provider !== target.providerId
    || state.target.model !== target.modelId
    || state.target.protocol !== target.protocol
    || state.target.operation !== operation
  ) {
    throw new GenerationClientError(
      "GENERATION_JOB_INVALID",
      "generation state does not belong to this client",
    );
  }
  if (state.job) validateJob(state.job, operation, target);
  if ((state.status === "queued" || state.status === "running") && !state.job) {
    throw new GenerationClientError("INVALID_RESPONSE", "pending generation state has no job");
  }
  if (state.status === "running" && state.progress !== undefined
    && (!Number.isFinite(state.progress) || state.progress < 0 || state.progress > 1)) {
    throw new GenerationClientError("INVALID_RESPONSE", "generation progress is outside 0..1");
  }
}

function eventFromState<O extends GenerationOperation>(state: GenerationState<O>): GenerationEvent<O> {
  if (state.status === "queued") {
    return {
      kind: "queued",
      job: state.job,
      ...(state.retryAfterMs === undefined ? {} : { retryAfterMs: state.retryAfterMs }),
    };
  }
  if (state.status === "running") {
    return {
      kind: "running",
      job: state.job,
      ...(state.progress === undefined ? {} : { progress: state.progress }),
      ...(state.retryAfterMs === undefined ? {} : { retryAfterMs: state.retryAfterMs }),
    };
  }
  if (state.status === "succeeded") return { kind: "succeeded", output: state.output };
  return { kind: "failed", failure: state.failure };
}

function eventKey<O extends GenerationOperation>(state: GenerationState<O>): string {
  if (state.status === "running") {
    return `${state.status}:${state.progress ?? ""}`;
  }
  if (state.status === "queued") return state.status;
  return state.status;
}

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", aborted);
      resolve();
    }, ms);
    const aborted = (): void => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException("The operation was aborted", "AbortError"));
    };
    signal?.addEventListener("abort", aborted, { once: true });
  });
}

async function awaitWithinWaitBoundary<T>(
  work: Promise<T>,
  remainingMs: number,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  if (remainingMs <= 0) {
    throw new GenerationClientError("WAIT_TIMEOUT", "generation wait timed out");
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", aborted);
    };
    const succeed = (value: T): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const aborted = (): void => {
      fail(signal?.reason ?? new DOMException("The operation was aborted", "AbortError"));
    };
    timer = setTimeout(() => {
      fail(new GenerationClientError("WAIT_TIMEOUT", "generation wait timed out"));
    }, remainingMs);
    signal?.addEventListener("abort", aborted, { once: true });
    if (signal?.aborted) {
      aborted();
      return;
    }
    // Keep handlers attached after local timeout/abort so a later remote
    // failure is observed rather than becoming an unhandled rejection. This
    // races local termination only; it does not claim to cancel the job.
    work.then(succeed, fail);
  });
}

function checkedArtifactUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new GenerationClientError("ARTIFACT_UNAVAILABLE", "artifact URL is invalid");
  }
  if (url.username || url.password || url.hash) {
    throw new GenerationClientError("ARTIFACT_UNAVAILABLE", "artifact URL is unsafe");
  }
  const loopback = url.hostname === "localhost"
    || url.hostname === "::1"
    || /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new GenerationClientError("ARTIFACT_UNAVAILABLE", "artifact URL must use HTTPS or loopback HTTP");
  }
  return url;
}

/** Internal testable factory. It is not re-exported by the package. */
export function createGenerationClientCore<I, O extends GenerationOperation>(
  options: CreateGenerationClientOptions,
  operation: O,
  defaultName: string,
  adapters: Readonly<Record<string, MediaAdapter<I, O>>>,
): InternalGenerationClient<I, O> {
  const hasProvider = options.provider !== undefined;
  const hasModel = options.model !== undefined;
  if (hasProvider !== hasModel) {
    throw new TargetResolutionError("provider and model must be supplied together");
  }
  if (hasProvider && options.default !== undefined) {
    throw new TargetResolutionError("default cannot be combined with provider/model");
  }
  const selector = hasProvider
    ? { providerId: options.provider!, model: options.model! } as const
    : { default: options.default ?? defaultName } as const;
  const targetPlan = selectConnection(options.profile, selector);
  const selectedModel = options.profile.providers
    .find((provider) => provider.config.id === targetPlan.providerId)
    ?.models.models.find((model) => model.id === targetPlan.modelId);
  if (selectedModel?.capabilities !== undefined
    && !selectedModel.capabilities.includes(operation)) {
    throw new GenerationClientError(
      "OPERATION_NOT_SUPPORTED",
      `model ${targetPlan.providerId}/${targetPlan.modelId} does not declare ${operation}`,
    );
  }
  const plan = selectConnection(options.profile, selector, {
    supportedProtocols: Object.keys(adapters),
  });
  const adapter = adapters[plan.protocol]!;
  const resolver: CredentialResolver = options.resolver ?? createCredentialResolver({
    ...(options.env ? { env: options.env } : {}),
    ...(options.vault ? { vault: options.vault } : {}),
  });
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  const redactSuccessfulSecrets = options.redactSuccessfulSecrets ?? true;

  async function resolvedContext(): Promise<{
    ctx: AdapterContext;
    sensitiveValues: string[];
  }> {
    const auth = await resolveAuthConfig(plan.auth, plan.credentialBinding, { resolver });
    return {
      ctx: {
        providerId: plan.providerId,
        protocol: plan.protocol,
        baseUrl: plan.baseUrl,
        auth,
        requestHeaders: plan.requestHeaders,
        model: plan.modelId,
      },
      sensitiveValues: auth.type === "none" ? [] : [auth.secret],
    };
  }

  function transportFor(
    ctx: AdapterContext,
    sensitiveValues: readonly string[],
  ): MediaTransport {
    return {
      async request(request: MediaRequest, signal?: AbortSignal): Promise<MediaResponse> {
        signal?.throwIfAborted();
        if (plan.credentialBinding) {
          assertCredentialRequestOrigin(plan.credentialBinding, request.url);
        }
        const finalUrl = applyQueryAuth(ctx, request.url);
        if (plan.credentialBinding) {
          assertCredentialRequestOrigin(plan.credentialBinding, finalUrl);
        }
        const headers = { ...buildAuthHeaders(ctx), ...(request.headers ?? {}) };
        try {
          const response = await doFetch(finalUrl, {
            method: request.method,
            headers,
            ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
            redirect: "error",
            signal,
          });
          if (!response.ok) {
            let detail = "";
            try {
              detail = responseText(await readBounded(
                response,
                MAX_ERROR_RESPONSE_BYTES,
                "INVALID_RESPONSE",
              )).slice(0, 1_000);
            } catch {
              // The stable status is enough when an error body cannot be read safely.
            }
            throw new GenerationClientError(
              "HTTP_STATUS",
              `provider ${ctx.providerId} returned ${response.status}${detail ? `: ${redactErrorText(detail, sensitiveValues)}` : ""}`,
              response.status,
            );
          }
          if (request.responseType === "stream") {
            if (!response.body) {
              throw new GenerationClientError("INVALID_RESPONSE", "provider returned an empty stream body");
            }
            return { headers: response.headers, stream: response.body };
          }
          const bytes = await readBounded(response, MAX_JSON_RESPONSE_BYTES, "INVALID_RESPONSE");
          if (request.responseType === "bytes") {
            return { headers: response.headers, bytes };
          }
          let json: unknown;
          try {
            json = JSON.parse(responseText(bytes));
          } catch {
            throw new GenerationClientError("INVALID_RESPONSE", "provider returned invalid JSON");
          }
          return { headers: response.headers, json };
        } catch (error) {
          if (error instanceof CredentialError || error instanceof GenerationClientError) {
            throw redactThrown(error, sensitiveValues);
          }
          throw new GenerationClientError(
            "HTTP_REQUEST_FAILED",
            redactErrorText("provider request failed", sensitiveValues),
          );
        }
      },
    };
  }

  async function run<T>(
    action: (ctx: AdapterContext, transport: MediaTransport) => Promise<T>,
  ): Promise<{ value: T; sensitiveValues: string[] }> {
    const { ctx, sensitiveValues } = await resolvedContext();
    try {
      return {
        value: await action(ctx, transportFor(ctx, sensitiveValues)),
        sensitiveValues,
      };
    } catch (error) {
      throw redactThrown(error, sensitiveValues);
    }
  }

  async function generate(input: I): Promise<GenerationState<O>> {
    const signal = signalFromInput(input);
    signal?.throwIfAborted();
    const { value: state, sensitiveValues } = await run(
      (ctx, transport) => adapter.submit(input, ctx, transport),
    );
    validateState(state, operation, plan);
    if (!redactSuccessfulSecrets) return state;
    return redactState(state, sensitiveValues);
  }

  async function poll(job: GenerationJob<O>): Promise<GenerationState<O>> {
    validateJob(job, operation, plan);
    if (!adapter.poll) {
      throw new GenerationClientError(
        "GENERATION_JOB_INVALID",
        `protocol ${plan.protocol} does not create pollable ${operation} jobs`,
      );
    }
    const { value: state, sensitiveValues } = await run(
      (ctx, transport) => adapter.poll!(job, ctx, transport),
    );
    validateState(state, operation, plan);
    if (!redactSuccessfulSecrets) return state;
    return redactState(state, sensitiveValues);
  }

  async function wait(
    initial: GenerationState<O>,
    options: WaitOptions<O> = {},
  ): Promise<GenerationTerminal<O>> {
    validateState(initial, operation, plan);
    options.signal?.throwIfAborted();
    if (initial.status === "succeeded" || initial.status === "failed") {
      options.onEvent?.(eventFromState(initial));
      return initial;
    }
    const interval = checkedPositiveFinite(
      options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      "pollIntervalMs",
    );
    const timeout = checkedPositiveFinite(
      options.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS,
      "timeoutMs",
    );
    let state: GenerationState<O> = initial;
    let previousKey = "";
    const started = Date.now();
    while (true) {
      const key = eventKey(state);
      if (key !== previousKey) {
        options.onEvent?.(eventFromState(state));
        previousKey = key;
      }
      if (state.status === "succeeded" || state.status === "failed") return state;
      const elapsed = Date.now() - started;
      if (elapsed >= timeout) {
        throw new GenerationClientError("WAIT_TIMEOUT", "generation wait timed out");
      }
      const requestedDelay = state.retryAfterMs ?? interval;
      const pollDelay = Math.min(
        Math.max(checkedNonNegativeFinite(requestedDelay, "retryAfterMs"), MIN_POLL_INTERVAL_MS),
        MAX_POLL_INTERVAL_MS,
      );
      if (elapsed + pollDelay >= timeout) {
        await delay(timeout - elapsed, options.signal);
        throw new GenerationClientError("WAIT_TIMEOUT", "generation wait timed out");
      }
      await delay(pollDelay, options.signal);
      const remainingAfterDelay = timeout - (Date.now() - started);
      state = await awaitWithinWaitBoundary(
        poll(state.job),
        remainingAfterDelay,
        options.signal,
      );
    }
  }

  async function* stream(input: I): AsyncIterable<AudioStreamEvent> {
    if (!adapter.stream) {
      throw new GenerationClientError(
        "STREAMING_NOT_SUPPORTED",
        `protocol ${plan.protocol} does not support streaming ${operation}`,
      );
    }
    const signal = signalFromInput(input);
    signal?.throwIfAborted();
    const { ctx, sensitiveValues } = await resolvedContext();
    try {
      for await (const event of adapter.stream(input, ctx, transportFor(ctx, sensitiveValues))) {
        yield event.kind === "audio"
          ? event
          : { kind: "finish", mediaType: redactErrorText(event.mediaType, sensitiveValues) };
      }
    } catch (error) {
      throw redactThrown(error, sensitiveValues);
    }
  }

  async function downloadArtifact(
    artifact: GenerationArtifact,
    options: DownloadArtifactOptions,
  ): Promise<Uint8Array> {
    const maxBytes = checkedPositiveFinite(options.maxBytes, "maxBytes");
    if (!Number.isSafeInteger(maxBytes)) {
      throw new GenerationClientError("INVALID_GENERATION_INPUT", "maxBytes must be a safe integer");
    }
    options.signal?.throwIfAborted();
    if (artifact.source.type === "inline") {
      if (!(artifact.source.data instanceof Uint8Array)) {
        throw new GenerationClientError("ARTIFACT_UNAVAILABLE", "inline artifact data is invalid");
      }
      if (artifact.source.data.byteLength > maxBytes) {
        throw new GenerationClientError("ARTIFACT_TOO_LARGE", "artifact exceeds maxBytes");
      }
      return artifact.source.data.slice();
    }
    if (artifact.source.expiresAt !== undefined) {
      const expires = Date.parse(artifact.source.expiresAt);
      if (!Number.isFinite(expires)) {
        throw new GenerationClientError("ARTIFACT_UNAVAILABLE", "artifact expiry is invalid");
      }
      if (expires <= Date.now()) {
        throw new GenerationClientError("ARTIFACT_EXPIRED", "artifact URL has expired");
      }
    }
    const url = checkedArtifactUrl(artifact.source.url);
    let finalUrl = url.toString();
    let headers: Record<string, string> = {};
    let sensitiveValues: string[] = [];
    if (artifact.source.auth === "provider") {
      if (plan.auth.type === "none" || !plan.credentialBinding) {
        throw new GenerationClientError("ARTIFACT_UNAVAILABLE", "provider-auth artifact has no configured credential");
      }
      assertCredentialRequestOrigin(plan.credentialBinding, finalUrl);
      const resolved = await resolvedContext();
      sensitiveValues = resolved.sensitiveValues;
      finalUrl = applyQueryAuth(resolved.ctx, finalUrl);
      assertCredentialRequestOrigin(plan.credentialBinding, finalUrl);
      headers = buildAuthHeaders(resolved.ctx);
      for (const name of Object.keys(headers)) {
        if (name.toLowerCase() === "content-type") delete headers[name];
      }
    }
    let response: Response;
    try {
      response = await doFetch(finalUrl, {
        method: "GET",
        headers,
        redirect: "error",
        signal: options.signal,
      });
    } catch {
      throw new GenerationClientError("ARTIFACT_UNAVAILABLE", "artifact download failed");
    }
    if (!response.ok) {
      throw new GenerationClientError(
        "ARTIFACT_UNAVAILABLE",
        redactErrorText(`artifact download returned ${response.status}`, sensitiveValues),
        response.status,
      );
    }
    try {
      return await readBounded(response, maxBytes, "ARTIFACT_TOO_LARGE");
    } catch (error) {
      if (error instanceof GenerationClientError) throw error;
      throw new GenerationClientError("ARTIFACT_UNAVAILABLE", "artifact download could not be read");
    }
  }

  return {
    providerId: plan.providerId,
    model: plan.modelId,
    protocol: plan.protocol,
    features: Object.freeze({ ...adapter.features }),
    generate,
    poll,
    wait,
    stream,
    downloadArtifact,
  };
}
