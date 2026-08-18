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

test("mounts the canvas host without a redundant local toolbar", () => {
  assert.match(
    reviewCanvasPart,
    /outer\.append\(this\.container\)/,
  );
  assert.doesNotMatch(reviewCanvasPart, /review-session-toolbar/);
  assert.doesNotMatch(reviewCanvasPart, /Active review session/);
  assert.match(
    reviewCss,
    /\.review-canvas-part\s*>\s*\.review-canvas-container\s*{[^}]*grid-template-rows:\s*minmax\(0,\s*1fr\);/s,
  );
  assert.doesNotMatch(reviewCss, /\.review-session-toolbar/);
});
