import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/domain/__tests__/xrayConfigContract.live.test.ts"],
    hookTimeout: 30_000,
    testTimeout: 30_000,
  },
});
