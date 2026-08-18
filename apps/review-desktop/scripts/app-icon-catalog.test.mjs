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
  CATALOG,
  ICON_SOURCE,
  SOURCE_DIGEST,
  hashIconSource,
} from "./build-app-icon-catalog.mjs";

const REGENERATE =
  "regenerate with: node scripts/build-app-icon-catalog.mjs (needs Xcode 26)";

test("committed Assets.car was built from the current .icon", () => {
  assert.ok(existsSync(ICON_SOURCE), "dev-fast.icon is missing");
  assert.ok(
    existsSync(CATALOG),
    path.basename(CATALOG) + " is missing; " + REGENERATE,
  );
  assert.ok(
    existsSync(SOURCE_DIGEST),
    path.basename(SOURCE_DIGEST) + " is missing; " + REGENERATE,
  );

  assert.equal(
    hashIconSource(),
    readFileSync(SOURCE_DIGEST, "utf8").trim(),
    "dev-fast.icon changed but Assets.car was not rebuilt; " + REGENERATE,
  );
});
