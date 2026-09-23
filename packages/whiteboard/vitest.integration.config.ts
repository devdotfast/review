import { defineConfig } from "vitest/config";

import { whiteboardTestAliases } from "./test-config";

export default defineConfig({
  resolve: { alias: whiteboardTestAliases },
  test: {
    include: ["scripts/*.integration.mjs"],
    maxWorkers: 1,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
