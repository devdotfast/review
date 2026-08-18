import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const reviewStyles = await readFile(
  new URL(
    "../code-oss/src/vs/review/browser/media/review.css",
    import.meta.url,
  ),
  "utf8",
);

test("Review canvas restores text selection inside the workbench", () => {
  assert.match(
    reviewStyles,
    /\.review-canvas-part \.review-canvas-host\s*{[^}]*-webkit-user-select:\s*text;[^}]*user-select:\s*text;/s,
  );
});
