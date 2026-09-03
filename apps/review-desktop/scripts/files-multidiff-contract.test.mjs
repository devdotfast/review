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

test("comment zone widgets recognise Review inline code editors", () => {
  const commentThreadZoneWidget = source(
    "../code-oss/src/vs/workbench/contrib/comments/browser/commentThreadZoneWidget.ts",
  );
  assert.match(
    commentThreadZoneWidget,
    /closest<HTMLElement>\('\.review-inline-code-editor'\)/,
  );
});

test("files entries and label URIs (ported in a later commit)", () => {
  const reviewFilesDiffView = source(
    "../code-oss/src/vs/review/services/reviewFilesDiffView.ts",
  );
  assert.match(reviewFilesDiffView, /reviewMultiDiffLabelUris\(entry\.file\)/);
  assert.match(
    reviewFilesDiffView,
    /export async function buildReviewFilesEntries/,
  );
});
