#!/usr/bin/env node
// Regenerates the committed app-icon asset catalog from dev-fast.icon.
//
// The catalog is committed because compiling a .icon needs Xcode 26 and release packaging
// runs on macos-15. Run this after editing the .icon, on a machine with Xcode 26, and
// commit both outputs together.
//
// actool embeds non-deterministic data, so two compiles of the same source differ byte for
// byte and the artifact cannot be used to detect staleness. Instead this records a digest
// of the source it compiled, which app-icon-catalog.test.mjs checks against the .icon.
//
// Usage: node build-app-icon-catalog.mjs

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ICONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/progressive-review/app/icons",
);
export const ICON_SOURCE = path.join(ICONS_DIR, "dev-fast.icon");
export const CATALOG = path.join(ICONS_DIR, "Assets.car");
export const SOURCE_DIGEST = path.join(ICONS_DIR, "Assets.car.source-sha256");
export const ICON_NAME = "dev-fast";
export const DEPLOYMENT_TARGET = "26.0";

/** Digest of every file in the .icon bundle, path-sorted so it is stable across machines. */
export function hashIconSource(dir = ICON_SOURCE) {
  const files = [];
  (function walk(current) {
    for (const entry of readdirSync(current).sort()) {
      const full = path.join(current, entry);
      if (statSync(full).isDirectory()) walk(full);
      else files.push(full);
    }
  })(dir);

  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(path.relative(dir, file));
    hash.update(readFileSync(file));
  }
  return hash.digest("hex");
}

/** Compiles the .icon, returning the catalog path, or null where actool cannot. */
export function compileCatalog(outDir, iconSource = ICON_SOURCE) {
  const result = spawnSync(
    "xcrun",
    [
      "actool",
      "--app-icon",
      ICON_NAME,
      "--include-all-app-icons",
      "--output-partial-info-plist",
      path.join(outDir, "partial.plist"),
      "--platform",
      "macosx",
      "--minimum-deployment-target",
      DEPLOYMENT_TARGET,
      "--compile",
      outDir,
      iconSource,
    ],
    { encoding: "utf8" },
  );
  const compiled = path.join(outDir, "Assets.car");
  // Older actool exits zero while emitting nothing, so trust the output not the status.
  return result.status === 0 && existsSync(compiled) ? compiled : null;
}

function main() {
  if (process.platform !== "darwin") {
    console.error("build-app-icon-catalog: macOS only");
    process.exit(1);
  }
  if (!existsSync(ICON_SOURCE)) {
    console.error("build-app-icon-catalog: no icon source at " + ICON_SOURCE);
    process.exit(1);
  }

  const workDir = mkdtempSync(path.join(tmpdir(), "app-icon-catalog-"));
  try {
    const compiled = compileCatalog(workDir);
    if (!compiled) {
      console.error(
        "build-app-icon-catalog: actool could not compile the .icon; this needs Xcode 26",
      );
      process.exit(1);
    }
    copyFileSync(compiled, CATALOG);
    writeFileSync(SOURCE_DIGEST, hashIconSource() + "\n");
    console.log(
      "build-app-icon-catalog: wrote " +
        path.basename(CATALOG) +
        " and " +
        path.basename(SOURCE_DIGEST) +
        "; commit both",
    );
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
