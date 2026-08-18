import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { curatedGroups } from "./curated-extensions.manifest.mjs";

const reviewConfiguration = await readFile(
  new URL(
    "../code-oss/src/vs/review/common/reviewConfigurationDefaults.ts",
    import.meta.url,
  ),
  "utf8",
);
const settingsPage = await readFile(
  new URL(
    "../../../packages/progressive-review/app/src/settings-page.tsx",
    import.meta.url,
  ),
  "utf8",
);
const reviewReadme = await readFile(
  new URL("../README.md", import.meta.url),
  "utf8",
);

/**
 * Setting prefixes each curated extension group owns. A group maps to an empty
 * list only when its extensions prompt for nothing — say so out loud, so adding a
 * chatty extension to an existing group is a decision rather than an oversight.
 */
const settingPrefixes = {
  python: ["python"],
  rust: ["rust-analyzer"],
  go: ["go"],
  swift: ["swift"],
  csharp: ["dotnetAcquisitionExtension"],
  // Keymap extensions render no notifications.
  vim: [],
  emacs: [],
};

function curatedDefaultKeys() {
  const block = reviewConfiguration.match(
    /export const curatedExtensionConfigurationDefaults = \{([\s\S]*?)\n\} as const;/,
  );
  assert.ok(block, "curatedExtensionConfigurationDefaults is missing");
  return [...block[1].matchAll(/^\t'([^']+)':/gm)].map((match) => match[1]);
}

test("every curated extension group has a stated defaults position", () => {
  assert.deepEqual(
    Object.keys(settingPrefixes).sort(),
    [...curatedGroups].sort(),
    "settingPrefixes must cover exactly the curated groups",
  );

  const keys = curatedDefaultKeys();
  for (const [group, prefixes] of Object.entries(settingPrefixes)) {
    if (prefixes.length === 0) {
      continue;
    }
    for (const prefix of prefixes) {
      assert.ok(
        keys.some((key) => key.startsWith(`${prefix}.`)),
        `curated group "${group}" ships extensions but has no "${prefix}.*" defaults`,
      );
    }
  }
});

test("carries no defaults for extensions Review stopped shipping", () => {
  const owned = Object.values(settingPrefixes).flat();
  for (const key of curatedDefaultKeys()) {
    assert.ok(
      owned.some((prefix) => key.startsWith(`${prefix}.`)),
      `"${key}" belongs to no curated extension group`,
    );
  }
});

test("keeps the Pylance install prompt closed", () => {
  assert.match(reviewConfiguration, /'python\.languageServer': 'None',/);
});

test("keeps optional extension prompts and telemetry closed", () => {
  assert.match(
    reviewConfiguration,
    /'swift\.disableSwiftlyInstallPrompt': true,/,
  );
  assert.match(
    reviewConfiguration,
    /'dotnetAcquisitionExtension\.enableTelemetry': false,/,
  );
  assert.match(
    reviewConfiguration,
    /'dotnetAcquisitionExtension\.enableLanguageModelTools': false/,
  );
  assert.doesNotMatch(
    reviewConfiguration,
    /'dotnetAcquisitionExtension\.(?:existingDotnetPath|sharedExistingDotnetPath)'/,
  );
});

test("explains optional extension consent and toolchain requirements", () => {
  assert.match(settingsPage, /Install or turn on language extensions\./);
  assert.match(reviewReadme, /Rust moved from bundled to optional\./);
  assert.match(reviewReadme, /Install a Swift toolchain/);
  assert.match(reviewReadme, /Install a system \.NET SDK/);
  assert.match(reviewReadme, /Review does not download \.NET\./);
  assert.match(reviewReadme, /only after the user selects it/);
  assert.match(
    reviewReadme,
    /updates installed optional groups to the catalog pins/,
  );
});

test("does not import the workspace-file finder that prompts on startup", async () => {
  const reviewMain = await readFile(
    new URL("../code-oss/src/vs/review/review.common.main.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(reviewMain, /contrib\/workspaces\/browser\/workspaces\./);
});
