import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(relativePath) {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

test("multi-diff widget publishes the active item for the changed-files tree", () => {
  const multiDiffWidget = source(
    "../code-oss/src/vs/editor/browser/widget/multiDiffEditor/multiDiffEditorWidget.ts",
  );
  const multiDiffWidgetImpl = source(
    "../code-oss/src/vs/editor/browser/widget/multiDiffEditor/multiDiffEditorWidgetImpl.ts",
  );
  assert.match(multiDiffWidget, /onDidChangeActiveItem/);
  assert.match(multiDiffWidgetImpl, /syncActiveItemToScroll/);
  assert.match(multiDiffWidgetImpl, /activeDiffItem\.setCache\(/);
});

test("diff item template renders Review's resource header with label URIs", () => {
  const multiDiffTemplate = source(
    "../code-oss/src/vs/editor/browser/widget/multiDiffEditor/diffEditorItemTemplate.ts",
  );
  assert.match(multiDiffTemplate, /MultiDiffEditorResourceHeader/);
  assert.match(multiDiffTemplate, /modifiedLabelUri/);
  assert.match(multiDiffTemplate, /originalLabelUri/);
});

test("multi-diff input forwards per-resource options", () => {
  const multiDiffInput = source(
    "../code-oss/src/vs/workbench/contrib/multiDiffEditor/browser/multiDiffEditorInput.ts",
  );
  assert.match(multiDiffInput, /\.\.\.r\.options/);
});

test("diff layout toggle acts on the active editor pane", () => {
  const diffCommandsService = source(
    "../code-oss/src/vs/workbench/browser/parts/editor/diffEditorCommandsService.ts",
  );
  assert.match(
    diffCommandsService,
    /activeEditorPane\.toggleRenderSideBySide\(\)/,
  );
});

test("Review registers its own multi-diff source resolver and keeps upstream's editors out of the manifest", () => {
  const reviewWorkbenchServices = source(
    "../code-oss/src/vs/review/services/reviewWorkbenchServices.ts",
  );
  const reviewManifest = source(
    "../code-oss/src/vs/review/review.common.main.ts",
  );
  assert.match(
    reviewWorkbenchServices,
    /registerSingleton\(IMultiDiffSourceResolverService/,
  );
  assert.doesNotMatch(reviewWorkbenchServices, /ScmMultiDiffSourceResolver/);
  assert.doesNotMatch(
    reviewManifest,
    /contrib\/multiDiffEditor\/browser\/multiDiffEditor\.contribution\.js/,
  );
  assert.doesNotMatch(reviewManifest, /reviewFilesEditor\.contribution/);
});

test("comment zone widgets recognise Review inline code editors", () => {
  const commentThreadZoneWidget = source(
    "../code-oss/src/vs/workbench/contrib/comments/browser/commentThreadZoneWidget.ts",
  );
  assert.match(
    commentThreadZoneWidget,
    /closest<HTMLElement>\('\.review-inline-code-editor'\)/,
  );
});

// `reviewFilesDiffView.ts` reaches the DOM through the multi-diff widget and a
// CSS import, so nothing under `code-oss/src/vs/review/**/*.test.ts` can import
// it under plain Node. These four needles stand in for the behaviour until the
// `.test.ts` tier gains a DOM harness.
test("the Files view builds its entries and follows the widget's active item", () => {
  const reviewFilesDiffView = source(
    "../code-oss/src/vs/review/services/reviewFilesDiffView.ts",
  );
  assert.match(reviewFilesDiffView, /reviewMultiDiffLabelUris\(entry\.file\)/);
  assert.match(
    reviewFilesDiffView,
    /export async function buildReviewFilesEntries/,
  );
  assert.match(
    reviewFilesDiffView,
    /this\.widget\.onDidChangeActiveItem\(\(\) =>\s*this\.syncFileSelectionFromWidget\(\),?\s*\)/,
  );
  assert.match(
    reviewFilesDiffView,
    /toggleRenderSideBySide\(\): void \{[\s\S]*?this\.widget\.getActiveItem\(\)\?\.modified/,
  );
});
