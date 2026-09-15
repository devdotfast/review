import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@dev.fast/trace-core": fileURLToPath(
        new URL("../trace-core/src/index.ts", import.meta.url),
      ),
      "@dev.fast/trace-protocol": fileURLToPath(
        new URL("../trace-protocol/src/index.ts", import.meta.url),
      ),
      "@dev.fast/local-vcs": fileURLToPath(
        new URL("../local-vcs/src/index.ts", import.meta.url),
      ),
      "@dev.fast/json": fileURLToPath(
        new URL("../json/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    environment: "node",
    env: {
      DEV_REVIEW_HOME: path.join(
        os.tmpdir(),
        `dev-traces-tests-${process.pid}`,
      ),
      // GitHub Actions exports the repository slug, which the trace code
      // honors over a checkout's remote; scratch repositories in tests must
      // resolve to their own remotes.
      GITHUB_REPOSITORY: "",
    },
    testTimeout: 15_000,
  },
});
