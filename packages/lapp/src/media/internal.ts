import type { AdapterContext } from "../client/adapter.js";
import type {
  AudioStreamEvent,
  GenerationJob,
  GenerationOperation,
  GenerationState,
} from "./types.js";

export interface MediaRequest {
  url: string;
  method: "GET" | "POST";
  body?: unknown;
  headers?: Record<string, string>;
  responseType: "json" | "bytes" | "stream";
}

export interface MediaResponse {
  headers: Headers;
  json?: unknown;
  bytes?: Uint8Array;
  stream?: ReadableStream<Uint8Array>;
}

export interface MediaTransport {
  request(request: MediaRequest, signal?: AbortSignal): Promise<MediaResponse>;
}

/** Internal-only operation adapter. This is deliberately not a package export. */
export interface MediaAdapter<I, O extends GenerationOperation> {
  readonly protocol: string;
  readonly operation: O;
  readonly features: Readonly<{ jobs: boolean; streaming: boolean }>;
  submit(
    input: I,
    ctx: AdapterContext,
    transport: MediaTransport,
  ): Promise<GenerationState<O>>;
  poll?(
    job: GenerationJob<O>,
    ctx: AdapterContext,
    transport: MediaTransport,
  ): Promise<GenerationState<O>>;
  stream?(
    input: I,
    ctx: AdapterContext,
    transport: MediaTransport,
  ): AsyncIterable<AudioStreamEvent>;
}
