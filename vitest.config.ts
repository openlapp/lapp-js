import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: [
      {
        find: "@openlapp/lapp/manager-contract",
        replacement: fileURLToPath(new URL("./packages/lapp/src/manager/contract.ts", import.meta.url)),
      },
      {
        find: "@openlapp/lapp",
        replacement: fileURLToPath(new URL("./packages/lapp/src/index.ts", import.meta.url)),
      },
    ],
  },
  test: {
    include: [
      "packages/**/test/**/*.test.ts",
      "packages/**/test/**/*.test.tsx",
      "internal/**/test/**/*.test.ts",
      "internal/**/test/**/*.test.tsx",
    ],
    environment: "node",
    globals: false,
    pool: "threads",
    coverage: {
      provider: "v8",
      include: ["packages/**/src/**/*.{ts,tsx}"],
      exclude: ["packages/**/dist/**"],
      reporter: ["text", "text-summary", "html"],
      thresholds: {
        statements: 75,
        branches: 65,
        functions: 85,
        lines: 75,
      },
    },
  },
});
