/**
 * Anthropic model list fetcher.
 *
 * Anthropic does not expose a public models-list API. The SDK refuses to
 * fabricate a list. Callers can override by setting provider.links.models.
 */

import { ModelSyncUnsupportedError } from "./types.js";

export function fetchAnthropicModels(providerId: string): never {
  throw new ModelSyncUnsupportedError(
    providerId,
    `Anthropic has no public models-list API; set provider.links.models to override`,
  );
}
