import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(relativePath) {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

test("Diff is a Review-tab view with a native changed-files tree beside one scrollable multi-diff editor", () => {
  const reviewApp = source(
    "../../../packages/progressive-review/app/src/App.tsx",
  );
  const reviewDiffView = source(
    "../../../packages/progressive-review/app/src/DiffView.tsx",
  );
  const reviewHost = source(
    "../../../packages/progressive-review/app/src/host/review-host.tsx",
  );
  const reviewVerbs = source(
    "../code-oss/src/vs/review/contrib/verbs/reviewVerbs.ts",
  );
  const reviewCanvasPart = source(
    "../code-oss/src/vs/review/browser/parts/canvas/reviewCanvasPart.ts",
  );
  const reviewFilesDiffView = source(
    "../code-oss/src/vs/review/services/reviewFilesDiffView.ts",
  );
  const reviewChangedFilesTree = source(
    "../code-oss/src/vs/review/browser/reviewChangedFilesTree.ts",
  );
  const reviewExplorerPart = source(
    "../code-oss/src/vs/review/browser/parts/explorer/reviewExplorerPart.ts",
  );
  const reviewDiffViewService = source(
    "../code-oss/src/vs/review/services/reviewDiffViewService.ts",
  );
  const reviewInlineEditorService = source(
    "../code-oss/src/vs/review/services/reviewInlineEditorService.ts",
  );
  const reviewLspTelemetry = source(
    "../code-oss/src/vs/review/contrib/telemetry/reviewLspTelemetry.contribution.ts",
  );
  const reviewWorkbenchServices = source(
    "../code-oss/src/vs/review/services/reviewWorkbenchServices.ts",
  );
  const reviewMultiDiff = source(
    "../code-oss/src/vs/review/services/reviewMultiDiff.ts",
  );
  const reviewDiffTabs = source(
    "../code-oss/src/vs/review/services/reviewDiffTabs.ts",
  );
  const reviewStyles = source(
    "../code-oss/src/vs/review/browser/media/review.css",
  );
  const multiDiffWidget = source(
    "../code-oss/src/vs/editor/browser/widget/multiDiffEditor/multiDiffEditorWidget.ts",
  );
  const multiDiffWidgetImpl = source(
    "../code-oss/src/vs/editor/browser/widget/multiDiffEditor/multiDiffEditorWidgetImpl.ts",
  );
  const diffCommandsService = source(
    "../code-oss/src/vs/workbench/browser/parts/editor/diffEditorCommandsService.ts",
  );
  const multiDiffTemplate = source(
    "../code-oss/src/vs/editor/browser/widget/multiDiffEditor/diffEditorItemTemplate.ts",
  );
  const multiDiffResourceHeader = source(
    "../code-oss/src/vs/editor/browser/widget/multiDiffEditor/multiDiffEditorResourceHeader.ts",
  );
  const multiDiffInput = source(
    "../code-oss/src/vs/workbench/contrib/multiDiffEditor/browser/multiDiffEditorInput.ts",
  );
  const reviewManifest = source(
    "../code-oss/src/vs/review/review.common.main.ts",
  );
  const commentThreadZoneWidget = source(
    "../code-oss/src/vs/workbench/contrib/comments/browser/commentThreadZoneWidget.ts",
  );

  // The Diff is a view inside the Review tab, not a separate editor tab.
  assert.match(reviewApp, /<ReviewDiffView\s+scope=/);
  assert.match(reviewApp, /review-diff-view--scoped/);
  assert.match(reviewApp, /"commits", "diff"/);
  assert.doesNotMatch(reviewApp, /session\.surface\.openFiles\(\)/);
  assert.doesNotMatch(reviewHost, /openFiles\(\)/);
  assert.match(reviewDiffView, /session\.bridge\.diffView/);
  assert.match(reviewDiffView, /create\(\{ container, scope \}\)/);
  assert.match(reviewDiffView, /review-diff-view-host/);

  // Server and CLI callers use one typed verb to select any Review-tab view.
  assert.match(reviewVerbs, /case "showReviewView"/);
  assert.match(reviewVerbs, /event: "showReviewView", view/);
  assert.doesNotMatch(reviewVerbs, /ReviewFilesEditorInput/);
  assert.match(reviewApp, /event\.event === "showReviewView"/);
  assert.match(
    reviewApp,
    /useLayoutEffect\(\(\) => \{\s*return session\.surface\.subscribe/,
  );
  assert.doesNotMatch(
    reviewCanvasPart,
    /pendingReviewViews|surfaceSubscriptionCounts/,
  );

  assert.match(reviewCanvasPart, /diffView: this\.diffViews/);
  assert.match(reviewCanvasPart, /this\.diffViews\.reset\(\)/);
  assert.match(reviewCanvasPart, /toggleRenderSideBySide\(\): void/);

  assert.doesNotMatch(
    reviewFilesDiffView,
    /extends AbstractEditorWithViewState/,
  );
  assert.match(reviewFilesDiffView, /MultiDiffEditorWidget/);
  assert.match(reviewFilesDiffView, /ReviewChangedFilesTree/);
  assert.match(reviewFilesDiffView, /new SplitView/);
  assert.match(reviewFilesDiffView, /new ElementSizeObserver/);
  assert.match(reviewFilesDiffView, /this\.widget\.reveal\(/);
  assert.match(reviewFilesDiffView, /this\.changedFilesTree\.onDidOpenFile/);
  assert.match(reviewFilesDiffView, /onDidChangeActiveItem/);
  assert.match(reviewFilesDiffView, /syncFileSelectionFromWidget/);
  assert.match(reviewFilesDiffView, /this\.changedFilesTree\.setActiveFile/);
  assert.match(
    reviewChangedFilesTree,
    /WorkbenchCompressibleObjectTree<ChangedTreeElement/,
  );
  assert.match(reviewChangedFilesTree, /renderCompressedElements/);
  assert.match(reviewChangedFilesTree, /compressionEnabled: true/);
  assert.match(reviewChangedFilesTree, /openOnSingleClick: true/);
  assert.match(reviewChangedFilesTree, /indent: 12/);
  assert.match(reviewChangedFilesTree, /RenderIndentGuides\.None/);
  assert.doesNotMatch(reviewChangedFilesTree, /function compressFolder/);
  assert.match(
    reviewChangedFilesTree,
    /collapsed:\s*ObjectTreeElementCollapseState\.PreserveOrExpanded/,
  );
  assert.doesNotMatch(reviewChangedFilesTree, /collapsed:\s*false/);
  assert.match(reviewChangedFilesTree, /Codicon\.diffAdded/);
  assert.match(reviewChangedFilesTree, /Codicon\.diffModified/);
  assert.match(reviewChangedFilesTree, /Codicon\.diffRemoved/);
  assert.match(reviewChangedFilesTree, /Codicon\.diffRenamed/);
  assert.match(
    reviewChangedFilesTree,
    /registerColor\(\s*"gitDecoration\.addedResourceForeground"/,
  );
  assert.match(
    reviewChangedFilesTree,
    /registerColor\(\s*"gitDecoration\.modifiedResourceForeground"/,
  );
  assert.match(
    reviewChangedFilesTree,
    /registerColor\(\s*"gitDecoration\.deletedResourceForeground"/,
  );
  assert.match(
    reviewChangedFilesTree,
    /registerColor\(\s*"gitDecoration\.renamedResourceForeground"/,
  );
  assert.match(reviewChangedFilesTree, /template\.icon\.hidden = !isFile/);
  assert.doesNotMatch(reviewChangedFilesTree, /Codicon\.folder/);
  assert.doesNotMatch(reviewChangedFilesTree, /Codicon\.folderOpened/);
  assert.match(reviewChangedFilesTree, /setActiveFile/);
  assert.match(reviewChangedFilesTree, /onDidOpenFile/);
  assert.doesNotMatch(reviewChangedFilesTree, /InputBox/);
  assert.doesNotMatch(reviewChangedFilesTree, /onDidChangeCounts/);
  assert.doesNotMatch(reviewChangedFilesTree, /element\.file\.additions/);
  assert.doesNotMatch(reviewChangedFilesTree, /element\.file\.deletions/);
  assert.doesNotMatch(reviewChangedFilesTree, /statusLabel/);
  assert.match(reviewFilesDiffView, /reviewMultiDiffLabelUris\(entry\.file\)/);
  assert.match(reviewFilesDiffView, /readonly original: URI;/);
  assert.match(reviewFilesDiffView, /file\.previousPath \?\? file\.path[\s\S]*?"base"/);
  assert.doesNotMatch(reviewFilesDiffView, /file\.status === "added"/);
  assert.doesNotMatch(reviewFilesDiffView, /entry\.file\.status === "added"/);
  assert.match(reviewFilesDiffView, /REVIEW_FILES_DIFF_EDITOR_OPTIONS/);
  assert.match(
    reviewFilesDiffView,
    /hideUnchangedRegions:\s*\{ enabled: true \}/,
  );
  assert.match(reviewFilesDiffView, /originalEditable:\s*false/);
  assert.match(reviewFilesDiffView, /readOnly:\s*true/);
  assert.match(reviewFilesDiffView, /resource: entry\.goToFileResource/);
  assert.match(reviewFilesDiffView, /mainPart\.activeGroup/);
  assert.match(reviewFilesDiffView, /toggleRenderSideBySide\(\)/);
  assert.match(
    reviewFilesDiffView,
    /textResourceConfigurationService\.updateValue\(/,
  );
  assert.doesNotMatch(reviewFilesDiffView, /review-files-editor-toolbar/);
  assert.doesNotMatch(reviewFilesDiffView, /review-files-editor-settings/);
  assert.doesNotMatch(reviewFilesDiffView, /Diff layout/);
  assert.doesNotMatch(reviewFilesDiffView, /UNIFIED_DIFF_WIDTH/);
  assert.doesNotMatch(reviewFilesDiffView, /setRenderSideBySide\(/);
  assert.doesNotMatch(reviewFilesDiffView, /review-files-editor-tree-header/);
  assert.doesNotMatch(reviewFilesDiffView, /review-files-editor-tree-summary/);
  assert.doesNotMatch(reviewFilesDiffView, /review-files-editor-tree-count/);
  assert.doesNotMatch(reviewFilesDiffView, /review-files-editor-tree-diff-counts/);
  assert.doesNotMatch(reviewFilesDiffView, /review-files-editor-list/);
  assert.match(reviewFilesDiffView, /entry\.file\.additions/);
  assert.match(reviewFilesDiffView, /entry\.file\.deletions/);
  assert.doesNotMatch(reviewFilesDiffView, /summarizeReviewDiffFiles/);
  assert.doesNotMatch(reviewFilesDiffView, /input\.diffStats/);
  assert.doesNotMatch(reviewFilesDiffView, /entries\.reduce/);
  assert.match(
    reviewFilesDiffView,
    /export async function buildReviewFilesEntries/,
  );

  // Hover and definition widgets must escape the canvas root's containment,
  // and the toggled-away view must come back where the reader left it.
  assert.match(reviewDiffViewService, /setOverflowWidgetsDomNode/);
  assert.match(reviewDiffViewService, /buildReviewFilesEntries/);
  assert.match(reviewDiffViewService, /reviewFilesSourceUri/);
  assert.match(reviewDiffViewService, /this\.spec\.scope/);
  assert.match(reviewFilesDiffView, /codeResources\.files\(scope\)/);
  assert.match(reviewDiffViewService, /this\.viewStates\.set\(key, state\)/);
  assert.match(reviewDiffViewService, /setExternalActiveEditor/);
  assert.match(reviewDiffViewService, /clearExternalActiveEditor/);
  // The in-tab diff is a real diff editor. Adopting its inner editors into the
  // inline-peek set would report their LSP use as inline_peek.
  assert.doesNotMatch(reviewDiffViewService, /registerExternalEditor/);
  assert.doesNotMatch(reviewInlineEditorService, /registerExternalEditor/);
  assert.match(reviewLspTelemetry, /ReviewInlineEditorService\.owns\(editor\)/);

  assert.match(
    reviewStyles,
    /\.review-files-editor-tree[\s\S]*?background:\s*var\(--vscode-editor-background\)/,
  );
  assert.match(
    reviewStyles,
    /\.review-changed-files[\s\S]*?background:\s*var\(--vscode-editor-background\)/,
  );
  assert.match(
    reviewStyles,
    /\.review-changed-files-folder \.review-changed-files-label[\s\S]*?margin-left:\s*7px/,
  );
  assert.doesNotMatch(reviewStyles, /\.review-files-editor-tree-header/);
  assert.doesNotMatch(reviewStyles, /\.review-files-editor-tree-summary/);
  assert.doesNotMatch(reviewStyles, /\.review-files-editor-tree-count/);
  assert.doesNotMatch(reviewStyles, /\.review-files-editor-tree-diff-counts/);
  assert.doesNotMatch(reviewStyles, /\.review-changed-files-filter/);
  assert.doesNotMatch(reviewStyles, /\.review-changed-files-counts/);
  assert.doesNotMatch(reviewStyles, /\.review-changed-files-status/);
  assert.match(
    reviewStyles,
    /\.monaco-workbench \.review-changed-files-icon\.review-changed-files-icon-added[\s\S]*?gitDecoration-addedResourceForeground/,
  );
  assert.match(
    reviewStyles,
    /\.monaco-workbench \.review-changed-files-icon\.review-changed-files-icon-modified[\s\S]*?gitDecoration-modifiedResourceForeground/,
  );
  assert.match(
    reviewStyles,
    /\.monaco-workbench \.review-changed-files-icon\.review-changed-files-icon-deleted[\s\S]*?gitDecoration-deletedResourceForeground/,
  );
  assert.match(
    reviewStyles,
    /\.monaco-workbench \.review-changed-files-icon\.review-changed-files-icon-renamed[\s\S]*?gitDecoration-renamedResourceForeground/,
  );
  assert.doesNotMatch(reviewStyles, /\.review-files-editor-toolbar/);
  assert.doesNotMatch(reviewStyles, /\.review-files-editor-settings/);
  assert.doesNotMatch(reviewStyles, /\.review-files-editor-diffs-body/);
  assert.match(reviewMultiDiff, /class ReviewMultiDiffUIElementFactory/);
  assert.match(reviewMultiDiff, /createInstance\(\s*ResourceLabel/);
  assert.match(reviewMultiDiff, /element\.classList\.add\("review-path-label"\)/);
  assert.match(
    reviewStyles,
    /\.review-path-label \.monaco-icon-label-container[\s\S]*?direction:\s*rtl/,
  );
  assert.match(
    reviewStyles,
    /\.review-path-label \.label-name[\s\S]*?unicode-bidi:\s*plaintext/,
  );
  assert.match(reviewExplorerPart, /reviewResourceIdentity\(/);
  assert.match(reviewExplorerPart, /candidate\.path === activePath/);
  assert.doesNotMatch(reviewExplorerPart, /endsWith\(normalizedPath\)/);
  assert.match(multiDiffWidget, /onDidChangeActiveItem/);
  assert.match(multiDiffWidgetImpl, /syncActiveItemToScroll/);
  assert.match(multiDiffWidgetImpl, /activeDiffItem\.setCache\(/);
  assert.match(
    reviewStyles,
    /\.review-files-editor-diffs[\s\S]*\.monaco-component\.multiDiffEditor[\s\S]*\.multiDiffEntry[\s\S]*margin-top:\s*0/,
  );
  assert.match(
    reviewStyles,
    /\.review-files-editor-diffs[\s\S]*\.file-path[\s\S]*\.title[\s\S]*font-size:\s*12px/,
  );
  assert.match(
    reviewStyles,
    /\.review-files-editor-diffs[\s\S]*?> \.actions \{\s*padding: 0;/,
  );
  assert.match(
    reviewStyles,
    /\.review-files-editor-diffs[\s\S]*?> \.actions\.has-no-actions[\s\S]*?display: none;/,
  );
  assert.doesNotMatch(multiDiffTemplate, /isFirst/);
  assert.match(multiDiffTemplate, /modifiedLabelUri/);
  assert.match(multiDiffTemplate, /originalLabelUri/);
  assert.doesNotMatch(multiDiffTemplate, /renderAsFile/);
  assert.doesNotMatch(multiDiffInput, /renderAsFile/);
  assert.match(multiDiffTemplate, /MultiDiffEditorResourceHeader/);
  assert.match(multiDiffResourceHeader, /isInteractiveHeaderTarget/);
  assert.match(multiDiffInput, /\.\.\.r\.options/);

  // Every changed-file status uses the regular original-to-modified diff.
  assert.doesNotMatch(reviewDiffTabs, /status === "added"/);
  assert.match(reviewDiffTabs, /original: \{ resource: originalTarget\.resource \}/);
  assert.match(reviewDiffTabs, /modified: \{ resource: modifiedTarget\.resource \}/);
  assert.doesNotMatch(reviewVerbs, /diffFile\.status === "added"/);
  assert.match(reviewVerbs, /isDiffEditor\(control\)/);

  // Review never imports the upstream multi-diff editor, so the source
  // resolver keeps its one Review-owned registration.
  assert.doesNotMatch(
    reviewManifest,
    /contrib\/multiDiffEditor\/browser\/multiDiffEditor\.contribution\.js/,
  );
  assert.doesNotMatch(reviewManifest, /reviewFilesEditor\.contribution/);
  assert.match(
    reviewWorkbenchServices,
    /registerSingleton\(IMultiDiffSourceResolverService/,
  );
  assert.doesNotMatch(reviewWorkbenchServices, /ScmMultiDiffSourceResolver/);

  // The Review pane answers the standard toggle command for its embedded diff.
  assert.match(
    diffCommandsService,
    /activeEditorPane\.toggleRenderSideBySide\(\)/,
  );
  assert.match(
    commentThreadZoneWidget,
    /closest<HTMLElement>\('\.review-inline-code-editor'\)/,
  );
  assert.match(commentThreadZoneWidget, /inlineEditorNode && diffEditorNode/);
});
