// The compiled app-icon catalog is committed because release runners cannot build it:
// compiling a .icon needs Xcode 26 and packaging runs on macos-15. That lets the artifact
// fall out of step with the .icon it came from, shipping stale artwork with no signal.
//
// actool embeds non-deterministic data, so recompiling and comparing bytes reports drift
// that is not real. Instead build-app-icon-catalog.mjs records a digest of the source it
// compiled, and this checks that digest still describes the .icon on disk.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  ICON_VARIANTS,
  getIconVariant,
  hashIconSource,
} from "./build-app-icon-catalog.mjs";

const appRoot = path.resolve(import.meta.dirname, "..");
const previewWorkflow = readFileSync(
  path.resolve(appRoot, "../../.github/workflows/review-desktop-preview.yml"),
  "utf8",
);
const stableWorkflow = readFileSync(
  path.resolve(appRoot, "../../.github/workflows/review-desktop-release.yml"),
  "utf8",
);
const applyAppIcon = readFileSync(
  path.resolve(import.meta.dirname, "apply-app-icon.mjs"),
  "utf8",
);

for (const [channel, variant] of Object.entries(ICON_VARIANTS)) {
  test(`committed ${channel} Assets.car was built from the current .icon`, () => {
    const regenerate =
      "regenerate with: node scripts/build-app-icon-catalog.mjs " +
      `--channel ${channel} (needs Xcode 26)`;
    assert.ok(
      existsSync(variant.iconSource),
      path.basename(variant.iconSource) + " is missing",
    );
    assert.ok(
      existsSync(variant.catalog),
      path.basename(variant.catalog) + " is missing; " + regenerate,
    );
    assert.ok(
      existsSync(variant.sourceDigest),
      path.basename(variant.sourceDigest) + " is missing; " + regenerate,
    );
    if (variant.fallback) {
      assert.ok(
        existsSync(variant.fallback),
        path.basename(variant.fallback) + " is missing; " + regenerate,
      );
    }

    assert.equal(
      hashIconSource(variant.iconSource),
      readFileSync(variant.sourceDigest, "utf8").trim(),
      path.basename(variant.iconSource) +
        " changed but its catalog was not rebuilt; " +
        regenerate,
    );
  });
}

test("stable remains the default icon channel", () => {
  assert.equal(getIconVariant(), ICON_VARIANTS.stable);
  assert.equal(getIconVariant("stable"), ICON_VARIANTS.stable);
  assert.equal(getIconVariant("preview"), ICON_VARIANTS.preview);
  assert.throws(() => getIconVariant("nightly"), /stable or preview/);
});

test("preview uses the approved orange background", () => {
  const previewIcon = JSON.parse(
    readFileSync(path.join(ICON_VARIANTS.preview.iconSource, "icon.json")),
  );
  assert.equal(
    previewIcon.fill["automatic-gradient"],
    "display-p3:0.85098,0.46667,0.34118,1.00000",
  );
});

test("only the preview workflow opts into the preview icon", () => {
  assert.match(previewWorkflow, /REVIEW_APP_ICON_CHANNEL:\s*preview/);
  assert.doesNotMatch(stableWorkflow, /REVIEW_APP_ICON_CHANNEL/);
  assert.match(
    applyAppIcon,
    /getIconVariant\(process\.env\.REVIEW_APP_ICON_CHANNEL\)/,
  );
});
