import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const reviewCanvasPart = await readFile(
  new URL(
    "../code-oss/src/vs/review/browser/parts/canvas/reviewCanvasPart.ts",
    import.meta.url,
  ),
  "utf8",
);
const reviewCss = await readFile(
  new URL("../code-oss/src/vs/review/browser/media/review.css", import.meta.url),
  "utf8",
);

test("peek overflow widgets host lives outside the canvas root", () => {
  // Inside the workbench container (theme variables are scoped to
  // .monaco-workbench), never inside the canvas surface.
  assert.match(
    reviewCanvasPart,
    /layoutService\s*\.getContainer\(getWindow\(parent\)\)\s*\.appendChild\(overflowWidgets\)/,
  );
  assert.match(
    reviewCanvasPart,
    /setOverflowWidgetsDomNode\(overflowWidgets\)/,
  );
  assert.match(
    reviewCss,
    /\.review-overflow-widgets\s*{[^}]*position:\s*fixed;/s,
  );
});

test("Review canvas restores text selection inside the workbench", () => {
  assert.match(
    reviewCss,
    /\.review-canvas-part \.review-canvas-host\s*{[^}]*-webkit-user-select:\s*text;[^}]*user-select:\s*text;/s,
  );
});
