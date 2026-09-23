import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@dev.fast/json": fileURLToPath(
        new URL("../json/src/index.ts", import.meta.url),
      ),
      "@dev.fast/local-vcs": fileURLToPath(
        new URL("../local-vcs/src/index.ts", import.meta.url),
      ),
      "@dev.fast/trace-protocol": fileURLToPath(
        new URL("../trace-protocol/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    environment: "node",
    maxWorkers: 1,
    isolate: false,
    testTimeout: 15000,
    env: {
      DEV_REVIEW_HOME: path.join(
        os.tmpdir(),
        `trace-core-tests-${process.pid}`,
      ),
      GITHUB_REPOSITORY: "",
    },
  },
});
