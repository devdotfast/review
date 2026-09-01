#!/usr/bin/env node
// Installs the Icon Composer app icon into a built macOS .app bundle.
//
// macOS 26 renders app icons from a compiled asset catalog (Assets.car) referenced by
// CFBundleIconName. That is what provides the light/dark/tintable appearance variants and
// the vector source; the .icns the packager installs is a single flattened appearance and
// is kept only as the pre-Tahoe fallback. code-oss packaging has no asset-catalog step, so
// this patches the bundle afterwards rather than modifying the vendored gulp pipeline.
//
// Usage: [REVIEW_APP_ICON_CHANNEL=preview] node apply-app-icon.mjs <path-to .app>
//        [--icon-name NAME]

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEPLOYMENT_TARGET,
  getIconVariant,
} from "./build-app-icon-catalog.mjs";

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const ICON_VARIANT = getIconVariant(process.env.REVIEW_APP_ICON_CHANNEL);
const ICON_SOURCE = ICON_VARIANT.iconSource;
// Compiling the .icon needs Xcode 26, which release runners do not have, so the compiled
// catalog is committed alongside the source and used when actool cannot produce one.
// app-icon-catalog.test.mjs fails if the two drift apart.
const PREBUILT_CATALOG = ICON_VARIANT.catalog;
// Asset-catalog app icons require macOS 26; the .icns fallback covers anything older.
const FALLBACK_ICNS =
  ICON_VARIANT.fallback ??
  path.resolve(SCRIPTS_DIR, "../code-oss/resources/darwin/code.icns");
const DEFAULT_ICON_NAME = ICON_VARIANT.iconName;

function fail(message) {
  console.error("apply-app-icon: " + message);
  process.exit(1);
}

function run(command, args) {
  return spawnSync(command, args, { encoding: "utf8" });
}

function runOrFail(command, args) {
  const result = run(command, args);
  if (result.status !== 0) {
    fail(command + " failed: " + (result.stderr || result.stdout || "").trim());
  }
  return result;
}

function parseArgs(argv) {
  const [appPath, ...rest] = argv;
  let iconName = DEFAULT_ICON_NAME;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] !== "--icon-name") fail("unexpected argument: " + rest[i]);
    if (!rest[i + 1]) fail("--icon-name requires a value");
    iconName = rest[i + 1];
    i++;
  }
  if (!appPath)
    fail("usage: apply-app-icon.mjs <path-to .app> [--icon-name NAME]");
  return { appPath, iconName };
}

const { appPath, iconName } = parseArgs(process.argv.slice(2));

if (process.platform !== "darwin") {
  console.log("apply-app-icon: not macOS, skipping");
  process.exit(0);
}
// actool ships with the Xcode command line tools. Without them, leave the packager's .icns
// in place rather than producing a bundle that claims a catalog it does not contain.
if (run("xcrun", ["--find", "actool"]).status !== 0) {
  console.log(
    "apply-app-icon: actool unavailable (install Xcode command line tools), keeping .icns fallback",
  );
  process.exit(0);
}

if (!existsSync(appPath)) fail("no bundle at " + appPath);
if (!existsSync(ICON_SOURCE)) fail("no icon source at " + ICON_SOURCE);

const resourcesDir = path.join(appPath, "Contents", "Resources");
const infoPlist = path.join(appPath, "Contents", "Info.plist");
if (!existsSync(resourcesDir)) fail("no Contents/Resources in " + appPath);
if (!existsSync(infoPlist)) fail("no Contents/Info.plist in " + appPath);

// The packager copies resources/darwin/code.icns into the bundle under a product-derived
// name (Review.icns) and only does so when it rebuilds Electron from scratch. build.sh
// skips that step whenever the binary already exists, so an existing checkout would keep
// whatever .icns it was first built with. Refresh it here so the fallback tracks the repo.
function refreshFallbackIcns() {
  if (!existsSync(FALLBACK_ICNS)) return;

  const iconFile = run("/usr/libexec/PlistBuddy", [
    "-c",
    "Print :CFBundleIconFile",
    infoPlist,
  ]);
  if (iconFile.status !== 0) return;

  const name = iconFile.stdout.trim();
  if (!name) return;
  const target = path.join(
    resourcesDir,
    name.endsWith(".icns") ? name : name + ".icns",
  );
  if (!existsSync(target)) return;

  copyFileSync(FALLBACK_ICNS, target);
  console.log(
    "apply-app-icon: refreshed " +
      path.basename(target) +
      " fallback for " +
      ICON_VARIANT.channel,
  );
}

function installIconCatalog(workDir) {
  const compiled = run("xcrun", [
    "actool",
    "--app-icon",
    iconName,
    "--include-all-app-icons",
    "--output-partial-info-plist",
    path.join(workDir, "partial.plist"),
    "--platform",
    "macosx",
    "--minimum-deployment-target",
    DEPLOYMENT_TARGET,
    "--compile",
    workDir,
    ICON_SOURCE,
  ]);

  // Compiling a .icon needs Xcode 26. Older actool builds accept the arguments and exit
  // zero while emitting nothing, so success is decided by the output rather than the exit
  // code. Where it cannot compile, fall back to the catalog committed next to the source.
  const compiledCatalog = path.join(workDir, "Assets.car");
  let catalog = compiledCatalog;
  if (compiled.status !== 0 || !existsSync(compiledCatalog)) {
    if (!existsSync(PREBUILT_CATALOG)) {
      console.warn(
        "apply-app-icon: actool could not compile " +
          path.basename(ICON_SOURCE) +
          " (needs Xcode 26) and no committed Assets.car, keeping .icns fallback",
      );
      return;
    }
    catalog = PREBUILT_CATALOG;
    console.log(
      "apply-app-icon: actool unavailable, using committed Assets.car",
    );
  }
  copyFileSync(catalog, path.join(resourcesDir, "Assets.car"));

  // Delete-then-Add so reruns over an already-patched bundle stay idempotent. The .icns
  // actool emits alongside the catalog is capped at 256px, so CFBundleIconFile keeps
  // pointing at the packager's own icon.
  run("/usr/libexec/PlistBuddy", ["-c", "Delete :CFBundleIconName", infoPlist]);
  runOrFail("/usr/libexec/PlistBuddy", [
    "-c",
    "Add :CFBundleIconName string " + iconName,
    infoPlist,
  ]);

  console.log(
    "apply-app-icon: installed " +
      iconName +
      " asset catalog into " +
      path.basename(appPath) +
      " for " +
      ICON_VARIANT.channel,
  );
}

// Editing bundle contents invalidates any existing signature, so this runs after every
// mutation above, including the fallback-only path. Ad-hoc re-signing keeps the bundle
// launchable locally; release signing runs later and replaces it.
function resignBundle() {
  const signed = run("codesign", ["--force", "--sign", "-", appPath]);
  if (signed.status !== 0) {
    console.warn(
      "apply-app-icon: ad-hoc codesign failed, bundle may not launch: " +
        (signed.stderr || "").trim(),
    );
  }
}

refreshFallbackIcns();

const workDir = mkdtempSync(path.join(tmpdir(), "review-app-icon-"));
try {
  installIconCatalog(workDir);
  resignBundle();
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
