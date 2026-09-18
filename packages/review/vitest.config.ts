import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { playwright } from "@vitest/browser-playwright";
import { configDefaults, defineConfig } from "vitest/config";

const require = createRequire(import.meta.url);

const decodeNamedCharacterReferenceIndex = path.join(
  path.dirname(require.resolve("decode-named-character-reference")),
  "index.js",
);

const alias = {
  "@dev.fast/review-share-protocol": fileURLToPath(
    new URL("../review-share-protocol/src/index.ts", import.meta.url),
  ),
  "@dev.fast/trace-core": fileURLToPath(
    new URL("../trace-core/src/index.ts", import.meta.url),
  ),
  "@dev.fast/json": fileURLToPath(
    new URL("../json/src/index.ts", import.meta.url),
  ),
  "@dev.fast/local-vcs": fileURLToPath(
    new URL("../local-vcs/src/index.ts", import.meta.url),
  ),
  "@dev.fast/review-protocol": fileURLToPath(
    new URL("../review-protocol/src/index.ts", import.meta.url),
  ),
  // review-protocol's source imports trace-protocol directly; without this
  // alias, Vite falls through to node_modules and needs trace-protocol's
  // `dist` built (see Task 3's from-source lanes).
  "@dev.fast/trace-protocol": fileURLToPath(
    new URL("../trace-protocol/src/index.ts", import.meta.url),
  ),
  "decode-named-character-reference": decodeNamedCharacterReferenceIndex,
};

export default defineConfig({
  test: {
    env: {
      DEV_REVIEW_HOME: path.join(
        os.tmpdir(),
        `progressive-review-tests-${process.pid}`,
      ),
      // GitHub Actions exports the repository slug, which the trace code
      // honors over a checkout's remote; scratch repositories in tests must
      // resolve to their own remotes.
      GITHUB_REPOSITORY: "",
    },
    // The repository gate already runs two package lanes on a two-core host.
    // Keep Review on one worker so it does not starve the other lane. Shared
    // module graphs retain most of the single-package parallelism benefit.
    maxWorkers: 1,
    projects: [
      {
        resolve: { alias },
        test: {
          name: "shared-module-graph",
          environment: "node",
          isolate: false,
          exclude: [
            ...configDefaults.exclude,
            "app/src/**/*.browser.test.{ts,tsx}",
          ],
          // Integration cases can exceed Vitest's
          // 5 second default while sharing a two-core hosted runner.
          testTimeout: 15_000,
        },
      },
      {
        plugins: [react()],
        resolve: { alias, dedupe: ["react", "react-dom"] },
        test: {
          name: "browser",
          include: ["app/src/**/*.browser.test.{ts,tsx}"],
          isolate: process.env.CI === "true",
          setupFiles: ["app/src/browser-test-setup.ts"],
          testTimeout: 15_000,
          browser: {
            enabled: true,
            headless: true,
            provider: playwright(),
            instances: [{ browser: "chromium" }],
            viewport: { width: 1280, height: 900 },
            screenshotFailures: true,
            trace: process.env.CI === "true" ? "retain-on-failure" : "off",
          },
        },
      },
    ],
  },
});
