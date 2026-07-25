import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { createGenerationClientCore } from "../src/media/core.js";
import type { MediaAdapter } from "../src/media/internal.js";
import {
  createImageGenerationClient,
  createSpeechSynthesisClient,
  type AudioStreamEvent,
  type GenerationEvent,
  type GenerationJob,
  type GenerationOutput,
  type GenerationState,
  type GenerationTarget,
  type ImageGenerationInput,
  type LappProfile,
  type SpeechSynthesisInput,
} from "../src/index.js";

interface FixtureContext {
  providerId: string;
  baseUrl: string;
  model: string;
  auth: { type: "none" };
  requestHeaders: Record<string, string>;
}

interface ExpectedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

interface ImageFixture {
  protocol: "openai-images";
  context: FixtureContext;
  request: {
    input: ImageGenerationInput & { operation: "image-generation" };
    expected: ExpectedRequest;
  };
  response: { upstream: unknown; expected: unknown };
}

interface SpeechFixture {
  protocol: "openai-audio-speech";
  context: FixtureContext;
  request: {
    input: SpeechSynthesisInput & { operation: "text-to-speech" };
    expected: ExpectedRequest;
  };
  response: {
    upstream: { headers: Record<string, string>; bodyBase64: string };
    expected: unknown;
  };
}

interface CapturedRequest {
  url: string;
  init: RequestInit;
}

interface FixtureOutput {
  parts: Array<
    | { type: "text"; text: string }
    | {
        type: "artifact";
        artifact: {
          kind: "image" | "video" | "audio";
          mediaType: string;
          duration?: number;
          source: { type: "inline"; dataBase64: string };
        };
      }
  >;
}

interface GenerationFixture {
  lifecycle: {
    target: GenerationTarget<"video-generation">;
    job: GenerationJob<"video-generation">;
    states: [
      { status: "queued"; retryAfterMs?: number },
      { status: "running"; progress?: number; retryAfterMs?: number },
      { status: "succeeded"; output: FixtureOutput },
    ];
    expectedEventKinds: Array<GenerationEvent<"video-generation">["kind"]>;
  };
  failure: {
    state: {
      status: "failed";
      failure: { code: "PROVIDER_FAILED"; message: string; retryable?: boolean };
    };
    expectedEventKind: "failed";
  };
  wait: {
    pollIntervalMs: number;
    timeoutMs: number;
    expectedTimeoutCode: "WAIT_TIMEOUT";
  };
  stream: {
    events: Array<
      | { kind: "audio"; dataBase64: string }
      | { kind: "finish"; mediaType: string }
    >;
  };
  redaction: {
    sensitiveValue: string;
    upstreamMessage: string;
    expectedCode: "HTTP_STATUS";
    mustNotContain: string;
  };
}

const conformanceDirectory = fileURLToPath(new URL("../conformance/", import.meta.url));
const fixtureDirectory = `${conformanceDirectory}sdk-v1/`;

function readFixture<T>(name: string): T {
  return JSON.parse(fs.readFileSync(`${fixtureDirectory}${name}`, "utf8")) as T;
}

function fixtureOutput(raw: FixtureOutput): GenerationOutput {
  return {
    parts: raw.parts.map((part) => {
      if (part.type === "text") return part;
      return {
        type: "artifact" as const,
        artifact: {
          kind: part.artifact.kind,
          mediaType: part.artifact.mediaType,
          ...(part.artifact.duration === undefined ? {} : { duration: part.artifact.duration }),
          source: {
            type: "inline" as const,
            data: Buffer.from(part.artifact.source.dataBase64, "base64"),
          },
        },
      };
    }),
  };
}

function profile(
  operation: "image-generation" | "text-to-speech",
  protocol: string,
  context: FixtureContext,
): LappProfile {
  return {
    global: {
      schemaVersion: "1.0",
      defaults: {
        [operation]: { providerId: context.providerId, modelId: context.model },
      },
    },
    providers: [{
      config: {
        schemaVersion: "1.0",
        id: context.providerId,
        baseUrl: context.baseUrl,
        protocols: [protocol],
        auth: context.auth,
        requestHeaders: context.requestHeaders,
      },
      models: {
        schemaVersion: "1.0",
        models: [{ id: context.model, protocols: [protocol], capabilities: [operation] }],
      },
    }],
  };
}

function normalizedHeaders(value: HeadersInit | undefined): Record<string, string> {
  return Object.fromEntries(
    [...new Headers(value).entries()].sort(([left], [right]) => left.localeCompare(right)),
  );
}

function expectRequest(captured: CapturedRequest, expected: ExpectedRequest): void {
  expect(captured.url).toBe(expected.url);
  expect(captured.init.method).toBe(expected.method);
  expect(normalizedHeaders(captured.init.headers)).toEqual(normalizedHeaders(expected.headers));
  expect(JSON.parse(String(captured.init.body))).toEqual(expected.body);
}

function serializableState(state: GenerationState): unknown {
  if (state.status !== "succeeded") return state;
  return {
    ...state,
    output: {
      ...state.output,
      parts: state.output.parts.map((part) => {
        if (part.type !== "artifact" || part.artifact.source.type !== "inline") return part;
        return {
          ...part,
          artifact: {
            ...part.artifact,
            source: {
              type: "inline",
              dataBase64: Buffer.from(part.artifact.source.data).toString("base64"),
            },
          },
        };
      }),
    },
  };
}

describe("canonical media SDK conformance", () => {
  it("matches openai-images request and normalized output", async () => {
    const fixture = readFixture<ImageFixture>("openai-images.json");
    let captured: CapturedRequest | undefined;
    const client = createImageGenerationClient({
      profile: profile("image-generation", fixture.protocol, fixture.context),
      fetchImpl: async (input, init = {}) => {
        captured = { url: String(input), init };
        return new Response(JSON.stringify(fixture.response.upstream), {
          headers: { "content-type": "application/json" },
        });
      },
    });
    const { operation: _operation, ...input } = fixture.request.input;
    const state = await client.generate(input);
    expect(captured).toBeDefined();
    expectRequest(captured!, fixture.request.expected);
    expect(serializableState(state)).toEqual(fixture.response.expected);
  });

  it("matches openai-audio-speech request and normalized output", async () => {
    const fixture = readFixture<SpeechFixture>("openai-audio-speech.json");
    let captured: CapturedRequest | undefined;
    const client = createSpeechSynthesisClient({
      profile: profile("text-to-speech", fixture.protocol, fixture.context),
      fetchImpl: async (input, init = {}) => {
        captured = { url: String(input), init };
        return new Response(Buffer.from(fixture.response.upstream.bodyBase64, "base64"), {
          headers: fixture.response.upstream.headers,
        });
      },
    });
    const { operation: _operation, ...input } = fixture.request.input;
    const state = await client.synthesize(input);
    expect(captured).toBeDefined();
    expectRequest(captured!, fixture.request.expected);
    expect(serializableState(state)).toEqual(fixture.response.expected);
  });

  it("matches the shared job lifecycle, timeout, multipart, and stream fixture", async () => {
    const fixture = JSON.parse(fs.readFileSync(
      `${conformanceDirectory}generation-v1.json`,
      "utf8",
    )) as GenerationFixture;
    const fakeProfile: LappProfile = {
      global: {
        schemaVersion: "1.0",
        defaults: {
          "video-generation": {
            providerId: fixture.lifecycle.target.provider,
            modelId: fixture.lifecycle.target.model,
          },
          "music-generation": {
            providerId: fixture.lifecycle.target.provider,
            modelId: fixture.lifecycle.target.model,
          },
        },
      },
      providers: [{
        config: {
          schemaVersion: "1.0",
          id: fixture.lifecycle.target.provider,
          baseUrl: "https://fixture.example/v1",
          protocols: [fixture.lifecycle.target.protocol],
          auth: { type: "none" },
        },
        models: {
          schemaVersion: "1.0",
          models: [{
            id: fixture.lifecycle.target.model,
            capabilities: ["video-generation", "music-generation"],
          }],
        },
      }],
    };
    let pollIndex = 1;
    let hanging = false;
    const videoAdapter: MediaAdapter<{}, "video-generation"> = {
      protocol: fixture.lifecycle.target.protocol,
      operation: "video-generation",
      features: { jobs: true, streaming: false },
      async submit() {
        const queued = fixture.lifecycle.states[0];
        return {
          status: "queued",
          target: fixture.lifecycle.target,
          job: fixture.lifecycle.job,
          ...(queued.retryAfterMs === undefined ? {} : { retryAfterMs: queued.retryAfterMs }),
        };
      },
      async poll() {
        if (hanging) await new Promise<never>(() => {});
        const next = fixture.lifecycle.states[pollIndex++];
        if (next.status === "running") {
          return {
            status: "running",
            target: fixture.lifecycle.target,
            job: fixture.lifecycle.job,
            ...(next.progress === undefined ? {} : { progress: next.progress }),
            ...(next.retryAfterMs === undefined ? {} : { retryAfterMs: next.retryAfterMs }),
          };
        }
        return {
          status: "succeeded",
          target: fixture.lifecycle.target,
          job: fixture.lifecycle.job,
          output: fixtureOutput(next.output),
        };
      },
    };
    const video = createGenerationClientCore(
      { profile: fakeProfile },
      "video-generation",
      "video-generation",
      { [fixture.lifecycle.target.protocol]: videoAdapter },
    );

    vi.useFakeTimers();
    try {
      const events: GenerationEvent<"video-generation">[] = [];
      const waiting = video.wait(await video.generate({}), {
        pollIntervalMs: fixture.wait.pollIntervalMs,
        timeoutMs: 5_000,
        onEvent: (event) => events.push(event),
      });
      await vi.advanceTimersByTimeAsync(1_000);
      const terminal = await waiting;
      expect(events.map((event) => event.kind)).toEqual(fixture.lifecycle.expectedEventKinds);
      expect(serializableState(terminal)).toEqual({
        status: "succeeded",
        target: fixture.lifecycle.target,
        job: fixture.lifecycle.job,
        output: fixture.lifecycle.states[2].output,
      });

      const failedEvents: GenerationEvent<"video-generation">[] = [];
      const failed = await video.wait({
        status: "failed",
        target: fixture.lifecycle.target,
        job: fixture.lifecycle.job,
        failure: fixture.failure.state.failure,
      }, { onEvent: (event) => failedEvents.push(event) });
      expect(failed.status).toBe("failed");
      expect(failedEvents.map((event) => event.kind)).toEqual([fixture.failure.expectedEventKind]);

      hanging = true;
      const timeout = video.wait(await video.generate({}), {
        pollIntervalMs: fixture.wait.pollIntervalMs,
        timeoutMs: fixture.wait.timeoutMs,
      });
      const timeoutAssertion = expect(timeout).rejects.toMatchObject({
        code: fixture.wait.expectedTimeoutCode,
      });
      await vi.advanceTimersByTimeAsync(fixture.wait.timeoutMs);
      await timeoutAssertion;
    } finally {
      vi.useRealTimers();
    }

    const musicTarget: GenerationTarget<"music-generation"> = {
      ...fixture.lifecycle.target,
      operation: "music-generation",
    };
    const musicAdapter: MediaAdapter<{}, "music-generation"> = {
      protocol: fixture.lifecycle.target.protocol,
      operation: "music-generation",
      features: { jobs: false, streaming: true },
      async submit() {
        return { status: "succeeded", target: musicTarget, output: { parts: [] } };
      },
      async *stream() {
        for (const event of fixture.stream.events) {
          yield event.kind === "audio"
            ? { kind: "audio", bytes: Buffer.from(event.dataBase64, "base64") }
            : event;
        }
      },
    };
    const music = createGenerationClientCore(
      { profile: fakeProfile },
      "music-generation",
      "music-generation",
      { [fixture.lifecycle.target.protocol]: musicAdapter },
    );
    const streamEvents: AudioStreamEvent[] = [];
    for await (const event of music.stream({})) streamEvents.push(event);
    expect(streamEvents.map((event) => event.kind === "audio"
      ? { kind: "audio", dataBase64: Buffer.from(event.bytes).toString("base64") }
      : event
    )).toEqual(fixture.stream.events);
  });

  it("matches the shared HTTP error redaction fixture", async () => {
    const fixture = JSON.parse(fs.readFileSync(
      `${conformanceDirectory}generation-v1.json`,
      "utf8",
    )) as GenerationFixture;
    const context: FixtureContext = {
      providerId: "fixture-provider",
      baseUrl: "https://fixture.example/v1",
      model: "fixture-image-model",
      auth: { type: "none" },
      requestHeaders: {},
    };
    const redactionProfile = profile("image-generation", "openai-images", context);
    redactionProfile.providers[0]!.config.auth = {
      type: "bearer",
      secret: fixture.redaction.sensitiveValue,
    };
    const client = createImageGenerationClient({
      profile: redactionProfile,
      fetchImpl: async () => new Response(fixture.redaction.upstreamMessage, { status: 400 }),
    });
    let error: unknown;
    try {
      await client.generate({ prompt: "fixture error" });
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: fixture.redaction.expectedCode });
    expect(String(error)).not.toContain(fixture.redaction.mustNotContain);
  });
});
