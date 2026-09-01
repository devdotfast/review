import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import {
  assertPackagedProduct,
  assertReleaseChannel,
  assertUpdaterCompatibleApp,
  buildManifest,
} from "./validate-release-artifacts.mjs";

const temporaryRoots = [];
after(async () => {
  await Promise.all(
    temporaryRoots.map((root) => rm(root, { recursive: true, force: true })),
  );
});

const PRODUCT = {
  commit: "abc123",
  quality: "stable",
  updateUrl: "https://update.dev.fast",
  darwinBundleIdentifier: "dev.fast.review",
};

test("buildManifest emits the schema the update Worker serves", () => {
  const now = new Date("2026-07-29T00:00:00.000Z");
  const manifest = buildManifest({
    version: "1.2.3",
    commit: "abc123",
    zipSha256: "cafe",
    now,
  });

  assert.deepEqual(manifest, {
    version: "1.2.3",
    commit: "abc123",
    url: "https://update.dev.fast/releases/1.2.3/darwin-arm64/Review-darwin-arm64-1.2.3.zip",
    name: "1.2.3",
    pub_date: "2026-07-29T00:00:00.000Z",
    timestamp: now.getTime(),
    sha256hash: "cafe",
  });
});

test("assertPackagedProduct accepts a correctly stamped product", () => {
  assertPackagedProduct(PRODUCT, { commit: "abc123" });
});

test("assertPackagedProduct accepts a preview-stamped product", () => {
  assertPackagedProduct(
    { ...PRODUCT, quality: "preview" },
    { commit: "abc123", channel: "preview" },
  );
});

test("assertPackagedProduct rejects a cross-channel product", () => {
  assert.throws(
    () =>
      assertPackagedProduct(PRODUCT, {
        commit: "abc123",
        channel: "preview",
      }),
    /quality/,
  );
});

test("assertReleaseChannel rejects an unsupported channel", () => {
  assert.throws(() => assertReleaseChannel("nightly"), /stable or preview/);
});

test("assertPackagedProduct rejects a mismatched commit", () => {
  assert.throws(
    () => assertPackagedProduct(PRODUCT, { commit: "def456" }),
    /commit/,
  );
});

test("assertPackagedProduct rejects a build without hardened update config", () => {
  assert.throws(
    () =>
      assertPackagedProduct(
        { ...PRODUCT, updateUrl: "" },
        { commit: "abc123" },
      ),
    /updateUrl/,
  );
});

test("assertUpdaterCompatibleApp rejects read-only package files", async () => {
  const app = await mkdtemp(path.join(os.tmpdir(), "review-update-app-"));
  temporaryRoots.push(app);
  const resources = path.join(app, "Contents", "Resources");
  await mkdir(resources, { recursive: true });
  const object = path.join(resources, "git-object");
  await writeFile(object, "object");
  await chmod(object, 0o444);

  assert.throws(() => assertUpdaterCompatibleApp(app), /git-object/);

  await chmod(object, 0o644);
  assert.doesNotThrow(() => assertUpdaterCompatibleApp(app));
});
