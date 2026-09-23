import assert from "node:assert/strict";
import test from "node:test";

import { checkProductionDependencies } from "./whiteboard-cli-dependencies.mjs";

test("rejects browser tooling hidden behind a transitive dependency", () => {
  assert.throws(
    () =>
      checkProductionDependencies({
        dependencies: {
          "@dev.fast/whiteboard": {
            dependencies: {
              "innocent-library": {
                dependencies: { "playwright-core": { version: "1.0.0" } },
              },
            },
          },
        },
      }),
    /@dev.fast\/whiteboard -> innocent-library -> playwright-core/,
  );
});

test("accepts runtime libraries, including platform-specific image binaries", () => {
  assert.equal(
    checkProductionDependencies({
      dependencies: {
        sharp: {
          version: "1.0.0",
          dependencies: { "@img/sharp-linux-x64": { version: "1.0.0" } },
        },
        hono: { version: "1.0.0" },
      },
    }),
    3,
  );
});
