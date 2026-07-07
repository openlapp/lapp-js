/**
 * @openlapp/lapp — TypeScript SDK for LAPP (Local AI Provider Profiles).
 *
 * Core roles:
 *  1. Read, validate, write, manage LAPP profiles.
 *  2. Send requests to configured providers via protocol adapters.
 *
 * See docs/sdk-cli-design.md.
 */

export * from "./types.js";
export * from "./config/discovery.js";
export * from "./config/jsonc.js";
export * from "./validate/index.js";
export * from "./manage/index.js";
export * from "./plan.js";
export * from "./write/atomic.js";
export * from "./secret/index.js";
export * from "./env-export/index.js";
export * from "./connection.js";
export * from "./sync/index.js";
export * from "./client/index.js";

export {
  loadProfile,
  inspectProfile,
  type LoadProfileOptions,
} from "./config/discovery.js";