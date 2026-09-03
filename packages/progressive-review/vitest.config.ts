import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { configDefaults, defineConfig } from "vitest/config";

const require = createRequire(import.meta.url);
const decodeNamedCharacterReferenceIndex = path.join(
  path.dirname(require.resolve("decode-named-character-reference")),
  "index.js",
);

const isolatedTests = [
  "app/src/review-document-boundary.test.tsx",
  "app/src/review-panel.test.tsx",
  "app/src/review-ui-state.test.ts",
  "app/src/side-panel-resizer.test.tsx",
  "src/compiler/review-document-compiler.test.ts",
  "src/review-source-ref-errors.test.ts",
  "src/map-cli-entry.test.ts",
];

export default defineConfig({
  resolve: {
    alias: {
      "@dev.fast/local-vcs": fileURLToPath(
        new URL("../local-vcs/src/index.ts", import.meta.url),
      ),
      "@dev-fast/trace-shared": fileURLToPath(
        new URL("../trace-shared/src/index.ts", import.meta.url),
      ),
      "decode-named-character-reference": decodeNamedCharacterReferenceIndex,
    },
  },
  test: {
    env: {
      DEV_REVIEW_HOME: path.join(
        os.tmpdir(),
        `progressive-review-tests-${process.pid}`,
      ),
    },
    // The repository gate already runs two package lanes on a two-core host.
    // Keep Review on one worker so it does not starve the other lane. Shared
    // module graphs retain most of the single-package parallelism benefit.
    maxWorkers: 1,
    projects: [
      {
        test: {
          name: "shared-module-graph",
          environment: "node",
          isolate: false,
          exclude: [...configDefaults.exclude, ...isolatedTests],
          // Individual full-pipeline compiler cases can exceed Vitest's
          // 5 second default while sharing a two-core hosted runner.
          testTimeout: 15_000,
        },
      },
      {
        test: {
          name: "isolated",
          environment: "node",
          include: isolatedTests,
          testTimeout: 15_000,
        },
      },
    ],
  },
});
