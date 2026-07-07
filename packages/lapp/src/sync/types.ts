/**
 * Model sync types.
 */

import type { ModelEntry } from "../types.js";

export interface FetchedModelEntry {
  id: string;
  name?: string;
  ownedBy?: string;
  created?: number;
  raw: Record<string, unknown>;
}

export interface SyncOptions {
  /** Resolve secrets from process.env (required to call a provider). */
  resolveSecrets?: boolean;
  /** Custom env source (for tests). */
  env?: Record<string, string | undefined>;
  /** Custom fetch implementation (for tests / non-Node runtimes). */
  fetchImpl?: typeof fetch;
  /**
   * Allow a missing/empty `auth.secret` (local/self-hosted providers). When
   * `true` and `resolveSecret` returns `reason: "unset"`, the request is sent
   * with no auth header. Other resolve failures (unsupported scheme, missing
   * env var) still throw.
   */
  allowUnauthenticated?: boolean;
}

export interface ModelSyncResult {
  models: ModelEntry[];
  added: ModelEntry[];
  removed: ModelEntry[];
  updated: ModelEntry[];
}

export class ModelSyncUnsupportedError extends Error {
  override name = "ModelSyncUnsupportedError";
  constructor(providerId: string, message?: string) {
    super(message ?? `model sync is unsupported for provider "${providerId}"`);
    this.name = "ModelSyncUnsupportedError";
  }
}
