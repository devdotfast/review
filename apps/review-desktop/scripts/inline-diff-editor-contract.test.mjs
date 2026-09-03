import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  new URL(
    "../code-oss/src/vs/review/services/reviewInlineEditorService.ts",
    import.meta.url,
  ),
  "utf8",
);
const widgetSource = readFileSync(
  new URL(
    "../code-oss/src/vs/editor/browser/widget/multiDiffEditor/multiDiffEditorWidget.ts",
    import.meta.url,
  ),
  "utf8",
);
const widgetImplementationSource = readFileSync(
  new URL(
    "../code-oss/src/vs/editor/browser/widget/multiDiffEditor/multiDiffEditorWidgetImpl.ts",
    import.meta.url,
  ),
  "utf8",
);
const itemTemplateSource = readFileSync(
  new URL(
    "../code-oss/src/vs/editor/browser/widget/multiDiffEditor/diffEditorItemTemplate.ts",
    import.meta.url,
  ),
  "utf8",
);
const reviewCommentsSource = readFileSync(
  new URL(
    "../code-oss/src/vs/review/contrib/comments/reviewComments.contribution.ts",
    import.meta.url,
  ),
  "utf8",
);
const commentThreadHeaderSource = readFileSync(
  new URL(
    "../code-oss/src/vs/workbench/contrib/comments/browser/commentThreadHeader.ts",
    import.meta.url,
  ),
  "utf8",
);
const resourceHeaderSource = readFileSync(
  new URL(
    "../code-oss/src/vs/editor/browser/widget/multiDiffEditor/multiDiffEditorResourceHeader.ts",
    import.meta.url,
  ),
  "utf8",
);
const viewModelSource = readFileSync(
  new URL(
    "../code-oss/src/vs/editor/browser/widget/multiDiffEditor/multiDiffEditorViewModel.ts",
    import.meta.url,
  ),
  "utf8",
);
const factorySource = readFileSync(
  new URL(
    "../code-oss/src/vs/review/services/reviewMultiDiff.ts",
    import.meta.url,
  ),
  "utf8",
);
const resourceSource = readFileSync(
  new URL(
    "../code-oss/src/vs/review/services/reviewCodeResourceService.ts",
    import.meta.url,
  ),
  "utf8",
);
const unifiedDefinitionSource = readFileSync(
  new URL(
    "../code-oss/src/vs/review/services/reviewUnifiedDefinition.ts",
    import.meta.url,
  ),
  "utf8",
);
const reviewStyles = readFileSync(
  new URL(
    "../code-oss/src/vs/review/browser/media/review.css",
    import.meta.url,
  ),
  "utf8",
);
const referencesControllerSource = readFileSync(
  new URL(
    "../code-oss/src/vs/editor/contrib/gotoSymbol/browser/peek/referencesController.ts",
    import.meta.url,
  ),
  "utf8",
);
const referencesWidgetSource = readFileSync(
  new URL(
    "../code-oss/src/vs/editor/contrib/gotoSymbol/browser/peek/referencesWidget.ts",
    import.meta.url,
  ),
  "utf8",
);
test("internal changed CodePeeks keep the native multi-diff used by Files", () => {
  assert.match(source, /MultiDiffEditorWidget/);
  assert.match(source, /MultiDiffEditorInput/);
  assert.match(source, /MultiDiffEditorItem/);
  assert.doesNotMatch(source, /new MultiDiffEditorViewModel/);
  assert.doesNotMatch(source, /RefCounted/);
  assert.match(source, /resolveDiff\(/);
  assert.match(resourceSource, /reviewPeekWindow/);
  assert.match(source, /\.setHiddenAreas\(/);
  assert.doesNotMatch(resourceSource, /scheme:\s*["']review-peek["']/);
  assert.doesNotMatch(resourceSource, /getValueInRange\(/);
  assert.match(source, /originalWindow/);
  assert.match(source, /modifiedWindow/);
  assert.match(source, /computeMultiDiffEditorOptions/);
  assert.match(source, /name: this\.spec\.title/);
  assert.match(source, /hideUnchangedRegions:\s*{[\s\S]*?enabled:\s*false/);
  assert.match(
    itemTemplateSource,
    /hideUnchangedRegions:\s*options\.hideUnchangedRegions\s*\?\?/,
  );
  assert.match(
    viewModelSource,
    /hideUnchangedRegions:\s*options\.hideUnchangedRegions\s*\?\?/,
  );
  assert.match(source, /initialScrollPosition:\s*"top"/);
  assert.match(source, /widget\.onDidScroll/);
  assert.match(source, /widget\.getScrollTop\(\)/);
  assert.match(source, /widget\.onDidChangeContentHeight/);
  assert.match(source, /ElementSizeObserver/);
  assert.match(source, /sizeObserver\.startObserving\(\)/);
  assert.match(source, /multiDiffEditor\.getContentHeight\(\)/);
  assert.match(source, /wordWrap:\s*"off"/);
  assert.match(source, /diffWordWrap:\s*"off"/);
  assert.match(source, /domReadOnly:\s*false/);
  assert.match(source, /horizontal:\s*"auto"/);
  assert.doesNotMatch(source, /createInstance\(\s*DiffEditorWidget/);
});

test("authored CodePeeks use one unified native comment editor", () => {
  assert.match(
    source,
    /if \(this\.spec\.commentsEnabled\) \{[\s\S]*?acquireUnifiedDiff\(/,
  );
  assert.match(source, /initializeUnifiedEditor\(/);
  assert.match(source, /reviewInlineEditorContributions\(true\)/);
  assert.match(source, /lineNumbers:\s*\(lineNumber\) =>/);
  assert.match(source, /className:\s*added \? "line-insert" : "line-delete"/);
  assert.match(resourceSource, /REVIEW_UNIFIED_SCHEME/);
  assert.match(resourceSource, /version:\s*session\.session\.sessionId/);
  assert.match(resourceSource, /side,/);
  assert.doesNotMatch(resourceSource, /instance:\s*generateUuid/);
});

test("light-theme comments use light surfaces and preserve the diff tint", () => {
  assert.match(
    reviewStyles,
    /\.monaco-workbench\.review-workbench\.vs\s*{[^}]*--review-comment-range:\s*rgb\(43 79 224 \/ 12%\);[^}]*--review-comment-range-active:\s*rgb\(43 79 224 \/ 18%\);/s,
  );
  assert.match(
    reviewStyles,
    /--review-comment-range-line-number:\s*var\([\s\S]*?--vscode-editorLineNumber-activeForeground/,
  );
  assert.match(
    reviewStyles,
    /color:\s*var\(--review-comment-range-line-number\)\s*!important;/,
  );
  assert.match(
    reviewStyles,
    /\.monaco-workbench\.review-workbench\.vs\s*{[^}]*--review-comment-surface:\s*var\(--vscode-editorWidget-background, #ffffff\);[^}]*--review-comment-footer:[^}]*--review-comment-shadow:\s*rgb\(0 0 0 \/ 12%\);/s,
  );
  assert.match(
    reviewStyles,
    /color:\s*var\(--review-comment-chip-ink\);/,
  );
  assert.match(
    reviewStyles,
    /box-shadow:\s*0 10px 28px var\(--review-comment-shadow\);/,
  );
});

test("long authored ranges initially reveal their first line", () => {
  assert.match(
    widgetImplementationSource,
    /initialScrollPositionOnLoad\s*===\s*['"]top['"][\s\S]*?setScrollPosition\(\{\s*scrollTop:\s*0/,
  );
  assert.doesNotMatch(source, /rangeRevealType/);
});

test("peek scrolling is confined to the window's rendered range", () => {
  // The peek publishes its window as a scroll range; the widget's scroll
  // space, scrollbar, and wheel release are all computed against it, so
  // alignment view zones for hidden hunks are unreachable, fitting windows
  // pass the wheel to the document, and the thumb spans real content.
  assert.match(source, /this\.scrollRange\.set\(/);
  assert.match(
    source,
    /\{ start: top, endExclusive: top \+ Math\.max\(rendered \?\? 0, bodyHeight\) \}/,
  );
  // The range refreshes on every layout — word wrap resolves asynchronously
  // and grows the window after the first measure.
  assert.match(
    source,
    /applyMultiDiffScrollRange\(multiDiffEditor, bodyHeight\)/,
  );
  assert.match(
    widgetImplementationSource,
    /Math\.min\(totalHeight, scrollRange\.endExclusive\) - scrollRange\.start/,
  );
  // Window coordinates: scrollTop 0 is the window start everywhere the impl
  // maps into content space.
  assert.match(widgetImplementationSource, /_scrollStart\(reader\)/);
  assert.match(
    widgetImplementationSource,
    /scrollTop: scrollTop - this\._scrollStart\(\)/,
  );
  // No hand-rolled wheel handling — Monaco owns release at both bounds.
  assert.doesNotMatch(source, /addDisposableListener\([^)]*"wheel"/);
});

test("peek code intelligence widgets escape the canvas clip", () => {
  assert.match(source, /fixedOverflowWidgets:\s*true/);
  assert.match(
    source,
    /inlineEditorOptions\(this\.overflowWidgetsDomNode\)/,
  );
  // Multi-diff inner editors get the node through the UI-element factory,
  // not a widget constructor param — keeps upstream call sites untouched.
  assert.match(
    source,
    /this\.overflowWidgetsDomNode,\s*this\.scrollRange,\s*true,/,
  );
  assert.match(
    widgetImplementationSource,
    /this\._workbenchUIElementFactory\.overflowWidgetsDomNode \?\? this\._scrollableElements\.overflowWidgetsDomNode/,
  );
});

test("inline CodePeek references redirect to the workbench editor", () => {
  // A peek widget never renders inside the inline snippet: toggleWidget
  // detects the inline host and hands the model to the workbench editor's
  // own controller, anchored on the opened editor's (possibly remapped)
  // selection.
  assert.match(
    referencesControllerSource,
    /closest\(['"]\.review-inline-code-editor['"]\)[\s\S]*?_redirectToWorkbenchEditor\(range, modelPromise, peekMode\)/,
  );
  assert.match(
    referencesControllerSource,
    /openedEditor\.getSelection\(\) \?\? range/,
  );
  // The compact in-place layout is gone; the widget is upstream again.
  assert.doesNotMatch(referencesControllerSource, /data\.heightInLines = 5/);
  assert.doesNotMatch(referencesWidgetSource, /_compactLayout/);
  assert.doesNotMatch(reviewStyles, /@container review-inline-code/);
});

test("unified CodePeek navigation opens the mapped review resource", () => {
  assert.match(source, /registerCodeEditorOpenHandler/);
  assert.match(source, /input\.resource\.scheme !== REVIEW_UNIFIED_SCHEME/);
  assert.match(source, /unified\.targetForRange\(startLine, endLine\)/);
  assert.match(source, /this\.resources\.target\(mapped\.path, mapped\.side\)/);
  assert.match(source, /resource: target\.resource/);
  assert.match(
    resourceSource,
    /registerTextModelContentProvider\(\s*REVIEW_UNIFIED_SCHEME/,
  );
  assert.match(
    resourceSource,
    /resolverReference = await this\.textModelService\.createModelReference/,
  );
  assert.match(resourceSource, /resolverReference\.dispose\(\)/);
});

test("unified CodePeek definitions delegate to the mapped source model", () => {
  assert.match(
    source,
    /definitionProvider\.register\(\s*\{ scheme: REVIEW_UNIFIED_SCHEME, exclusive: true \}/,
  );
  assert.match(
    unifiedDefinitionSource,
    /unified\?\.targetForRange\(\s*position\.lineNumber,\s*position\.lineNumber/,
  );
  assert.match(
    unifiedDefinitionSource,
    /createModelReference\(\s*target\.resource,\s*\)/,
  );
  assert.match(
    unifiedDefinitionSource,
    /resolveDefinitions\(\s*definitionProviders,\s*sourceModel,\s*sourcePosition/,
  );
  assert.match(
    unifiedDefinitionSource,
    /activateByEvent\(\s*`onLanguage:\$\{sourceModel\.getLanguageId\(\)\}`/,
  );
  assert.match(
    unifiedDefinitionSource,
    /followSameFileDefinition\(\s*definitionProviders,\s*sourceModel,\s*definition/,
  );
  assert.match(unifiedDefinitionSource, /sourceReference\.dispose\(\)/);
});

test("unified CodePeek hovers delegate to the mapped source model", () => {
  assert.match(
    source,
    /hoverProvider\.register\(\s*\{ scheme: REVIEW_UNIFIED_SCHEME, exclusive: true \}/,
  );
  assert.match(
    unifiedDefinitionSource,
    /resolveHovers\(\s*hoverProviders,\s*sourceModel,\s*sourcePosition/,
  );
  assert.match(
    unifiedDefinitionSource,
    /contents: hovers\.flatMap\(\(hover\) => hover\.contents\)/,
  );
});

test("the multi-diff scroller releases the wheel at real content bounds", () => {
  // With the scroll range in place the widget's own wheel handling is
  // honest: handleMouseWheel and alwaysConsumeMouseWheel stay at their
  // defaults, so a fitting window or a boundary hit bubbles to the
  // document scroller. No host knob overrides either.
  assert.doesNotMatch(widgetImplementationSource, /handleMouseWheel/);
  assert.doesNotMatch(widgetImplementationSource, /alwaysConsumeMouseWheel/);
});

test("native multi-diff headers host Review stats and the open action", () => {
  assert.match(widgetSource, /onDidChangeContentHeight/);
  assert.match(widgetSource, /getContentHeight\(\)/);
  assert.match(factorySource, /createResourceHeaderMetadata/);
  assert.match(factorySource, /review-multidiff-counts/);
  assert.match(factorySource, /Open File/);
  assert.match(factorySource, /Codicon\.goToFile/);
});

test("Files and every CodePeek reuse one native multi-diff resource header", () => {
  assert.match(itemTemplateSource, /MultiDiffEditorResourceHeader/);
  assert.match(source, /MultiDiffEditorResourceHeader/);
  assert.match(resourceHeaderSource, /createResourceLabel/);
  assert.match(resourceHeaderSource, /createResourceHeaderMetadata/);
  assert.match(resourceHeaderSource, /MenuWorkbenchToolBar/);
  assert.match(resourceHeaderSource, /Codicon\.chevronRight/);
  assert.match(resourceHeaderSource, /Codicon\.chevronDown/);
  assert.match(resourceHeaderSource, /aria-expanded/);
  assert.match(
    source,
    /ReviewMultiDiffUIElementFactory,[\s\S]*?additions:\s*this\.spec\.diffStats\?\.additions,[\s\S]*?deletions:\s*this\.spec\.diffStats\?\.deletions,[\s\S]*?onDidOpen:\s*this\.spec\.onDidOpen/,
  );
  assert.match(
    source,
    /ReviewMultiDiffUIElementFactory,[\s\S]*?"hidden",[\s\S]*?this\.scrollRange,[\s\S]*?true/,
  );
  assert.doesNotMatch(
    source,
    /inlineEditorChromeModel|createFallbackHeader|review-inline-editor-title/,
  );
  assert.match(
    source,
    /this\.setExpandedHeight\(bodyHeight\s*\+\s*INLINE_HEADER_HEIGHT\)/,
  );
});

test("authored CodePeeks use the stock native comment contribution", () => {
  assert.match(source, /commentsController\.js/);
  assert.match(source, /reviewInlineEditorContributions\(/);
  assert.match(source, /reviewInlineDiffEditorContributions\(/);
  assert.match(source, /contribution\.id !== COMMENT_EDITOR_CONTRIBUTION_ID/);
  assert.match(itemTemplateSource, /codeEditorWidgetOptions \?\? \{\}/);
});

test("the Review delete action discards an empty native draft", () => {
  assert.match(
    reviewCommentsSource,
    /async deleteThread\(thread: CommentThread\): Promise<void> \{\s*if \(thread\.isTemplate\) \{\s*this\.deleteCommentThreadMain\(thread\.threadId\);\s*return;\s*\}/,
  );
});

test("native thread controls place a clear minimize action before delete", () => {
  assert.match(commentThreadHeaderSource, /Codicon\.chromeMinimize/);
  assert.match(
    commentThreadHeaderSource,
    /push\(\[this\._collapseAction, \.\.\.groups\]/,
  );
});

test("unchanged CodePeeks retain the native code editor fallback", () => {
  assert.match(source, /CodeEditorWidget/);
  assert.match(source, /acquireSnippet\(/);
});
