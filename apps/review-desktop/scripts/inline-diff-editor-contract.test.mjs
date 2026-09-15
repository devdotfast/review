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
  assert.match(source, /setHiddenAreas/);
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
  assert.doesNotMatch(reviewStyles, /@container review-inline-code/);
});

test("unified CodePeek navigation opens the mapped review resource", () => {
  assert.match(source, /registerCodeEditorOpenHandler/);
  assert.match(source, /input\.resource\.scheme !== REVIEW_UNIFIED_SCHEME/);
  assert.match(source, /unified\.targetForRange\(startLine, endLine\)/);
  assert.match(source, /this\.resources\.target\(mapped\.path, mapped\.side\)/);
  assert.match(source, /resource: target\.resource/);
});

test("unified definitions and hovers register exclusive providers for the review scheme", () => {
  assert.match(
    source,
    /definitionProvider\.register\(\s*\{ scheme: REVIEW_UNIFIED_SCHEME, exclusive: true \}/,
  );
  assert.match(
    source,
    /hoverProvider\.register\(\s*\{ scheme: REVIEW_UNIFIED_SCHEME, exclusive: true \}/,
  );
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
  assert.match(
    itemTemplateSource,
    /hideUnchangedRegions:\s*options\.hideUnchangedRegions\s*\?\?/,
  );
  assert.match(
    viewModelSource,
    /hideUnchangedRegions:\s*options\.hideUnchangedRegions\s*\?\?/,
  );
});

test("review diff surfaces compute their multi-diff editor options via a shared helper", () => {
  assert.match(source, /computeMultiDiffEditorOptions/);
});
