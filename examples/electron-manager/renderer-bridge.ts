import type {
  LappManagerBridgeV1,
  ManagerInvalidatedEvent,
  ManagerTestConnectionRequest,
  ManagerTransactionRequest,
} from "@openlapp/lapp/manager-contract";
import { LAPP_MANAGER_CHANNELS } from "./channels.js";

export interface NarrowIpcRenderer {
  invoke(channel: string, payload?: unknown): Promise<unknown>;
  on(channel: string, listener: (_event: unknown, payload: unknown) => void): void;
  removeListener(channel: string, listener: (_event: unknown, payload: unknown) => void): void;
}

/** Create only the five LAPP calls the renderer is allowed to make. */
export function createElectronLappBridge(ipc: NarrowIpcRenderer): LappManagerBridgeV1 {
  return {
    handshake: () => ipc.invoke(LAPP_MANAGER_CHANNELS.handshake) as ReturnType<LappManagerBridgeV1["handshake"]>,
    getSnapshot: () => ipc.invoke(LAPP_MANAGER_CHANNELS.snapshot) as ReturnType<LappManagerBridgeV1["getSnapshot"]>,
    transact: (request: ManagerTransactionRequest) =>
      ipc.invoke(LAPP_MANAGER_CHANNELS.transact, request) as ReturnType<LappManagerBridgeV1["transact"]>,
    testConnection: (request: ManagerTestConnectionRequest) =>
      ipc.invoke(LAPP_MANAGER_CHANNELS.testConnection, request) as ReturnType<LappManagerBridgeV1["testConnection"]>,
    subscribe(listener) {
      const receive = (_event: unknown, payload: unknown) => {
        const candidate = payload as Partial<ManagerInvalidatedEvent> | null;
        if (candidate?.type === "invalidated") {
          listener({
            type: "invalidated",
            ...(typeof candidate.revision === "string" ? { revision: candidate.revision } : {}),
          });
        }
      };
      ipc.on(LAPP_MANAGER_CHANNELS.invalidated, receive);
      return () => ipc.removeListener(LAPP_MANAGER_CHANNELS.invalidated, receive);
    },
  };
}
