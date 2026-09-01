import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { releaseIdentityFor } from "./release-channel.mjs";
import { stampReleaseChannel } from "./stamp-release-channel.mjs";

const temporaryRoots = [];
after(async () => {
  await Promise.all(
    temporaryRoots.map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function writeFixtures(product) {
  const root = await mkdtemp(path.join(os.tmpdir(), "review-release-stamp-"));
  temporaryRoots.push(root);
  const packagePath = path.join(root, "package.json");
  const productPath = path.join(root, "code-oss", "product.json");
  await mkdir(path.dirname(productPath), { recursive: true });
  await writeFile(packagePath, '{"name":"fixture","version":"1.2.3"}\n');
  await writeFile(productPath, `${JSON.stringify(product, null, "\t")}\n`);
  return { packagePath, productPath };
}

test("stamps the package version, review version, and release quality", async () => {
  const paths = await writeFixtures({
    ...releaseIdentityFor("stable"),
    reviewVersion: "1.2.3",
    quality: "stable",
  });

  stampReleaseChannel({
    version: "1.2.4-preview.20260901.42",
    quality: "preview",
    ...paths,
  });

  const pkg = JSON.parse(await readFile(paths.packagePath, "utf8"));
  const product = JSON.parse(await readFile(paths.productPath, "utf8"));
  assert.equal(pkg.version, "1.2.4-preview.20260901.42");
  assert.equal(product.reviewVersion, "1.2.4-preview.20260901.42");
  assert.equal(product.quality, "preview");
  for (const [field, value] of Object.entries(releaseIdentityFor("preview"))) {
    assert.equal(product[field], value, field);
  }
});

test("defaults to the stable release quality", async () => {
  const paths = await writeFixtures({
    ...releaseIdentityFor("stable"),
    reviewVersion: "1.2.3",
    quality: "stable",
  });

  stampReleaseChannel({ version: "1.2.4", ...paths });

  const product = JSON.parse(await readFile(paths.productPath, "utf8"));
  assert.equal(product.reviewVersion, "1.2.4");
  assert.equal(product.quality, "stable");
  for (const [field, value] of Object.entries(releaseIdentityFor("stable"))) {
    assert.equal(product[field], value, field);
  }
});

for (const marker of [
  "reviewVersion",
  "quality",
  ...Object.keys(releaseIdentityFor("stable")),
]) {
  test(`rejects a product without a ${marker} marker`, async () => {
    const product = {
      ...releaseIdentityFor("stable"),
      reviewVersion: "1.2.3",
      quality: "stable",
    };
    delete product[marker];
    const paths = await writeFixtures(product);

    assert.throws(
      () =>
        stampReleaseChannel({
          version: "1.2.4",
          quality: "preview",
          ...paths,
        }),
      new RegExp(marker),
    );
  });
}

test("rejects an unsupported release quality", async () => {
  const paths = await writeFixtures({
    ...releaseIdentityFor("stable"),
    reviewVersion: "1.2.3",
    quality: "stable",
  });
  assert.throws(
    () =>
      stampReleaseChannel({ version: "1.2.4", quality: "nightly", ...paths }),
    /stable or preview/,
  );
});

test("requires a release version", async () => {
  const paths = await writeFixtures({
    ...releaseIdentityFor("stable"),
    reviewVersion: "1.2.3",
    quality: "stable",
  });
  assert.throws(() => stampReleaseChannel({ ...paths }), /version is required/);
});
