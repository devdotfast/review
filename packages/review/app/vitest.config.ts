import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import react from "@vitejs/plugin-react";
import { playwright } from "@vitest/browser-playwright";
import { configDefaults, defineConfig } from "vitest/config";

import { reviewTestAliases } from "../test-config";

const require = createRequire(import.meta.url);

const alias = {
  ...reviewTestAliases,
  "decode-named-character-reference": path.join(
    path.dirname(require.resolve("decode-named-character-reference")),
    "index.js",
  ),
};

export default defineConfig({
  test: {
    env: {
      DEV_REVIEW_HOME: path.join(
        os.tmpdir(),
        `review-canvas-tests-${process.pid}`,
      ),
      GITHUB_REPOSITORY: "",
    },
    maxWorkers: 1,
    projects: [
      {
        resolve: { alias },
        test: {
          name: "canvas-node",
          environment: "node",
          isolate: false,
          exclude: [
            ...configDefaults.exclude,
            "src/**/*.browser.test.{ts,tsx}",
          ],
          testTimeout: 15_000,
        },
      },
      {
        plugins: [react()],
        resolve: { alias, dedupe: ["react", "react-dom"] },
        test: {
          name: "browser",
          include: ["src/**/*.browser.test.{ts,tsx}"],
          isolate: process.env.CI === "true",
          setupFiles: ["src/browser-test-setup.ts"],
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
