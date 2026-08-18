import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { dirs } from "../code-oss/build/npm/dirs.ts";

const vendorTimeExclusions = [
  ".github",
  ".vscode",
  "build/azure-pipelines",
  "extensions/copilot",
  "extensions/vscode-colorize-perf-tests",
  "extensions/vscode-colorize-tests",
];

const reviewUnusedInstallTargets = [
  "remote",
  "remote/web",
  "test/automation",
  "test/integration/browser",
  "test/monaco",
  "test/smoke",
  "test/mcp",
];

test("postinstall does not target vendor-time exclusions", () => {
  const excludedTargets = dirs.filter((directory) =>
    vendorTimeExclusions.some(
      (excluded) =>
        directory === excluded || directory.startsWith(`${excluded}/`),
    ),
  );

  assert.deepEqual(excludedTargets, []);
});
test("extension compilation does not target vendor-time exclusions", async () => {
  const source = await readFile(
    new URL("../code-oss/build/gulpfile.extensions.ts", import.meta.url),
    "utf8",
  );
  const compilationTargets = [
    ...source.matchAll(/['"]([^'"]+\/tsconfig\.json)['"]/g),
  ].map((match) => match[1]);
  const excludedTargets = compilationTargets.filter((target) =>
    vendorTimeExclusions.some(
      (excluded) =>
        target === excluded || target.startsWith(`${excluded}/`),
    ),
  );

  assert.deepEqual(excludedTargets, []);
});

test("postinstall does not install unused remote and upstream test packages", () => {
  const unusedTargets = dirs.filter((directory) =>
    reviewUnusedInstallTargets.includes(directory),
  );

  assert.deepEqual(unusedTargets, []);
});
