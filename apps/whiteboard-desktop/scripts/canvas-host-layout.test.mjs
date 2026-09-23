import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const whiteboardCanvasPart = await readFile(
  new URL(
    "../code-oss/src/vs/whiteboard/browser/parts/canvas/whiteboardCanvasPart.ts",
    import.meta.url,
  ),
  "utf8",
);

const whiteboardCss = await readFile(
  new URL("../code-oss/src/vs/whiteboard/browser/media/whiteboard.css", import.meta.url),
  "utf8",
);

test("peek overflow widgets host lives outside the canvas root", () => {
  // Inside the workbench container (theme variables are scoped to
  // .monaco-workbench), never inside the canvas surface.
  assert.match(
    whiteboardCanvasPart,
    /layoutService\s*\.getContainer\(getWindow\(parent\)\)\s*\.appendChild\(overflowWidgets\)/,
  );
  assert.match(
    whiteboardCanvasPart,
    /setOverflowWidgetsDomNode\(overflowWidgets\)/,
  );
  assert.match(
    whiteboardCss,
    /\.whiteboard-overflow-widgets\s*{[^}]*position:\s*fixed;/s,
  );
});

test("Review canvas restores text selection inside the workbench", () => {
  assert.match(
    whiteboardCss,
    /\.whiteboard-canvas-part \.whiteboard-canvas-host\s*{[^}]*-webkit-user-select:\s*text;[^}]*user-select:\s*text;/s,
  );
});
