# Electron manager bridge

> **Unsupported integration reference.** This example demonstrates how to
> embed the current Node manager host safely in Electron. It is not a complete
> GUI and is not the basis of the standalone Manager. The Tauri 2 + Vue 3 +
> TypeScript + Naive UI Alpha implementation lives in
> [`openlapp/lapp-manager`](https://github.com/openlapp/lapp-manager) and links
> the public Rust SDK in-process.

Run `@openlapp/lapp/manager-host` only in Electron's main process. The preload
script exposes the narrow, structured-clone-safe `LappManagerBridgeV1`; the
renderer may consume `window.openLapp` through application-specific code. The
former `@openlapp/react` and `@openlapp/vue` packages have been removed.

The example intentionally enables `contextIsolation` and the sandbox, disables
Node integration, checks the calling frame, and exposes no generic IPC, file,
Vault resolve/export, or network primitive. Adapt paths and window loading to
your desktop application. Renderer-initiated navigation, new windows, and
webviews are denied so the privileged preload cannot be carried into untrusted
content. Do not move the Node host or native keyring into the renderer.
