import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

// Released bundles are minified, so a stack frame from one is only a position
// in a very long line. This uploads the bundles' source maps to PostHog error
// tracking, which resolves those positions back to source files and functions.
//
// The PostHog CLI tags each bundle with a chunk ID and writes the same ID into
// its map. Frames are matched to a map by that ID, so this also records which
// bundle carries which ID; the Review server reads that manifest to put the ID
// on each frame it reports (packages/review/src/exception-telemetry.ts).
//
// Run it after the minified build and before packaging copies the bundles, so
// the app ships exactly the files whose maps were uploaded.

const APP_DIR = path.resolve(import.meta.dirname, "..");

const POSTHOG_CLI = "@posthog/cli@0.18.3";

const RELEASE_NAME = "review-desktop";

/** The Review server reads this file from the packaged `out` directory. */
export const CHUNK_ID_MANIFEST = "review-chunk-ids.json";

const CHUNK_ID_TRAILER = /\n\/\/# chunkId=([0-9a-f-]{36})\s*$/;

/** Map each injected bundle, by its path relative to `outDir`, to its chunk ID. */
export function collectChunkIds(outDir) {
  const chunkIds = {};

  for (const entry of readdirSync(outDir, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!entry.isFile() || !entry.name.endsWith(".js")) continue;
    const file = path.join(entry.parentPath, entry.name);
    const match = CHUNK_ID_TRAILER.exec(readFileSync(file, "utf8"));

    if (match) {
      chunkIds[path.relative(outDir, file).split(path.sep).join("/")] =
        match[1];
    }
  }

  return chunkIds;
}

function main() {
  const { values } = parseArgs({
    options: { out: { type: "string" } },
  });

  if (!values.out) {
    console.error("usage: upload-source-maps.mjs --out <minified out dir>");
    process.exit(2);
  }

  for (const name of ["POSTHOG_CLI_API_KEY", "POSTHOG_CLI_PROJECT_ID"]) {
    if (!process.env[name]) {
      throw new Error(`${name} is required to upload source maps`);
    }
  }

  const outDir = path.resolve(values.out);

  const { version } = JSON.parse(
    readFileSync(path.join(APP_DIR, "package.json"), "utf8"),
  );

  execFileSync(
    "npx",
    [
      "--yes",
      POSTHOG_CLI,
      "--host",
      process.env.POSTHOG_CLI_HOST ?? "https://us.posthog.com",
      "sourcemap",
      "process",
      "--directory",
      outDir,
      "--release-name",
      RELEASE_NAME,
      "--release-version",
      version,
    ],
    { stdio: "inherit" },
  );

  const chunkIds = collectChunkIds(outDir);

  if (Object.keys(chunkIds).length === 0) {
    throw new Error(`No bundle in ${outDir} carries a chunk ID`);
  }

  writeFileSync(
    path.join(outDir, CHUNK_ID_MANIFEST),
    `${JSON.stringify(chunkIds, null, 2)}\n`,
  );
  console.log(
    `Uploaded source maps for ${Object.keys(chunkIds).length} bundles`,
  );
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  main();
}
