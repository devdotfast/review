// Gate between a packaged, notarized build and the R2 upload: verify the
// artifacts really are the release we think they are, then emit the
// latest.json manifest the update Worker serves (see apps/update/src/types.ts
// for the schema). Run from the release workflow after app:package:macos.
// Curated extension checks also read code-oss/package.json from this checkout.
//
//   node scripts/validate-release-artifacts.mjs \
//     --version 1.2.3 --commit <tag sha> [--artifact-dir dist]
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import { verifyCuratedExtensions } from "./curated-extensions.mjs";

const APP_DIR = path.resolve(import.meta.dirname, "..");
const UPDATE_URL = "https://update.dev.fast";

export function buildManifest({
  version,
  commit,
  zipSha256,
  now = new Date(),
}) {
  return {
    version,
    commit,
    url: `${UPDATE_URL}/releases/${version}/darwin-arm64/Review-darwin-arm64-${version}.zip`,
    name: version,
    pub_date: now.toISOString(),
    timestamp: now.getTime(),
    sha256hash: zipSha256,
  };
}

export function assertPackagedProduct(product, { commit }) {
  const expectations = {
    commit,
    quality: "stable",
    updateUrl: UPDATE_URL,
    darwinBundleIdentifier: "dev.fast.review",
  };
  for (const [key, expected] of Object.entries(expectations)) {
    if (product[key] !== expected) {
      throw new Error(
        `packaged product.json ${key} is ${JSON.stringify(product[key])}, expected ${JSON.stringify(expected)}`,
      );
    }
  }
}

export function assertUpdaterCompatibleApp(app) {
  const unwritable = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
        continue;
      }
      if (!entry.isFile()) continue;

      if ((lstatSync(absolute).mode & 0o200) === 0) {
        unwritable.push(path.relative(app, absolute));
      }
    }
  };
  walk(app);

  if (unwritable.length > 0) {
    const shown = unwritable.slice(0, 20).join("\n  ");
    const remaining = unwritable.length - Math.min(unwritable.length, 20);
    throw new Error(
      `packaged app contains files that the macOS updater cannot modify:\n  ${shown}${remaining > 0 ? `\n  ... and ${remaining} more` : ""}`,
    );
  }
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function run(command, args) {
  execFileSync(command, args, { stdio: "inherit" });
}

function main() {
  const { values } = parseArgs({
    options: {
      version: { type: "string" },
      commit: { type: "string" },
      "artifact-dir": { type: "string" },
    },
  });
  const { version, commit } = values;
  if (!version || !commit) {
    console.error(
      "usage: validate-release-artifacts.mjs --version <semver> --commit <sha> [--artifact-dir <dir>]",
    );
    process.exit(2);
  }

  const artifactDir = path.resolve(
    values["artifact-dir"] ?? path.join(APP_DIR, "dist"),
  );
  const app = path.join(APP_DIR, "VSCode-darwin-arm64", "Review.app");
  const zip = path.join(artifactDir, `Review-darwin-arm64-${version}.zip`);
  const dmg = path.join(artifactDir, `Review-darwin-arm64-${version}.dmg`);

  assertUpdaterCompatibleApp(app);
  const product = JSON.parse(
    readFileSync(
      path.join(app, "Contents", "Resources", "app", "product.json"),
      "utf8",
    ),
  );
  assertPackagedProduct(product, { commit });
  verifyCuratedExtensions({
    root: path.join(app, "Contents", "Resources", "app", "extensions"),
    target: "darwin-arm64",
  });

  run("xcrun", ["stapler", "validate", app]);
  run("spctl", ["-a", "-vv", "--type", "exec", app]);
  run("xcrun", ["stapler", "validate", dmg]);

  const manifest = buildManifest({ version, commit, zipSha256: sha256(zip) });
  const manifestPath = path.join(artifactDir, "latest.json");
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  console.log(`Validated release artifacts for ${version} (${commit}):`);
  console.log(`  ${zip} sha256=${manifest.sha256hash}`);
  console.log(`  ${dmg} sha256=${sha256(dmg)}`);
  console.log(`  ${manifestPath}`);
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  main();
}
