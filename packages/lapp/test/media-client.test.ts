import { describe, expect, it, vi } from "vitest";
import { createGenerationClientCore } from "../src/media/core.js";
import type { MediaAdapter } from "../src/media/internal.js";
import {
  GenerationClientError,
  createImageGenerationClient,
  createMusicGenerationClient,
  createSpeechSynthesisClient,
  createVideoGenerationClient,
  type GenerationArtifact,
  type GenerationEvent,
} from "../src/media/index.js";
import { listModels } from "../src/connection.js";
import { upsertProvider } from "../src/manage/index.js";
import type { AuthConfig, LappProfile } from "../src/types.js";

function profile(
  operation: string,
  protocol: string,
  auth: AuthConfig = { type: "bearer", secret: "test-secret-value" },
  options: {
    protocols?: string[];
    modelProtocols?: string[];
    baseUrl?: string;
    requestHeaders?: Record<string, string>;
    capabilities?: string[];
    providerType?: string;
  } = {},
): LappProfile {
  return {
    global: {
      schemaVersion: "1.0",
      defaults: { [operation]: { providerId: "provider-1", modelId: "model-1" } },
    },
    providers: [{
      config: {
        schemaVersion: "1.0",
        id: "provider-1",
        ...(options.providerType ? { providerType: options.providerType } : {}),
        baseUrl: options.baseUrl ?? "https://provider.example/v1?tenant=one",
        protocols: options.protocols ?? [protocol],
        auth,
        ...(options.requestHeaders ? { requestHeaders: options.requestHeaders } : {}),
      },
      models: {
        schemaVersion: "1.0",
        models: [{
          id: "model-1",
          ...(options.modelProtocols ? { protocols: options.modelProtocols } : {}),
          ...(options.capabilities ? { capabilities: options.capabilities } : {}),
        }],
      },
    }],
  };
}

describe("generation clients", () => {
  it("selects the first supported image protocol and preserves ordered image parts", async () => {
    let capturedUrl = "";
    let captured: RequestInit | undefined;
    const client = createImageGenerationClient({
      profile: profile("image-generation", "openai-images", undefined, {
        protocols: ["unsupported-images", "openai-images"],
        providerType: "intentionally-ignored",
      }),
      fetchImpl: async (input, init) => {
        capturedUrl = String(input);
        captured = init;
        return new Response(JSON.stringify({
          created: 123,
          output_format: "png",
          data: [{ revised_prompt: "a safer prompt", b64_json: "aGk=" }],
        }), { status: 200, headers: { "content-type": "application/json" } });
      },
    });

    const state = await client.generate({
      prompt: "draw a fox",
      size: { width: 1024, height: 1024 },
      count: 1,
      outputFormat: "png",
      extra: { quality: "high" },
    });

    expect(client.protocol).toBe("openai-images");
    const url = new URL(capturedUrl);
    expect(url.pathname).toBe("/v1/images/generations");
    expect(url.searchParams.get("tenant")).toBe("one");
    expect(captured?.redirect).toBe("error");
    expect(captured?.headers).toMatchObject({ Authorization: "Bearer test-secret-value" });
    expect(JSON.parse(String(captured?.body))).toEqual({
      model: "model-1",
      prompt: "draw a fox",
      n: 1,
      size: "1024x1024",
      output_format: "png",
      quality: "high",
    });
    expect(state.status).toBe("succeeded");
    if (state.status !== "succeeded") throw new Error("expected succeeded state");
    expect(state.output.parts[0]).toEqual({ type: "text", text: "a safer prompt" });
    const part = state.output.parts[1];
    expect(part?.type).toBe("artifact");
    if (part?.type !== "artifact" || part.artifact.source.type !== "inline") {
      throw new Error("expected inline artifact");
    }
    expect(part.artifact.kind).toBe("image");
    expect(part.artifact.mediaType).toBe("image/png");
    expect([...part.artifact.source.data]).toEqual([104, 105]);
  });

  it("preserves providerType as metadata without using it for protocol resolution", () => {
    const original = profile("image-generation", "openai-images", { type: "none" }, {
      protocols: ["unsupported-images", "openai-images"],
      providerType: "reference-family",
    });
    expect(listModels(original)[0]?.providerType).toBe("reference-family");

    const patched = upsertProvider(original, { id: "provider-1", enabled: false });
    expect(patched.providers[0]?.config.providerType).toBe("reference-family");
    const changed = upsertProvider(original, { id: "provider-1", providerType: "another.family" });
    expect(changed.providers[0]?.config.providerType).toBe("another.family");
  });

  it("keeps routing, request shape, and errors invariant across providerType changes", async () => {
    const variants = [undefined, "family-one", "family-two"] as const;
    const successes = [];
    for (const providerType of variants) {
      let request: { url: string; init?: RequestInit } | undefined;
      const client = createImageGenerationClient({
        profile: profile("image-generation", "openai-images", { type: "none" }, {
          protocols: ["future-images", "openai-images"],
          ...(providerType === undefined ? {} : { providerType }),
        }),
        fetchImpl: async (input, init) => {
          request = { url: String(input), init };
          return new Response(JSON.stringify({ data: [{ b64_json: "aGk=" }] }), {
            headers: { "content-type": "application/json" },
          });
        },
      });
      const state = await client.generate({ prompt: "same request" });
      successes.push({
        protocol: client.protocol,
        url: request?.url,
        method: request?.init?.method,
        headers: request?.init?.headers,
        body: request?.init?.body,
        state,
      });
    }
    expect(successes[1]).toEqual(successes[0]);
    expect(successes[2]).toEqual(successes[0]);

    const errors = variants.map((providerType) => {
      try {
        createVideoGenerationClient({
          profile: profile("video-generation", "future-video", { type: "none" }, {
            capabilities: ["video-generation"],
            ...(providerType === undefined ? {} : { providerType }),
          }),
        });
        return "NO_ERROR";
      } catch (error) {
        return (error as { code?: string }).code;
      }
    });
    expect(errors).toEqual([
      "PROTOCOL_NOT_SUPPORTED",
      "PROTOCOL_NOT_SUPPORTED",
      "PROTOCOL_NOT_SUPPORTED",
    ]);
  });

  it("parses OpenAI image URLs as unauthenticated artifacts", async () => {
    const client = createImageGenerationClient({
      profile: profile("image-generation", "openai-images"),
      fetchImpl: async () => new Response(JSON.stringify({
        data: [{ url: "https://cdn.example/result.jpeg?signature=abc" }],
      }), { headers: { "content-type": "application/json" } }),
    });
    const state = await client.generate({ prompt: "draw" });
    if (state.status !== "succeeded") throw new Error("expected succeeded state");
    const part = state.output.parts[0];
    if (part?.type !== "artifact") throw new Error("expected artifact");
    expect(part.artifact).toMatchObject({
      kind: "image",
      mediaType: "image/jpeg",
      source: { type: "url", auth: "none" },
    });
  });

  it("preserves multiple image results and rejects malformed payloads", async () => {
    let response: unknown = {
      data: [
        { b64_json: "aGk=" },
        { url: "https://cdn.example/second.webp" },
      ],
    };
    const client = createImageGenerationClient({
      profile: profile("image-generation", "openai-images"),
      fetchImpl: async () => new Response(JSON.stringify(response), {
        headers: { "content-type": "application/json" },
      }),
    });

    const state = await client.generate({ prompt: "draw two" });
    if (state.status !== "succeeded") throw new Error("expected succeeded state");
    expect(state.output.parts).toHaveLength(2);
    expect(state.output.parts.map((part) =>
      part.type === "artifact" ? part.artifact.source.type : part.type
    )).toEqual(["inline", "url"]);

    response = { data: [{}] };
    await expect(client.generate({ prompt: "malformed" })).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });

    response = { data: [{ url: "https://user:pass@cdn.example/image.png#fragment" }] };
    await expect(client.generate({ prompt: "unsafe URL" })).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
  });

  it("rejects unsupported and reserved image fields before network access", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const client = createImageGenerationClient({
      profile: profile("image-generation", "openai-images"),
      fetchImpl,
    });
    await expect(client.generate({ prompt: "draw", seed: 1 })).rejects.toMatchObject({
      code: "OPTION_NOT_SUPPORTED",
    });
    await expect(client.generate({ prompt: "draw", extra: { model: "override" } })).rejects.toMatchObject({
      code: "INVALID_GENERATION_INPUT",
    });
    await expect(client.generate({ prompt: "draw", extra: { custom_knob: true } })).rejects.toMatchObject({
      code: "OPTION_NOT_SUPPORTED",
    });
    await expect(client.generate({ prompt: "draw", outputFormat: "gif" })).rejects.toMatchObject({
      code: "OPTION_NOT_SUPPORTED",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("enforces explicit model capabilities before credential or network access", () => {
    const resolver = {
      resolve: vi.fn(async () => "secret"),
      status: vi.fn(async () => ({ scheme: "plaintext" as const, available: true })),
    };
    const fetchImpl = vi.fn<typeof fetch>();
    expect(() => createImageGenerationClient({
      profile: profile("image-generation", "openai-images", undefined, {
        capabilities: ["chat"],
      }),
      resolver,
      fetchImpl,
    })).toThrow(expect.objectContaining({ code: "OPERATION_NOT_SUPPORTED" }));
    expect(() => createImageGenerationClient({
      profile: profile("image-generation", "openai-images", undefined, {
        capabilities: [],
      }),
      resolver,
      fetchImpl,
    })).toThrow(expect.objectContaining({ code: "OPERATION_NOT_SUPPORTED" }));
    expect(resolver.resolve).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("synthesizes and streams real OpenAI audio bytes", async () => {
    const bodies: unknown[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(new Uint8Array([1, 2, 3]), {
        headers: { "content-type": "audio/mpeg" },
      });
    };
    const client = createSpeechSynthesisClient({
      profile: profile("text-to-speech", "openai-audio-speech"),
      fetchImpl,
    });

    const state = await client.synthesize({
      text: "hello",
      voice: "alloy",
      speed: 1.25,
      outputFormat: "mp3",
    });
    expect(state.status).toBe("succeeded");
    if (state.status !== "succeeded") throw new Error("expected succeeded state");
    expect(state.output.parts[0]).toMatchObject({
      type: "artifact",
      artifact: { kind: "audio", mediaType: "audio/mpeg" },
    });

    const events = [];
    for await (const event of client.stream({ text: "hello", voice: "alloy" })) events.push(event);
    expect(events).toEqual([
      { kind: "audio", bytes: new Uint8Array([1, 2, 3]) },
      { kind: "finish", mediaType: "audio/mpeg" },
    ]);
    expect(bodies[0]).toEqual({
      model: "model-1",
      input: "hello",
      voice: "alloy",
      speed: 1.25,
      response_format: "mp3",
    });

    await expect(client.synthesize({
      text: "hello",
      voice: "alloy",
      language: "zh-CN",
    })).rejects.toMatchObject({ code: "OPTION_NOT_SUPPORTED" });
    await expect(client.synthesize({
      text: "hello",
      voice: "alloy",
      language: "   ",
    })).rejects.toMatchObject({ code: "INVALID_GENERATION_INPUT" });
    await expect(client.synthesize({
      text: "hello",
      voice: "alloy",
      outputFormat: "ogg",
    })).rejects.toMatchObject({ code: "OPTION_NOT_SUPPORTED" });
    await expect(client.synthesize({
      text: "hello",
      voice: "alloy",
      extra: { custom_knob: true },
    })).rejects.toMatchObject({ code: "OPTION_NOT_SUPPORTED" });
  });

  it("reports interrupted speech streams and cancels local consumption", async () => {
    const cancelled = vi.fn();
    let call = 0;
    const client = createSpeechSynthesisClient({
      profile: profile("text-to-speech", "openai-audio-speech"),
      fetchImpl: async () => {
        call += 1;
        if (call === 1) {
          return new Response(new ReadableStream<Uint8Array>({
            start(controller) {
              controller.error(new Error("socket interrupted"));
            },
          }), { headers: { "content-type": "audio/mpeg" } });
        }
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([7, 8]));
          },
          cancel: cancelled,
        }), { headers: { "content-type": "audio/mpeg" } });
      },
    });

    await expect((async () => {
      for await (const _event of client.stream({ text: "hello", voice: "alloy" })) {
        // The interrupted stream does not yield a terminal event.
      }
    })()).rejects.toMatchObject({ code: "HTTP_REQUEST_FAILED" });

    for await (const event of client.stream({ text: "hello", voice: "alloy" })) {
      expect(event).toEqual({ kind: "audio", bytes: new Uint8Array([7, 8]) });
      break;
    }
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it("rejects video and music protocols before credential resolution or network access", () => {
    const resolver = {
      resolve: vi.fn(async () => "secret"),
      status: vi.fn(async () => ({ scheme: "plaintext" as const, available: true })),
    };
    const fetchImpl = vi.fn<typeof fetch>();
    expect(() => createVideoGenerationClient({
      profile: profile("video-generation", "openai-videos"),
      resolver,
      fetchImpl,
    })).toThrow(expect.objectContaining({ code: "PROTOCOL_NOT_SUPPORTED" }));
    expect(() => createMusicGenerationClient({
      profile: profile("music-generation", "openai-music"),
      resolver,
      fetchImpl,
    })).toThrow(expect.objectContaining({ code: "PROTOCOL_NOT_SUPPORTED" }));
    expect(resolver.resolve).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("waits through queued and running fake adapter states", async () => {
    let polls = 0;
    const fake: MediaAdapter<{ signal?: AbortSignal }, "video-generation"> = {
      protocol: "fake-video",
      operation: "video-generation",
      features: { jobs: true, streaming: false },
      async submit(_input, ctx) {
        const job = {
          id: "job-1",
          operation: "video-generation" as const,
          provider: ctx.providerId,
          model: ctx.model,
          protocol: ctx.protocol,
        };
        return {
          status: "queued",
          target: {
            provider: ctx.providerId,
            model: ctx.model,
            protocol: ctx.protocol,
            operation: "video-generation",
          },
          job,
        };
      },
      async poll(job, ctx) {
        polls += 1;
        if (polls === 1) {
          return {
            status: "running",
            target: {
              provider: ctx.providerId,
              model: ctx.model,
              protocol: ctx.protocol,
              operation: "video-generation",
            },
            job,
            progress: 0.5,
          };
        }
        return {
          status: "succeeded",
          target: {
            provider: ctx.providerId,
            model: ctx.model,
            protocol: ctx.protocol,
            operation: "video-generation",
          },
          job,
          output: { parts: [{ type: "text", text: "done" }] },
        };
      },
    };
    const core = createGenerationClientCore(
      { profile: profile("video-generation", "fake-video", { type: "none" }) },
      "video-generation",
      "video-generation",
      { "fake-video": fake },
    );
    const events: GenerationEvent<"video-generation">[] = [];
    vi.useFakeTimers();
    try {
      const initial = await core.generate({});
      const waiting = core.wait(initial, {
        pollIntervalMs: 500,
        timeoutMs: 5_000,
        onEvent: (event) => events.push(event),
      });
      await vi.advanceTimersByTimeAsync(1_000);
      const terminal = await waiting;
      expect(terminal.status).toBe("succeeded");
      expect(events.map((event) => event.kind)).toEqual(["queued", "running", "succeeded"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("normalizes failed jobs, provider wait hints, and wait timeouts", async () => {
    let mode: "failed" | "running" | "hanging" = "failed";
    let polls = 0;
    const fake: MediaAdapter<{}, "video-generation"> = {
      protocol: "fake-video",
      operation: "video-generation",
      features: { jobs: true, streaming: false },
      async submit(_input, ctx) {
        const job = {
          id: `job-${mode}`,
          operation: "video-generation" as const,
          provider: ctx.providerId,
          model: ctx.model,
          protocol: ctx.protocol,
        };
        return {
          status: "queued",
          target: {
            provider: ctx.providerId,
            model: ctx.model,
            protocol: ctx.protocol,
            operation: "video-generation",
          },
          job,
          retryAfterMs: 1,
        };
      },
      async poll(job, ctx) {
        polls += 1;
        const target = {
          provider: ctx.providerId,
          model: ctx.model,
          protocol: ctx.protocol,
          operation: "video-generation" as const,
        };
        if (mode === "failed") {
          return {
            status: "failed",
            target,
            job,
            failure: { code: "PROVIDER_FAILED", message: "render failed" },
          };
        }
        if (mode === "hanging") {
          await new Promise<never>(() => {});
        }
        return {
          status: "running",
          target,
          job,
          progress: 0.25,
          retryAfterMs: 99_999,
        };
      },
    };
    const core = createGenerationClientCore(
      { profile: profile("video-generation", "fake-video", { type: "none" }) },
      "video-generation",
      "video-generation",
      { "fake-video": fake },
    );

    vi.useFakeTimers();
    try {
      const events: GenerationEvent<"video-generation">[] = [];
      const failedWait = core.wait(await core.generate({}), {
        timeoutMs: 5_000,
        onEvent: (event) => events.push(event),
      });
      await vi.advanceTimersByTimeAsync(500);
      await expect(failedWait).resolves.toMatchObject({ status: "failed" });
      expect(events.map((event) => event.kind)).toEqual(["queued", "failed"]);

      mode = "running";
      polls = 0;
      const timeoutWait = core.wait(await core.generate({}), { timeoutMs: 600 });
      const timeoutAssertion = expect(timeoutWait).rejects.toMatchObject({ code: "WAIT_TIMEOUT" });
      await vi.advanceTimersByTimeAsync(499);
      expect(polls).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(polls).toBe(1);
      await vi.advanceTimersByTimeAsync(100);
      await timeoutAssertion;

      mode = "hanging";
      polls = 0;
      const hangingWait = core.wait(await core.generate({}), { timeoutMs: 600 });
      const hangingAssertion = expect(hangingWait).rejects.toMatchObject({ code: "WAIT_TIMEOUT" });
      await vi.advanceTimersByTimeAsync(600);
      await hangingAssertion;
      expect(polls).toBe(1);

      const controller = new AbortController();
      const abortedWait = core.wait(await core.generate({}), {
        timeoutMs: 5_000,
        signal: controller.signal,
      });
      const abortedAssertion = expect(abortedWait).rejects.toMatchObject({ name: "AbortError" });
      await vi.advanceTimersByTimeAsync(500);
      controller.abort(new DOMException("local stop", "AbortError"));
      await abortedAssertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("normalizes fake music multi-part output and stream events", async () => {
    const fake: MediaAdapter<{}, "music-generation"> = {
      protocol: "fake-music",
      operation: "music-generation",
      features: { jobs: false, streaming: true },
      async submit(_input, ctx) {
        return {
          status: "succeeded",
          target: {
            provider: ctx.providerId,
            model: ctx.model,
            protocol: ctx.protocol,
            operation: "music-generation",
          },
          output: {
            parts: [
              { type: "text", text: "verse one" },
              {
                type: "artifact",
                artifact: {
                  kind: "audio",
                  mediaType: "audio/mpeg",
                  source: { type: "inline", data: new Uint8Array([3, 4]) },
                },
              },
            ],
          },
        };
      },
      async *stream() {
        yield { kind: "audio", bytes: new Uint8Array([3]) };
        yield { kind: "audio", bytes: new Uint8Array([4]) };
        yield { kind: "finish", mediaType: "audio/mpeg" };
      },
    };
    const core = createGenerationClientCore(
      { profile: profile("music-generation", "fake-music", { type: "none" }) },
      "music-generation",
      "music-generation",
      { "fake-music": fake },
    );

    const state = await core.generate({});
    if (state.status !== "succeeded") throw new Error("expected succeeded state");
    expect(state.output.parts.map((part) => part.type)).toEqual(["text", "artifact"]);
    const events = [];
    for await (const event of core.stream({})) events.push(event);
    expect(events).toEqual([
      { kind: "audio", bytes: new Uint8Array([3]) },
      { kind: "audio", bytes: new Uint8Array([4]) },
      { kind: "finish", mediaType: "audio/mpeg" },
    ]);
  });

  it("rejects forged jobs without polling", async () => {
    const fake: MediaAdapter<{}, "image-generation"> = {
      protocol: "fake-image",
      operation: "image-generation",
      features: { jobs: true, streaming: false },
      async submit(_input, ctx) {
        return {
          status: "succeeded",
          target: {
            provider: ctx.providerId,
            model: ctx.model,
            protocol: ctx.protocol,
            operation: "image-generation",
          },
          output: { parts: [] },
        };
      },
      poll: vi.fn(),
    };
    const core = createGenerationClientCore(
      { profile: profile("image-generation", "fake-image", { type: "none" }) },
      "image-generation",
      "image-generation",
      { "fake-image": fake },
    );
    await expect(core.poll({
      id: "job",
      operation: "image-generation",
      provider: "other-provider",
      model: "model-1",
      protocol: "fake-image",
    })).rejects.toMatchObject({ code: "GENERATION_JOB_INVALID" });
    expect(fake.poll).not.toHaveBeenCalled();
  });

  it("downloads inline and signed URL artifacts with explicit limits and no provider headers", async () => {
    let captured: RequestInit | undefined;
    const client = createImageGenerationClient({
      profile: profile("image-generation", "openai-images", undefined, {
        requestHeaders: { "X-Tenant": "private-tenant" },
      }),
      fetchImpl: async (_input, init) => {
        captured = init;
        return new Response(new Uint8Array([4, 5]));
      },
    });
    const inline: GenerationArtifact = {
      kind: "image",
      mediaType: "image/png",
      source: { type: "inline", data: new Uint8Array([1, 2, 3]) },
    };
    await expect(client.downloadArtifact(inline, { maxBytes: 2 })).rejects.toMatchObject({
      code: "ARTIFACT_TOO_LARGE",
    });
    const copied = await client.downloadArtifact(inline, { maxBytes: 3 });
    expect([...copied]).toEqual([1, 2, 3]);
    expect(copied).not.toBe(inline.source.type === "inline" ? inline.source.data : undefined);

    const downloaded = await client.downloadArtifact({
      kind: "image",
      mediaType: "image/png",
      source: { type: "url", url: "https://cdn.example/image.png?sig=one", auth: "none" },
    }, { maxBytes: 10 });
    expect([...downloaded]).toEqual([4, 5]);
    expect(captured?.headers).toEqual({});
    expect(captured?.redirect).toBe("error");
  });

  it("attaches provider auth only to same-origin artifact URLs", async () => {
    let capturedUrl = "";
    let captured: RequestInit | undefined;
    const fetchImpl: typeof fetch = async (input, init) => {
      capturedUrl = String(input);
      captured = init;
      return new Response(new Uint8Array([9]));
    };
    const client = createImageGenerationClient({
      profile: profile("image-generation", "openai-images", {
        type: "query",
        name: "api_key",
        secret: "secret query",
      }),
      fetchImpl,
    });
    await client.downloadArtifact({
      kind: "image",
      mediaType: "image/png",
      source: { type: "url", url: "https://provider.example/file/1", auth: "provider" },
    }, { maxBytes: 10 });
    expect(new URL(capturedUrl).searchParams.get("api_key")).toBe("secret query");
    expect(captured?.redirect).toBe("error");

    const callsBefore = capturedUrl;
    await expect(client.downloadArtifact({
      kind: "image",
      mediaType: "image/png",
      source: { type: "url", url: "https://cdn.example/file/1", auth: "provider" },
    }, { maxBytes: 10 })).rejects.toMatchObject({ code: "VAULT_BINDING_MISMATCH" });
    expect(capturedUrl).toBe(callsBefore);
  });

  it("rejects expired and oversized URL artifacts", async () => {
    const client = createImageGenerationClient({
      profile: profile("image-generation", "openai-images"),
      fetchImpl: async () => new Response(new Uint8Array([1, 2, 3]), {
        headers: { "content-length": "3" },
      }),
    });
    await expect(client.downloadArtifact({
      kind: "image",
      mediaType: "image/png",
      source: {
        type: "url",
        url: "https://cdn.example/file",
        auth: "none",
        expiresAt: "2000-01-01T00:00:00Z",
      },
    }, { maxBytes: 10 })).rejects.toMatchObject({ code: "ARTIFACT_EXPIRED" });
    await expect(client.downloadArtifact({
      kind: "image",
      mediaType: "image/png",
      source: { type: "url", url: "https://cdn.example/file", auth: "none" },
    }, { maxBytes: 2 })).rejects.toMatchObject({ code: "ARTIFACT_TOO_LARGE" });
  });

  it("redacts provider error bodies", async () => {
    const client = createImageGenerationClient({
      profile: profile("image-generation", "openai-images"),
      fetchImpl: async () => new Response("credential test-secret-value rejected", { status: 400 }),
    });
    let error: unknown;
    try {
      await client.generate({ prompt: "draw" });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(GenerationClientError);
    expect(String(error)).not.toContain("test-secret-value");
    expect(error).toMatchObject({ code: "HTTP_STATUS", status: 400 });
  });
});
