/**
 * Well-known provider presets — a CLI-only convenience layer.
 *
 * The LAPP spec (`../lapp/spec.en.md`) is provider-agnostic and defines NO
 * preset registry: the spec leaves first-run UX to implementations. This
 * module is that UX layer for the `lapp` CLI. It resolves a known provider id
 * (e.g. `openai`) into a full `ProviderInput`-shaped object so a user can write
 *
 *   lapp provider add --id openai --model gpt-4o-mini --yes
 *
 * instead of typing the three constant flags (`--protocol`, `--base-url`,
 * credential-storage details that are identical for every OpenAI user.
 *
 * This module is deliberately CLI-only: the SDK (`@openlapp/lapp`) stays
 * preset-agnostic and never imports provider names. `applyPreset` produces a
 * plain object the CLI hands to `upsertProvider` — presets generate edit
 * *input*, they do not perform edits.
 *
 * Only the three core protocols from `CORE_PROTOCOLS` appear here. Extended
 * protocols (e.g. `gemini-generate-content`) are NOT presets; a user wanting
 * one edits `provider.json` by hand.
 */

export interface ProviderPreset {
  /** Stable id; the key in `PRESETS`. Used as the provider id by default. */
  id: string;
  /** Human-readable name shown by `lapp presets`. */
  displayName: string;
  /**
   * Ordered `protocols[]` entries. Applications select the first entry they
   * support.
   */
  protocols: string[];
  baseUrl: string;
  /** Remote model-list response shape. */
  modelDiscoveryProtocol?: "openai-models" | "anthropic-models";
  /** Suggested secret reference, e.g. `env://OPENAI_API_KEY`. Undefined for noAuth. */
  suggestedSecret?: string;
  authType?: "bearer" | "header";
  authName?: string;
  /** True for local providers (Ollama / LM Studio / vLLM) that carry no secret. */
  noAuth?: boolean;
  /** Optional default chat model to seed via `--model` in `provider add`. */
  defaultModel?: string;
  /** Free-form notes printed by `lapp presets`. */
  notes?: string;
}

export const PRESETS: Record<string, ProviderPreset> = {
  openai: {
    id: "openai",
    displayName: "OpenAI",
    // Prefer the Responses API; fall back to Chat Completions.
    protocols: ["openai-responses", "openai-chat-completions"],
    baseUrl: "https://api.openai.com/v1",
    modelDiscoveryProtocol: "openai-models",
    suggestedSecret: "env://OPENAI_API_KEY",
    defaultModel: "gpt-4o-mini",
    notes: "Responses API is preferred when the application supports it.",
  },
  anthropic: {
    id: "anthropic",
    displayName: "Anthropic",
    protocols: ["anthropic-messages"],
    // Anthropic's adapter dedups a trailing /v1; the spec baseUrl has none.
    baseUrl: "https://api.anthropic.com",
    modelDiscoveryProtocol: "anthropic-models",
    suggestedSecret: "env://ANTHROPIC_API_KEY",
    authType: "header",
    authName: "x-api-key",
    defaultModel: "claude-sonnet-4",
  },
  deepseek: {
    id: "deepseek",
    displayName: "DeepSeek",
    protocols: ["openai-chat-completions"],
    baseUrl: "https://api.deepseek.com/v1",
    modelDiscoveryProtocol: "openai-models",
    suggestedSecret: "env://DEEPSEEK_API_KEY",
    defaultModel: "deepseek-chat",
  },
  openrouter: {
    id: "openrouter",
    displayName: "OpenRouter",
    protocols: ["openai-chat-completions"],
    baseUrl: "https://openrouter.ai/api/v1",
    modelDiscoveryProtocol: "openai-models",
    suggestedSecret: "env://OPENROUTER_API_KEY",
  },
  ollama: {
    id: "ollama",
    displayName: "Ollama (local)",
    protocols: ["openai-chat-completions"],
    baseUrl: "http://localhost:11434/v1",
    modelDiscoveryProtocol: "openai-models",
    noAuth: true,
    notes: "Local; start with `ollama serve`.",
  },
  "lm-studio": {
    id: "lm-studio",
    displayName: "LM Studio (local)",
    protocols: ["openai-chat-completions"],
    baseUrl: "http://localhost:1234/v1",
    modelDiscoveryProtocol: "openai-models",
    noAuth: true,
  },
  vllm: {
    id: "vllm",
    displayName: "vLLM (local)",
    protocols: ["openai-chat-completions"],
    baseUrl: "http://localhost:8000/v1",
    modelDiscoveryProtocol: "openai-models",
    noAuth: true,
  },
  kimi: {
    id: "kimi",
    displayName: "Kimi / Moonshot",
    protocols: ["openai-chat-completions"],
    baseUrl: "https://api.moonshot.cn/v1",
    modelDiscoveryProtocol: "openai-models",
    suggestedSecret: "env://MOONSHOT_API_KEY",
  },
  // `moonshot` is an alias of `kimi` for users who think in provider terms.
  moonshot: {
    id: "moonshot",
    displayName: "Moonshot",
    protocols: ["openai-chat-completions"],
    baseUrl: "https://api.moonshot.cn/v1",
    modelDiscoveryProtocol: "openai-models",
    suggestedSecret: "env://MOONSHOT_API_KEY",
  },
  minimax: {
    id: "minimax",
    displayName: "MiniMax",
    protocols: ["openai-chat-completions"],
    baseUrl: "https://api.minimaxi.com/v1",
    modelDiscoveryProtocol: "openai-models",
    suggestedSecret: "env://MINIMAX_API_KEY",
  },
  siliconflow: {
    id: "siliconflow",
    displayName: "SiliconFlow",
    protocols: ["openai-chat-completions"],
    baseUrl: "https://api.siliconflow.cn/v1",
    modelDiscoveryProtocol: "openai-models",
    suggestedSecret: "env://SILICONFLOW_API_KEY",
  },
};

/** Look up a preset by id. Returns undefined for unknown ids. */
export function getPreset(id: string): ProviderPreset | undefined {
  return PRESETS[id];
}

/** All presets, sorted by id for stable `lapp presets` output. */
export function listPresets(): ProviderPreset[] {
  return Object.values(PRESETS).sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * The auth block shape produced for a preset resolution. Mirrors the subset of
 * `ProviderConfig["auth"]` the CLI constructs: either `none` (no secret) or a
 * `secret` reference (bearer, the spec default when `type` is omitted).
 */
export type PresetAuth =
  | { type: "none" }
  | { type: "bearer"; secret: string }
  | { type: "header"; name: string; secret: string };

/** A resolved preset ready to hand to `upsertProvider`. */
export interface PresetResolution {
  preset: ProviderPreset;
  input: {
    id: string;
    baseUrl: string;
    protocols: string[];
    auth: PresetAuth;
    modelDiscovery?: {
      protocol: "openai-models" | "anthropic-models";
      url: string;
    };
    /** Default chat model, if the preset (or override) specifies one. */
    defaultModel?: string;
  };
}

export interface PresetOverrides {
  /** Override the preset base URL. */
  baseUrl?: string;
  /** Override the suggested secret reference for programmatic preset use. */
  secret?: string;
  /** Force no-auth (e.g. a user-supplied `--no-auth`). */
  noAuth?: boolean;
  /** Override the default model (e.g. a user-supplied `--model`). */
  model?: string;
}

/**
 * Resolve a preset id into a `ProviderInput`-shaped object.
 *
 * Throws on an unknown preset id.
 */
export function applyPreset(id: string, overrides: PresetOverrides = {}): PresetResolution {
  const preset = PRESETS[id];
  if (!preset) throw new Error(`unknown preset: ${id}`);

  const baseUrl = overrides.baseUrl ?? preset.baseUrl;

  let auth: PresetAuth;
  if (overrides.noAuth || preset.noAuth) {
    auth = { type: "none" };
  } else if (overrides.secret) {
    auth = preset.authType === "header"
      ? { type: "header", name: preset.authName!, secret: overrides.secret }
      : { type: "bearer", secret: overrides.secret };
  } else if (preset.suggestedSecret) {
    auth = preset.authType === "header"
      ? { type: "header", name: preset.authName!, secret: preset.suggestedSecret }
      : { type: "bearer", secret: preset.suggestedSecret };
  } else {
    throw new Error(`preset has no authentication policy: ${id}`);
  }

  const defaultModel = overrides.model ?? preset.defaultModel;
  const discoveryBase = baseUrl.replace(/\/$/, "");
  const discoverySuffix = preset.modelDiscoveryProtocol === "anthropic-models" && !discoveryBase.endsWith("/v1")
    ? "/v1/models"
    : "/models";

  return {
    preset,
    input: {
      id,
      baseUrl,
      protocols: [...preset.protocols],
      auth,
      ...(preset.modelDiscoveryProtocol
        ? {
            modelDiscovery: {
              protocol: preset.modelDiscoveryProtocol,
              url: `${discoveryBase}${discoverySuffix}`,
            },
          }
        : {}),
      ...(defaultModel ? { defaultModel } : {}),
    },
  };
}
