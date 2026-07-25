import type { AdapterContext } from "../client/adapter.js";
import { appendUrlPath } from "../client/http.js";
import type { MediaAdapter, MediaTransport } from "./internal.js";
import {
  GenerationClientError,
  type AudioStreamEvent,
  type GenerationState,
  type SpeechSynthesisInput,
} from "./types.js";

const OUTPUT_FORMATS = new Set(["mp3", "opus", "aac", "flac", "wav", "pcm"]);
const RESERVED_FIELDS = new Set([
  "model",
  "input",
  "voice",
  "speed",
  "instructions",
  "response_format",
  "stream",
  "stream_format",
  "authorization",
  "api_key",
  "apikey",
  "x-api-key",
]);

function invalid(message: string): GenerationClientError {
  return new GenerationClientError("INVALID_GENERATION_INPUT", message);
}

function assertSafeExtra(extra: Record<string, unknown> | undefined): void {
  for (const key of Object.keys(extra ?? {})) {
    if (RESERVED_FIELDS.has(key.toLowerCase())) {
      throw invalid(`extra field is reserved: ${key}`);
    }
    throw new GenerationClientError(
      "OPTION_NOT_SUPPORTED",
      `openai-audio-speech does not support extra field: ${key}`,
    );
  }
}

function normalizedFormat(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const format = value.trim().toLowerCase();
  if (!format) throw invalid("outputFormat must not be empty");
  const normalized = format === "m4a" ? "aac" : format;
  if (!OUTPUT_FORMATS.has(normalized)) {
    throw new GenerationClientError(
      "OPTION_NOT_SUPPORTED",
      `openai-audio-speech does not support outputFormat: ${value}`,
    );
  }
  return normalized;
}

function mediaType(format: string | undefined, header: string | null): string {
  const fromHeader = header?.split(";", 1)[0]?.trim().toLowerCase();
  if (fromHeader && /^audio\/[!#$%&'*+.^_`|~0-9a-z-]+$/.test(fromHeader)) return fromHeader;
  switch (format) {
    case "opus": return "audio/opus";
    case "aac": return "audio/aac";
    case "flac": return "audio/flac";
    case "wav": return "audio/wav";
    case "pcm": return "audio/pcm";
    case "mp3":
    case undefined:
      return "audio/mpeg";
    default:
      return `audio/${format}`;
  }
}

function validateInput(input: SpeechSynthesisInput): void {
  if (typeof input.text !== "string" || input.text.trim() === "") {
    throw invalid("text must not be empty");
  }
  if (typeof input.voice !== "string" || input.voice.trim() === "") {
    throw invalid("voice must not be empty");
  }
  if (input.speed !== undefined
    && (!Number.isFinite(input.speed) || input.speed < 0.25 || input.speed > 4)) {
    throw invalid("speed must be between 0.25 and 4");
  }
  if (input.language !== undefined && typeof input.language !== "string") {
    throw invalid("language must be a string");
  }
  if (input.language !== undefined && input.language.trim() === "") {
    throw invalid("language must not be empty");
  }
  if (input.language !== undefined) {
    throw new GenerationClientError(
      "OPTION_NOT_SUPPORTED",
      "openai-audio-speech does not define language",
    );
  }
  normalizedFormat(input.outputFormat);
  assertSafeExtra(input.extra);
}

function requestBody(input: SpeechSynthesisInput, model: string): Record<string, unknown> {
  const format = normalizedFormat(input.outputFormat);
  return {
    model,
    input: input.text,
    voice: input.voice,
    ...(input.speed === undefined ? {} : { speed: input.speed }),
    ...(format === undefined ? {} : { response_format: format }),
    ...(input.extra ?? {}),
  };
}

export const openaiAudioSpeechAdapter: MediaAdapter<SpeechSynthesisInput, "text-to-speech"> = {
  protocol: "openai-audio-speech",
  operation: "text-to-speech",
  features: Object.freeze({ jobs: false, streaming: true }),

  async submit(
    input: SpeechSynthesisInput,
    ctx: AdapterContext,
    transport: MediaTransport,
  ): Promise<GenerationState<"text-to-speech">> {
    validateInput(input);
    const response = await transport.request({
      url: appendUrlPath(ctx.baseUrl, "/audio/speech"),
      method: "POST",
      responseType: "bytes",
      body: requestBody(input, ctx.model),
    }, input.signal);
    const bytes = response.bytes;
    if (!bytes || bytes.byteLength === 0) {
      throw new GenerationClientError("INVALID_RESPONSE", "provider returned empty speech audio");
    }
    return {
      status: "succeeded",
      target: {
        provider: ctx.providerId,
        model: ctx.model,
        protocol: ctx.protocol,
        operation: "text-to-speech",
      },
      output: {
        parts: [{
          type: "artifact",
          artifact: {
            kind: "audio",
            mediaType: mediaType(normalizedFormat(input.outputFormat), response.headers.get("content-type")),
            source: { type: "inline", data: bytes },
          },
        }],
      },
    };
  },

  async *stream(
    input: SpeechSynthesisInput,
    ctx: AdapterContext,
    transport: MediaTransport,
  ): AsyncIterable<AudioStreamEvent> {
    validateInput(input);
    const response = await transport.request({
      url: appendUrlPath(ctx.baseUrl, "/audio/speech"),
      method: "POST",
      responseType: "stream",
      body: requestBody(input, ctx.model),
    }, input.signal);
    if (!response.stream) {
      throw new GenerationClientError("INVALID_RESPONSE", "provider returned an empty speech stream");
    }
    const type = mediaType(normalizedFormat(input.outputFormat), response.headers.get("content-type"));
    const reader = response.stream.getReader();
    let emitted = false;
    let completed = false;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          completed = true;
          break;
        }
        if (!value || value.byteLength === 0) continue;
        emitted = true;
        yield { kind: "audio", bytes: value };
      }
    } catch (error) {
      if (error instanceof GenerationClientError) throw error;
      throw new GenerationClientError(
        "HTTP_REQUEST_FAILED",
        "speech stream was interrupted",
      );
    } finally {
      if (!completed) {
        try {
          await reader.cancel();
        } catch {
          // Preserve the stable interruption error; a failed cancel is only
          // local cleanup and does not imply remote cancellation.
        }
      }
      reader.releaseLock();
    }
    if (!emitted) {
      throw new GenerationClientError("INVALID_RESPONSE", "provider returned an empty speech stream");
    }
    yield { kind: "finish", mediaType: type };
  },
};
