import type { LappManagerBridgeV1 } from "@openlapp/lapp/manager-contract";

declare global {
  interface Window {
    openLapp: LappManagerBridgeV1;
  }
}

export {};
