// Gate between a packaged, notarized build and the R2 upload: verify the
// artifacts really are the release we think they are, then emit the
// latest.json manifest the update Worker serves (see apps/update/src/types.ts
// for the schema). Run from the release workflow after app:package:macos.
// Curated extension checks also read code-oss/package.json from this checkout.
//
//   node scripts/validate-release-artifacts.mjs \
//     --version 1.2.3 --commit <tag sha> [--channel stable|preview]
//     [--artifact-dir dist]
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import { verifyCuratedExtensions } from "./curated-extensions.mjs";
import {
  assertReleaseChannel,
  releaseIdentityFor,
  updateBundlesFor,
  updateZipName,
} from "./release-channel.mjs";
import { assertPackagedArtifacts } from "./stage-review-runtime.mjs";

const APP_DIR = path.resolve(import.meta.dirname, "..");

const UPDATE_URL = "https://update.dev.fast";

export { assertReleaseChannel };

// `payloads` is one entry per update zip, in updateBundlesFor() order: the
// first is the default for clients that do not name their bundle folder.
export function buildManifest({ version, commit, payloads, now = new Date() }) {
  const bundles = Object.fromEntries(
    payloads.map(({ bundle, artifact, sha256 }) => [
      bundle,
      {
        url: `${UPDATE_URL}/releases/${version}/darwin-arm64/${updateZipName(artifact, version)}`,
        sha256hash: sha256,
      },
    ]),
  );
  const [fallback] = Object.values(bundles);

  return {
    version,
    commit,
    ...fallback,
    name: version,
    pub_date: now.toISOString(),
    timestamp: now.getTime(),
    bundles,
  };
}

// Squirrel installs the zip's top-level folder under that name, so a zip whose
// folder does not match the bundle it is served to would rename the install.
export function assertZipFolder(zip, folder) {
  const entries = execFileSync("unzip", ["-Z1", zip], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
  const roots = new Set(entries.map((entry) => entry.split("/")[0]));

  if (roots.size !== 1 || !roots.has(folder)) {
    throw new Error(
      `${zip} must contain only ${folder}/, found ${[...roots].join(", ") || "nothing"}`,
    );
  }
}

export function assertPackagedProduct(product, { commit, channel = "stable" }) {
  assertReleaseChannel(channel);

  const expectations = {
    commit,
    quality: channel,
    updateUrl: UPDATE_URL,
    ...releaseIdentityFor(channel),
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

async function main() {
  const { values } = parseArgs({
    options: {
      version: { type: "string" },
      commit: { type: "string" },
      channel: { type: "string", default: "stable" },
      "artifact-dir": { type: "string" },
    },
  });

  const { version, commit, channel } = values;

  if (!version || !commit) {
    console.error(
      "usage: validate-release-artifacts.mjs --version <semver> --commit <sha> [--channel stable|preview] [--artifact-dir <dir>]",
    );
    process.exit(2);
  }

  assertReleaseChannel(channel);

  const artifactDir = path.resolve(
    values["artifact-dir"] ?? path.join(APP_DIR, "dist"),
  );

  const sourceProduct = JSON.parse(
    readFileSync(path.join(APP_DIR, "code-oss", "product.json"), "utf8"),
  );

  const app = path.join(
    APP_DIR,
    "VSCode-darwin-arm64",
    `${sourceProduct.nameShort}.app`,
  );

  const zips = updateBundlesFor(channel).map(({ bundle, artifact }) => ({
    bundle,
    artifact,
    file: path.join(artifactDir, updateZipName(artifact, version)),
  }));
  const dmg = path.join(artifactDir, `Whiteboard-darwin-arm64-${version}.dmg`);

  await assertPackagedArtifacts(app);
  assertUpdaterCompatibleApp(app);

  const product = JSON.parse(
    readFileSync(
      path.join(app, "Contents", "Resources", "app", "product.json"),
      "utf8",
    ),
  );

  assertPackagedProduct(product, { commit, channel });
  verifyCuratedExtensions({
    root: path.join(app, "Contents", "Resources", "app", "extensions"),
    target: "darwin-arm64",
  });

  run("xcrun", ["stapler", "validate", app]);
  run("spctl", ["-a", "-vv", "--type", "exec", app]);
  run("xcrun", ["stapler", "validate", dmg]);

  for (const { bundle, file } of zips) {
    assertZipFolder(file, `${bundle}.app`);
  }

  const payloads = zips.map((zip) => ({ ...zip, sha256: sha256(zip.file) }));
  const manifest = buildManifest({ version, commit, payloads });
  const manifestPath = path.join(artifactDir, "latest.json");
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  console.log(`Validated release artifacts for ${version} (${commit}):`);
  for (const { bundle, file, sha256 } of payloads) {
    console.log(`  ${file} (${bundle}.app) sha256=${sha256}`);
  }
  console.log(`  ${dmg} sha256=${sha256(dmg)}`);
  console.log(`  ${manifestPath}`);
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  await main();
}
