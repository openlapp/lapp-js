import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@openlapp/lapp": fileURLToPath(new URL("./packages/lapp/src/index.ts", import.meta.url)),
    },
  },
  test: {
    include: ["packages/**/test/**/*.test.ts"],
    environment: "node",
    globals: false,
    pool: "threads",
    coverage: {
      provider: "v8",
      include: ["packages/**/src/**/*.ts"],
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
