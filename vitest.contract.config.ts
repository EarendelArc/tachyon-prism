import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/domain/__tests__/coreConfigContract.live.test.ts"],
    hookTimeout: 180_000,
    testTimeout: 180_000,
  },
});
