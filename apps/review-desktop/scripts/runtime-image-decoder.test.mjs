import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { assertRuntimeImageDecoder } from "./stage-review-runtime.mjs";

test("the installed platform decoder can round-trip every supported raster format", async () => {
  await assertRuntimeImageDecoder(
    fileURLToPath(new URL("../../../", import.meta.url)),
  );
});

test("staging rejects a runtime without its own native decoder instead of using the parent checkout", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "review-image-runtime-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(
    assertRuntimeImageDecoder(root),
    /Deploy production dependencies, including optional sharp binaries/,
  );
});

test("staging exercises decoding rather than only checking that the module can load", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "review-image-runtime-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const moduleDirectory = path.join(root, "node_modules/sharp");
  await mkdir(moduleDirectory, { recursive: true });
  await writeFile(
    path.join(moduleDirectory, "index.js"),
    "module.exports = () => { throw new Error('Native decoder unavailable'); };\n",
  );
  await assert.rejects(
    assertRuntimeImageDecoder(root),
    /image decoder cannot run/,
  );
});
