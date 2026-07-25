import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { LAPP_MANAGER_CHANNELS } from "../../../examples/electron-manager/channels.js";
import {
  createElectronLappBridge,
  type NarrowIpcRenderer,
} from "../../../examples/electron-manager/renderer-bridge.js";

describe("Electron renderer bridge example", () => {
  it("exposes fixed channels instead of a generic invoke primitive", async () => {
    const invoke = vi.fn(async () => ({ ok: true, value: { protocolVersion: 1, features: [] } }));
    const ipc: NarrowIpcRenderer = {
      invoke,
      on: vi.fn(),
      removeListener: vi.fn(),
    };
    const bridge = createElectronLappBridge(ipc);
    expect(Object.keys(bridge).sort()).toEqual([
      "getSnapshot",
      "handshake",
      "subscribe",
      "testConnection",
      "transact",
    ]);
    await bridge.handshake();
    expect(invoke).toHaveBeenCalledWith(LAPP_MANAGER_CHANNELS.handshake);
  });

  it("validates invalidation events and removes its listener", () => {
    let receive: ((_event: unknown, payload: unknown) => void) | undefined;
    const ipc: NarrowIpcRenderer = {
      invoke: vi.fn(),
      on: vi.fn((_channel, listener) => { receive = listener; }),
      removeListener: vi.fn(),
    };
    const bridge = createElectronLappBridge(ipc);
    const listener = vi.fn();
    const unsubscribe = bridge.subscribe!(listener);
    receive?.({}, { type: "other", revision: "ignored" });
    receive?.({}, { type: "invalidated", revision: "r2" });
    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith({ type: "invalidated", revision: "r2" });
    unsubscribe();
    expect(ipc.removeListener).toHaveBeenCalledWith(LAPP_MANAGER_CHANNELS.invalidated, receive);
  });

  it("keeps the privileged preload on a non-navigable renderer surface", () => {
    const source = fs.readFileSync(
      fileURLToPath(new URL("../../../examples/electron-manager/main.ts", import.meta.url)),
      "utf8",
    );
    expect(source).toContain('webContents.on("will-navigate"');
    expect(source).toContain('webContents.on("will-attach-webview"');
    expect(source).toContain('setWindowOpenHandler(() => ({ action: "deny" }))');
    expect(source).toContain("event.senderFrame !== window.webContents.mainFrame");
  });
});
