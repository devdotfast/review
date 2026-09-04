import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const canvasPartUrl = new URL(
  "../code-oss/src/vs/review/browser/parts/canvas/reviewCanvasPart.ts",
  import.meta.url,
);
const desktopEntryUrl = new URL(
  "../../../packages/progressive-review/app/src/desktop-entry.tsx",
  import.meta.url,
);

test("presented telemetry follows a successful visible canvas ready signal", async () => {
  const [canvasPart, desktopEntry] = await Promise.all([
    readFile(canvasPartUrl, "utf8"),
    readFile(desktopEntryUrl, "utf8"),
  ]);

  assert.match(
    desktopEntry,
    /`\/live-reviews\/\$\{encodeURIComponent\(reviewUuid\)\}\/page`/,
  );
  assert.match(
    desktopEntry,
    /setDocument\(createLiveReviewDocument\(payload\.page as LiveReviewPage\)\)/,
  );
  assert.match(desktopEntry, /void softwareMapBundle\.then\(/);
  assert.doesNotMatch(desktopEntry, /setDocument\(null\)/);
  assert.match(
    desktopEntry,
    /if \(document && softwareMapLoaded && !error\) session\.signalReady\(\)/,
  );

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
