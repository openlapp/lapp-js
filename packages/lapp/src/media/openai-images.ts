import type { AdapterContext } from "../client/adapter.js";
import { isRecord } from "../client/adapter.js";
import { appendUrlPath } from "../client/http.js";
import type { MediaAdapter, MediaTransport } from "./internal.js";
import {
  GenerationClientError,
  type GenerationArtifact,
  type GenerationOutput,
  type GenerationState,
  type ImageGenerationInput,
} from "./types.js";

const MAX_INLINE_ARTIFACT_BYTES = 64 * 1024 * 1024;
const OUTPUT_FORMATS = new Set(["png", "jpeg", "webp"]);
const RESERVED_FIELDS = new Set([
  "model",
  "prompt",
  "n",
  "size",
  "seed",
  "negative_prompt",
  "output_format",
  "response_format",
  "authorization",
  "api_key",
  "apikey",
  "x-api-key",
]);
const ALLOWED_EXTRA_FIELDS = new Set([
  "background",
  "moderation",
  "output_compression",
  "quality",
  "style",
  "user",
]);

function invalid(message: string): GenerationClientError {
  return new GenerationClientError("INVALID_GENERATION_INPUT", message);
}

function invalidResponse(): GenerationClientError {
  return new GenerationClientError("INVALID_RESPONSE", "provider returned an invalid OpenAI image response");
}

function assertSafeExtra(extra: Record<string, unknown> | undefined): void {
  for (const key of Object.keys(extra ?? {})) {
    if (RESERVED_FIELDS.has(key.toLowerCase())) {
      throw invalid(`extra field is reserved: ${key}`);
    }
    if (!ALLOWED_EXTRA_FIELDS.has(key)) {
      throw new GenerationClientError(
        "OPTION_NOT_SUPPORTED",
        `openai-images does not support extra field: ${key}`,
      );
    }
  }
}

function normalizedFormat(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const format = value.trim().toLowerCase();
  if (!format) throw invalid("outputFormat must not be empty");
  const normalized = format === "jpg" ? "jpeg" : format;
  if (!OUTPUT_FORMATS.has(normalized)) {
    throw new GenerationClientError(
      "OPTION_NOT_SUPPORTED",
      `openai-images does not support outputFormat: ${value}`,
    );
  }
  return normalized;
}

function imageMediaType(format: string | undefined, url?: string): string {
  const inferred = format ?? (() => {
    if (!url) return undefined;
    try {
      const match = new URL(url).pathname.match(/\.([A-Za-z0-9]+)$/);
      return match?.[1]?.toLowerCase();
    } catch {
      return undefined;
    }
  })();
  if (inferred === "jpg" || inferred === "jpeg") return "image/jpeg";
  if (inferred === "webp") return "image/webp";
  if (inferred === "png" || inferred === undefined) return "image/png";
  return `image/${inferred}`;
}

function decodeBase64(raw: string): Uint8Array {
  if (
    raw.length === 0
    || raw.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(raw)
  ) {
    throw invalidResponse();
  }
  const data = Uint8Array.from(Buffer.from(raw, "base64"));
  if (data.byteLength > MAX_INLINE_ARTIFACT_BYTES) {
    throw new GenerationClientError("INVALID_RESPONSE", "inline image exceeds the response size limit");
  }
  return data;
}

function checkedUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw invalidResponse();
  }
  if (
    !(["http:", "https:"] as string[]).includes(url.protocol)
    || url.username
    || url.password
    || url.hash
  ) {
    throw invalidResponse();
  }
  return url.toString();
}

function parseOutput(
  raw: unknown,
  input: ImageGenerationInput,
): GenerationOutput {
  if (!isRecord(raw) || !Array.isArray(raw.data) || raw.data.length === 0) throw invalidResponse();
  let responseFormat = normalizedFormat(input.outputFormat);
  if (raw.output_format !== undefined) {
    if (typeof raw.output_format !== "string") throw invalidResponse();
    try {
      responseFormat = normalizedFormat(raw.output_format);
    } catch {
      throw invalidResponse();
    }
  }
  const parts: GenerationOutput["parts"] = [];
  for (const item of raw.data) {
    if (!isRecord(item)) throw invalidResponse();
    if (item.revised_prompt !== undefined) {
      if (typeof item.revised_prompt !== "string") throw invalidResponse();
      parts.push({ type: "text", text: item.revised_prompt });
    }
    let artifact: GenerationArtifact;
    if (typeof item.b64_json === "string") {
      const data = decodeBase64(item.b64_json);
      artifact = {
        kind: "image",
        mediaType: imageMediaType(responseFormat),
        source: { type: "inline", data },
      };
    } else if (typeof item.url === "string") {
      const url = checkedUrl(item.url);
      artifact = {
        kind: "image",
        mediaType: imageMediaType(responseFormat, url),
        source: { type: "url", url, auth: "none" },
      };
    } else {
      throw invalidResponse();
    }
    parts.push({ type: "artifact", artifact });
  }
  return { parts };
}

function validateInput(input: ImageGenerationInput): void {
  if (typeof input.prompt !== "string" || input.prompt.trim() === "") {
    throw invalid("prompt must not be empty");
  }
  if (input.seed !== undefined) {
    throw new GenerationClientError("OPTION_NOT_SUPPORTED", "openai-images does not define seed");
  }
  if (input.count !== undefined
    && (!Number.isSafeInteger(input.count) || input.count < 1 || input.count > 10)) {
    throw invalid("count must be an integer between 1 and 10");
  }
  if (input.size !== undefined && (
    !Number.isSafeInteger(input.size.width)
    || !Number.isSafeInteger(input.size.height)
    || input.size.width <= 0
    || input.size.height <= 0
  )) {
    throw invalid("size width and height must be positive safe integers");
  }
  normalizedFormat(input.outputFormat);
  assertSafeExtra(input.extra);
}

export const openaiImagesAdapter: MediaAdapter<ImageGenerationInput, "image-generation"> = {
  protocol: "openai-images",
  operation: "image-generation",
  features: Object.freeze({ jobs: false, streaming: false }),

  async submit(
    input: ImageGenerationInput,
    ctx: AdapterContext,
    transport: MediaTransport,
  ): Promise<GenerationState<"image-generation">> {
    validateInput(input);
    const outputFormat = normalizedFormat(input.outputFormat);
    const response = await transport.request({
      url: appendUrlPath(ctx.baseUrl, "/images/generations"),
      method: "POST",
      responseType: "json",
      body: {
        model: ctx.model,
        prompt: input.prompt,
        ...(input.count === undefined ? {} : { n: input.count }),
        ...(input.size === undefined ? {} : { size: `${input.size.width}x${input.size.height}` }),
        ...(outputFormat === undefined ? {} : { output_format: outputFormat }),
        ...(input.extra ?? {}),
      },
    }, input.signal);
    return {
      status: "succeeded",
      target: {
        provider: ctx.providerId,
        model: ctx.model,
        protocol: ctx.protocol,
        operation: "image-generation",
      },
      output: parseOutput(response.json, input),
    };
  },
};
