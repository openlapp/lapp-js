import { contextBridge, ipcRenderer } from "electron";
import { createElectronLappBridge } from "./renderer-bridge.js";

contextBridge.exposeInMainWorld("openLapp", createElectronLappBridge(ipcRenderer));
