import { createGenerationClientCore } from "./core.js";
import { openaiAudioSpeechAdapter } from "./openai-audio-speech.js";
import { openaiImagesAdapter } from "./openai-images.js";
import type { MediaAdapter } from "./internal.js";
import type {
  CreateGenerationClientOptions,
  ImageGenerationClient,
  ImageGenerationInput,
  MusicGenerationClient,
  MusicGenerationInput,
  SpeechSynthesisClient,
  SpeechSynthesisInput,
  VideoGenerationClient,
  VideoGenerationInput,
} from "./types.js";

export type {
  ArtifactPart,
  AudioStreamEvent,
  CreateGenerationClientOptions,
  DownloadArtifactOptions,
  GenerationArtifact,
  GenerationArtifactSource,
  GenerationClientErrorCode,
  GenerationClientFeatures,
  GenerationEvent,
  GenerationFailure,
  GenerationFailureCode,
  GenerationJob,
  GenerationOperation,
  GenerationOutput,
  GenerationPart,
  GenerationState,
  GenerationTarget,
  GenerationTerminal,
  ImageGenerationClient,
  ImageGenerationInput,
  ImageSize,
  MusicGenerationClient,
  MusicGenerationInput,
  SpeechSynthesisClient,
  SpeechSynthesisInput,
  TextPart,
  VideoGenerationClient,
  VideoGenerationInput,
  WaitOptions,
} from "./types.js";
export { GenerationClientError } from "./types.js";

const IMAGE_ADAPTERS: Readonly<Record<
  string,
  MediaAdapter<ImageGenerationInput, "image-generation">
>> = Object.freeze({
  "openai-images": openaiImagesAdapter,
});

const SPEECH_ADAPTERS: Readonly<Record<
  string,
  MediaAdapter<SpeechSynthesisInput, "text-to-speech">
>> = Object.freeze({
  "openai-audio-speech": openaiAudioSpeechAdapter,
});

const VIDEO_ADAPTERS: Readonly<Record<
  string,
  MediaAdapter<VideoGenerationInput, "video-generation">
>> = Object.freeze({});

const MUSIC_ADAPTERS: Readonly<Record<
  string,
  MediaAdapter<MusicGenerationInput, "music-generation">
>> = Object.freeze({});

export function createImageGenerationClient(
  options: CreateGenerationClientOptions,
): ImageGenerationClient {
  return createGenerationClientCore(
    options,
    "image-generation",
    "image-generation",
    IMAGE_ADAPTERS,
  );
}

export function createVideoGenerationClient(
  options: CreateGenerationClientOptions,
): VideoGenerationClient {
  return createGenerationClientCore(
    options,
    "video-generation",
    "video-generation",
    VIDEO_ADAPTERS,
  );
}

export function createSpeechSynthesisClient(
  options: CreateGenerationClientOptions,
): SpeechSynthesisClient {
  const core = createGenerationClientCore(
    options,
    "text-to-speech",
    "text-to-speech",
    SPEECH_ADAPTERS,
  );
  return {
    providerId: core.providerId,
    model: core.model,
    protocol: core.protocol,
    features: core.features,
    synthesize: core.generate,
    poll: core.poll,
    wait: core.wait,
    stream: core.stream,
    downloadArtifact: core.downloadArtifact,
  };
}

export function createMusicGenerationClient(
  options: CreateGenerationClientOptions,
): MusicGenerationClient {
  const core = createGenerationClientCore(
    options,
    "music-generation",
    "music-generation",
    MUSIC_ADAPTERS,
  );
  return {
    providerId: core.providerId,
    model: core.model,
    protocol: core.protocol,
    features: core.features,
    generate: core.generate,
    poll: core.poll,
    wait: core.wait,
    stream: core.stream,
    downloadArtifact: core.downloadArtifact,
  };
}
