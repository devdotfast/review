import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const readSource = (relativePath) =>
  readFile(new URL(relativePath, import.meta.url), "utf8");

const product = JSON.parse(await readSource("../code-oss/product.json"));

const themePackage = JSON.parse(
  await readSource("../code-oss/extensions/review-themes/package.json"),
);

test("uses slash-form branding in Review Desktop display surfaces", () => {
  assert.equal(product.nameLong, "/dev/fast Review");
  assert.equal(product.win32NameVersion, "/dev/fast Review");
  assert.equal(themePackage.description, "Themes for /dev/fast Review.");
});

test("keeps compatibility-sensitive Desktop identifiers unchanged", () => {
  assert.equal(product.darwinBundleIdentifier, "dev.fast.review");
  assert.equal(product.updateUrl, "https://update.dev.fast");
  assert.equal(product.urlProtocol, "dev-fast-review");
  assert.equal(product.dataFolderName, ".dev-fast-review");
  assert.equal(product.sharedDataFolderName, ".dev-fast-review-shared");
});

test("uses the product short name for app bundle paths", async () => {
  assert.equal(product.nameShort, "Review");
  assert.equal(product.win32DirName, "Review");
});
