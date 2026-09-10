import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const canvasPartUrl = new URL(
  "../code-oss/src/vs/review/browser/parts/canvas/reviewCanvasPart.ts",
  import.meta.url,
);

// The canvas part has no rendering test; the entry's ready/diagnostic
// ordering does, in app/src/desktop-entry.test.tsx.
test("presented telemetry follows a successful visible canvas ready signal", async () => {
  const canvasPart = await readFile(canvasPartUrl, "utf8");

  const visibleBridge = canvasPart.slice(
    canvasPart.indexOf("private createBridge("),
    canvasPart.indexOf("private async validateSessionMount("),
  );
  assert.match(
    visibleBridge,
    /lifecycle\?\.ready\(\);\s*void this\.captureReviewPresented\(model\);/,
  );

  const validationMount = canvasPart.slice(
    canvasPart.indexOf("private async validateSessionMount("),
  );
  assert.doesNotMatch(validationMount, /captureReviewPresented/);
});
