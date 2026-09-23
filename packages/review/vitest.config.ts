import os from "node:os";
import path from "node:path";

import { configDefaults, defineConfig } from "vitest/config";

import { reviewTestAliases } from "./test-config";

export default defineConfig({
  test: {
    env: {
      DEV_WHITEBOARD_HOME: path.join(
        os.tmpdir(),
        `progressive-review-tests-${process.pid}`,
      ),
      // GitHub Actions exports the repository slug, which the trace code
      // honors over a checkout's remote; scratch repositories in tests must
      // resolve to their own remotes.
      GITHUB_REPOSITORY: "",
    },
    // The repository gate runs package lanes concurrently on a two-core host.
    // Keep Review on one worker so it does not starve the other lanes.
    maxWorkers: 1,
    projects: [
      {
        resolve: { alias: reviewTestAliases },
        test: {
          name: "shared-module-graph",
          environment: "node",
          isolate: false,
          exclude: [...configDefaults.exclude, "app/**"],
          // Integration cases can exceed Vitest's
          // 5 second default while sharing a two-core hosted runner.
          testTimeout: 15_000,
        },
      },
    ],
  },
});
