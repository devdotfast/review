import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Review Desktop can opt into Chromium renderer accessibility", async () => {
  const source = await readFile(new URL("./run.sh", import.meta.url), "utf8");
  const mainSource = await readFile(
    new URL("../code-oss/src/vs/code/electron-main/main.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /DEV_FAST_REVIEW_FORCE_ACCESSIBILITY/u);
  assert.match(source, /--force-renderer-accessibility/u);
  assert.match(
    mainSource,
    /DEV_FAST_REVIEW_FORCE_ACCESSIBILITY[\s\S]*setAccessibilitySupportEnabled\(true\)/u,
  );
});
