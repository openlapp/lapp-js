import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "manager/contract": "src/manager/contract.ts",
    "manager/host": "src/manager/host.ts",
  },
  format: ["esm", "cjs"],
  dts: false,
  sourcemap: true,
  clean: true,
  target: "es2022",
  platform: "node",
  shims: true,
  external: ["@napi-rs/keyring"],
});
