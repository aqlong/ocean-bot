import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    include: ["src/**/*.test.ts", "app/**/*.test.ts"],
    exclude: ["node_modules", ".next"],
    // Some test files write to a shared Postgres test DB (queries +
    // approval-ops integration tests). Running them in parallel makes
    // TRUNCATE-based fixtures collide. Force serial file execution.
    fileParallelism: false,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
