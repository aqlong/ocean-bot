import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    include: ["src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "dist"],
    testTimeout: 10000,
    // journal.test.ts hits the test Postgres DB. Serializing files keeps
    // its TRUNCATE-based fixtures from racing other DB writers (today
    // only journal, but future-proofs for cas/inference-audit tests).
    fileParallelism: false,
  },
});
