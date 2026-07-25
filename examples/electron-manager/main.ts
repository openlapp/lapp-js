import path from "node:path";
import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from "electron";
import { createNodeLappManagerHost } from "@openlapp/lapp/manager-host";
import type {
  ManagerTestConnectionRequest,
  ManagerTransactionRequest,
} from "@openlapp/lapp/manager-contract";
import { LAPP_MANAGER_CHANNELS } from "./channels.js";

export function createManagerWindow(preloadFile: string): BrowserWindow {
  const window = new BrowserWindow({
    width: 980,
    height: 680,
    minWidth: 640,
    minHeight: 480,
    webPreferences: {
      preload: path.resolve(preloadFile),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // The trusted main process may call loadFile/loadURL for the application
  // entry point. Renderer content itself cannot navigate this privileged
  // preload into a different document or open another privileged surface.
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  const host = createNodeLappManagerHost();

  const owned = (event: IpcMainInvokeEvent): void => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) {
      throw new Error("untrusted LAPP manager IPC sender");
    }
  };
  ipcMain.handle(LAPP_MANAGER_CHANNELS.handshake, (event) => {
    owned(event);
    return host.handshake();
  });
  ipcMain.handle(LAPP_MANAGER_CHANNELS.snapshot, (event) => {
    owned(event);
    return host.getSnapshot();
  });
  ipcMain.handle(LAPP_MANAGER_CHANNELS.transact, (event, request: ManagerTransactionRequest) => {
    owned(event);
    return host.transact(request);
  });
  ipcMain.handle(LAPP_MANAGER_CHANNELS.testConnection, (event, request: ManagerTestConnectionRequest) => {
    owned(event);
    return host.testConnection(request);
  });

  const unsubscribe = host.subscribe?.((event) => {
    if (!window.isDestroyed()) window.webContents.send(LAPP_MANAGER_CHANNELS.invalidated, event);
  });
  window.once("closed", () => {
    unsubscribe?.();
    for (const channel of Object.values(LAPP_MANAGER_CHANNELS)) {
      if (channel !== LAPP_MANAGER_CHANNELS.invalidated) ipcMain.removeHandler(channel);
    }
  });
  return window;
}
