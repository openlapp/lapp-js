import { defineConfig } from "vitest/config";

export default defineConfig({
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
        // Informational only — no hard fail gate yet.
        statements: 0,
        branches: 0,
        functions: 0,
        lines: 0,
      },
    },
  },
});