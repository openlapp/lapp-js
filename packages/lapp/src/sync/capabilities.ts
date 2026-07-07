/**
 * Capability inference for provider-returned model entries.
 *
 * This is a best-effort heuristic. The LAPP spec does not define a closed
 * capability enum, so unknown strings are treated as opaque tags. The rules
 * here try to be **narrow**: match the start of the id (or a hyphen/word
 * boundary) against known model families, so a chat model with a substring
 * like "image" or "m3" in its id is not miscategorized.
 *
 * When in doubt the model falls back to the generic chat profile — that
 * is the most common case for provider-returned entries.
 */

import type { FetchedModelEntry } from "./types.js";

export interface InferredCapabilities {
  type?: string;
  inputModalities: string[];
  outputModalities: string[];
  capabilities: string[];
}

/** Match a model id against a list of prefix patterns. */
function idStartsWithAny(id: string, prefixes: string[]): boolean {
  const lower = id.toLowerCase();
  return prefixes.some((p) => lower.startsWith(p));
}

/** Match a model id against a list of patterns delimited by '-' or '/'. */
function idHasToken(id: string, tokens: string[]): boolean {
  const lower = id.toLowerCase();
  const parts = new Set(
    lower.split(/[-_/.]/).filter((p) => p.length > 0),
  );
  return tokens.some((t) => parts.has(t));
}

/** Like idHasToken, but matches substrings — needed when the needle itself
 *  contains the delimiter (e.g. "image-generation" splits into two tokens). */
function lowerIdHasToken(id: string, needles: string[]): boolean {
  const lower = id.toLowerCase();
  return needles.some((n) => lower.includes(n));
}

export function inferCapabilitiesFromProviderEntry(
  entry: FetchedModelEntry,
  protocol: string,
): InferredCapabilities {
  const { id } = entry;

  // ----- Embedding models -----
  if (
    idStartsWithAny(id, [
      "text-embedding",
      "text_embedding",
      "embedding",
      "embed-",
      "bge-",
      "gte-",
      "e5-",
      "m3e-",
    ]) ||
    idHasToken(id, ["embedding", "embeddings"])
  ) {
    return {
      type: "embedding",
      inputModalities: ["text"],
      outputModalities: ["embedding"],
      capabilities: ["embedding"],
    };
  }

  // ----- Rerank models -----
  if (idStartsWithAny(id, ["rerank", "bge-reranker", "gte-reranker"])) {
    return {
      type: "rerank",
      inputModalities: ["text"],
      outputModalities: ["text"],
      capabilities: ["rerank"],
    };
  }

  // ----- Image generation models -----
  if (
    idStartsWithAny(id, [
      "dall-e",
      "dalle",
      "flux",
      "midjourney",
      "stable-diffusion",
      "sdxl",
      "imagen",
      "kandinsky",
    ]) ||
    // `idHasToken` splits on [-_/.] so the literal token "image-generation"
    // can never match (it becomes ["image", "generation"]). Use a substring
    // check on the lowercased id instead so a model literally named
    // "image-generation" or "acme_image_generation" still classifies.
    lowerIdHasToken(id, ["image-gen", "imagegeneration"])
  ) {
    return {
      type: "image",
      inputModalities: ["text"],
      outputModalities: ["image"],
      capabilities: ["image-generation"],
    };
  }

  // ----- Speech / audio models -----
  // Whisper is transcription (audio in → text out). tts-* / -tts / text-to-speech-* is synthesis.
  if (idStartsWithAny(id, ["whisper"])) {
    return {
      type: "audio",
      inputModalities: ["audio"],
      outputModalities: ["text"],
      capabilities: ["audio-transcription"],
    };
  }
  if (idStartsWithAny(id, ["tts-", "tts_"])) {
    return {
      type: "audio",
      inputModalities: ["text"],
      outputModalities: ["audio"],
      capabilities: ["text-to-speech"],
    };
  }
  // Generic "audio" / "speech" tokens at id start.
  if (idHasToken(id, ["tts", "speech", "audio"])) {
    return {
      type: "audio",
      inputModalities: ["text"],
      outputModalities: ["audio"],
      capabilities: ["text-to-speech"],
    };
  }

  // ----- Chat (default) -----
  const capabilities = new Set<string>(["chat", "stream"]);

  // Reasoning: o-series, "reasoning" suffix, deepseek-r, kimi-k2-thinking,
  // claude-3-5-sonnet, claude-4.
  if (
    idStartsWithAny(id, ["o1", "o3", "o4", "reasoning"]) ||
    idHasToken(id, ["reasoning", "think", "thinking"]) ||
    idStartsWithAny(id, ["deepseek-r", "kimi-k2", "claude-3-5-sonnet", "claude-4"])
  ) {
    capabilities.add("reasoning");
  }

  // Tool-calling: most modern chat models support it. We add the tag if the
  // id is in a known tool-capable family, or has a "-tool"/"-instruct" hint.
  if (
    idStartsWithAny(id, [
      "gpt-4",
      "gpt-5",
      "claude",
      "gemini",
      "command-r",
      "llama",
      "qwen",
      "kimi",
      "deepseek",
    ]) ||
    idHasToken(id, ["tool", "instruct"])
  ) {
    capabilities.add("tool-call");
  }

  // Vision: ids containing "vision" or "vl" (vision-language) get image input.
  const isVision = idHasToken(id, ["vision", "vl"]) && !idHasToken(id, ["revision"]);
  return {
    type: "chat",
    inputModalities: isVision ? ["text", "image"] : ["text"],
    outputModalities: ["text"],
    capabilities: Array.from(capabilities),
  };
}
