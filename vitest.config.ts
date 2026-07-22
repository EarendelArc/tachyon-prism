import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    exclude: ["src/**/*.live.test.ts"],
    include: ["src/**/*.test.ts"],
    hookTimeout: 30_000,
    testTimeout: 120_000,
  },
});
