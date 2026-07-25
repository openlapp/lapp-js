import type {
  CredentialResolver,
  CredentialVault,
  JsonValue,
  LappProfile,
} from "../types.js";

/** Provider operation selected by one of the generation clients. */
export type GenerationOperation =
  | "image-generation"
  | "video-generation"
  | "text-to-speech"
  | "music-generation";

export interface GenerationTarget<O extends GenerationOperation = GenerationOperation> {
  provider: string;
  model: string;
  protocol: string;
  operation: O;
}

/** Opaque, non-secret provider job identity. */
export interface GenerationJob<O extends GenerationOperation = GenerationOperation>
  extends GenerationTarget<O> {
  id: string;
}

export type GenerationFailureCode =
  | "PROVIDER_FAILED"
  | "CONTENT_POLICY"
  | "CANCELLED"
  | "EXPIRED";

/** A provider-created job that reached a terminal failure. */
export interface GenerationFailure {
  code: GenerationFailureCode;
  message: string;
  providerCode?: string;
  retryable?: boolean;
}

export type GenerationArtifactSource =
  | {
      type: "inline";
      data: Uint8Array;
    }
  | {
      type: "url";
      url: string;
      /** Whether downloading the URL requires the configured provider auth. */
      auth: "none" | "provider";
      /** RFC 3339 timestamp supplied by the provider, when known. */
      expiresAt?: string;
    };

/** A generated image, video, or audio value. */
export interface GenerationArtifact {
  kind: "image" | "video" | "audio";
  mediaType: string;
  source: GenerationArtifactSource;
  sizeBytes?: number;
  width?: number;
  height?: number;
  duration?: number;
  sampleRateHz?: number;
  channels?: number;
}

export interface TextPart {
  type: "text";
  text: string;
}

export interface ArtifactPart {
  type: "artifact";
  artifact: GenerationArtifact;
}

export type GenerationPart = TextPart | ArtifactPart;

/** Ordered provider output. Text and artifacts retain their provider order. */
export interface GenerationOutput {
  parts: GenerationPart[];
  /** Small, redacted JSON metadata only; binary payloads are represented as parts. */
  providerMetadata?: JsonValue;
}

export type GenerationState<O extends GenerationOperation = GenerationOperation> =
  | {
      status: "queued";
      target: GenerationTarget<O>;
      job: GenerationJob<O>;
      retryAfterMs?: number;
    }
  | {
      status: "running";
      target: GenerationTarget<O>;
      job: GenerationJob<O>;
      /** Normalized progress in the inclusive range 0..1. */
      progress?: number;
      retryAfterMs?: number;
    }
  | {
      status: "succeeded";
      target: GenerationTarget<O>;
      job?: GenerationJob<O>;
      output: GenerationOutput;
    }
  | {
      status: "failed";
      target: GenerationTarget<O>;
      job?: GenerationJob<O>;
      failure: GenerationFailure;
    };

export type GenerationTerminal<O extends GenerationOperation = GenerationOperation> =
  Extract<GenerationState<O>, { status: "succeeded" | "failed" }>;

export type GenerationEvent<O extends GenerationOperation = GenerationOperation> =
  | {
      kind: "queued";
      job: GenerationJob<O>;
      retryAfterMs?: number;
    }
  | {
      kind: "running";
      job: GenerationJob<O>;
      progress?: number;
      retryAfterMs?: number;
    }
  | {
      kind: "succeeded";
      output: GenerationOutput;
    }
  | {
      kind: "failed";
      failure: GenerationFailure;
    };

export interface WaitOptions<O extends GenerationOperation = GenerationOperation> {
  /** Poll interval when the provider did not return a hint. Defaults to 2 seconds. */
  pollIntervalMs?: number;
  /** Overall wait timeout. Defaults to 30 minutes. */
  timeoutMs?: number;
  signal?: AbortSignal;
  onEvent?: (event: GenerationEvent<O>) => void;
}

export type AudioStreamEvent =
  | { kind: "audio"; bytes: Uint8Array }
  | { kind: "finish"; mediaType: string };

export interface GenerationClientFeatures {
  jobs: boolean;
  streaming: boolean;
}

export interface CreateGenerationClientOptions {
  profile: LappProfile;
  /** Provider id. Must be supplied together with `model`. */
  provider?: string;
  /** Real model id or alias. Must be supplied together with `provider`. */
  model?: string;
  /** Named global default. Each factory supplies an operation-specific default. */
  default?: string;
  env?: Record<string, string | undefined>;
  vault?: CredentialVault;
  resolver?: CredentialResolver;
  /** Defaults to true. Errors are always redacted. */
  redactSuccessfulSecrets?: boolean;
  fetchImpl?: typeof fetch;
}

export interface ImageSize {
  width: number;
  height: number;
}

export interface ImageGenerationInput {
  prompt: string;
  size?: ImageSize;
  count?: number;
  seed?: number;
  outputFormat?: string;
  /** Provider-native JSON fields. Reserved protocol fields cannot be overridden. */
  extra?: Record<string, JsonValue>;
  signal?: AbortSignal;
}

export interface VideoGenerationInput {
  prompt: string;
  duration?: number;
  aspectRatio?: string;
  resolution?: string;
  seed?: number;
  extra?: Record<string, JsonValue>;
  signal?: AbortSignal;
}

export interface SpeechSynthesisInput {
  text: string;
  voice: string;
  speed?: number;
  language?: string;
  outputFormat?: string;
  extra?: Record<string, JsonValue>;
  signal?: AbortSignal;
}

export interface MusicGenerationInput {
  prompt: string;
  lyrics?: string;
  instrumental?: boolean;
  duration?: number;
  outputFormat?: string;
  extra?: Record<string, JsonValue>;
  signal?: AbortSignal;
}

export interface DownloadArtifactOptions {
  /** Required upper bound for data retained in memory. */
  maxBytes: number;
  signal?: AbortSignal;
}

export type GenerationClientErrorCode =
  | "OPERATION_NOT_SUPPORTED"
  | "PROTOCOL_NOT_SUPPORTED"
  | "INVALID_GENERATION_INPUT"
  | "OPTION_NOT_SUPPORTED"
  | "GENERATION_JOB_INVALID"
  | "STREAMING_NOT_SUPPORTED"
  | "WAIT_TIMEOUT"
  | "ARTIFACT_UNAVAILABLE"
  | "ARTIFACT_EXPIRED"
  | "ARTIFACT_TOO_LARGE"
  | "HTTP_REQUEST_FAILED"
  | "HTTP_STATUS"
  | "INVALID_RESPONSE";

export class GenerationClientError extends Error {
  override name = "GenerationClientError";

  constructor(
    public readonly code: GenerationClientErrorCode,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
  }
}

interface BoundGenerationClient {
  readonly providerId: string;
  readonly model: string;
  readonly protocol: string;
  readonly features: Readonly<GenerationClientFeatures>;
  downloadArtifact(
    artifact: GenerationArtifact,
    options: DownloadArtifactOptions,
  ): Promise<Uint8Array>;
}

export interface ImageGenerationClient extends BoundGenerationClient {
  generate(input: ImageGenerationInput): Promise<GenerationState<"image-generation">>;
  poll(job: GenerationJob<"image-generation">): Promise<GenerationState<"image-generation">>;
  wait(
    state: GenerationState<"image-generation">,
    options?: WaitOptions<"image-generation">,
  ): Promise<GenerationTerminal<"image-generation">>;
}

export interface VideoGenerationClient extends BoundGenerationClient {
  generate(input: VideoGenerationInput): Promise<GenerationState<"video-generation">>;
  poll(job: GenerationJob<"video-generation">): Promise<GenerationState<"video-generation">>;
  wait(
    state: GenerationState<"video-generation">,
    options?: WaitOptions<"video-generation">,
  ): Promise<GenerationTerminal<"video-generation">>;
}

export interface SpeechSynthesisClient extends BoundGenerationClient {
  synthesize(input: SpeechSynthesisInput): Promise<GenerationState<"text-to-speech">>;
  poll(job: GenerationJob<"text-to-speech">): Promise<GenerationState<"text-to-speech">>;
  wait(
    state: GenerationState<"text-to-speech">,
    options?: WaitOptions<"text-to-speech">,
  ): Promise<GenerationTerminal<"text-to-speech">>;
  stream(input: SpeechSynthesisInput): AsyncIterable<AudioStreamEvent>;
}

export interface MusicGenerationClient extends BoundGenerationClient {
  generate(input: MusicGenerationInput): Promise<GenerationState<"music-generation">>;
  poll(job: GenerationJob<"music-generation">): Promise<GenerationState<"music-generation">>;
  wait(
    state: GenerationState<"music-generation">,
    options?: WaitOptions<"music-generation">,
  ): Promise<GenerationTerminal<"music-generation">>;
  stream(input: MusicGenerationInput): AsyncIterable<AudioStreamEvent>;
}
