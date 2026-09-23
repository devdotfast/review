import { defineConfig } from "vitest/config";

import { reviewTestAliases } from "./test-config";

export default defineConfig({
  resolve: { alias: reviewTestAliases },
  test: {
    include: ["scripts/*.integration.mjs"],
    maxWorkers: 1,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
