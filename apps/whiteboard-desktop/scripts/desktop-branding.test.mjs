import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const readSource = (relativePath) =>
  readFile(new URL(relativePath, import.meta.url), "utf8");

const product = JSON.parse(await readSource("../code-oss/product.json"));

test("keeps compatibility-sensitive Desktop identifiers unchanged", () => {
  assert.equal(product.darwinBundleIdentifier, "dev.fast.review");
  assert.equal(product.updateUrl, "https://update.dev.fast");
  assert.equal(product.urlProtocol, "dev-fast-review");
  assert.equal(product.dataFolderName, ".dev-fast-review");
  assert.equal(product.sharedDataFolderName, ".dev-fast-review-shared");
});
