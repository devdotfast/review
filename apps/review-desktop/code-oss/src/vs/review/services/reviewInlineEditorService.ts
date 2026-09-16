/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from "../../base/common/event.js";
import {
  Disposable,
  DisposableStore,
  type IDisposable,
} from "../../base/common/lifecycle.js";
import { autorun, observableValue } from "../../base/common/observable.js";
import { URI } from "../../base/common/uri.js";
import type { IEditorConstructionOptions } from "../../editor/browser/config/editorConfiguration.js";
import type { ICodeEditor } from "../../editor/browser/editorBrowser.js";
import { ICodeEditorService } from "../../editor/browser/services/codeEditorService.js";
import { CodeEditorWidget } from "../../editor/browser/widget/codeEditor/codeEditorWidget.js";
import { EditorExtensionsRegistry } from "../../editor/browser/editorExtensions.js";
import {
  MULTI_DIFF_RESOURCE_HEADER_HEIGHT,
  MultiDiffEditorResourceHeader,
} from "../../editor/browser/widget/multiDiffEditor/multiDiffEditorResourceHeader.js";
import { Range } from "../../editor/common/core/range.js";
import { USUAL_WORD_SEPARATORS } from "../../editor/common/core/wordHelper.js";
import type {
  ICompositeCodeEditor,
  IEditorDecorationsCollection,
} from "../../editor/common/editorCommon.js";
import { getDefinitionsAtPosition } from "../../editor/contrib/gotoSymbol/browser/goToSymbol.js";
import { getHoversPromise } from "../../editor/contrib/hover/browser/getHover.js";
import type { ITextModel } from "../../editor/common/model.js";
import { ILanguageFeaturesService } from "../../editor/common/services/languageFeatures.js";
import { ITextModelService } from "../../editor/common/services/resolverService.js";
import { IInstantiationService } from "../../platform/instantiation/common/instantiation.js";
import type { ITextResourceEditorInput } from "../../platform/editor/common/editor.js";
import { REVIEW_UNIFIED_SCHEME } from "../common/reviewCodeResources.js";
import {
  REVIEW_PEEK_LINE_HEIGHT,
  REVIEW_PEEK_MAX_VISIBLE_LINES,
  reviewPeekCappedHeight,
  reviewPeekHiddenAreas,
  reviewPeekWindowsLineCount,
  reviewPeekWindowsRenderedHeight,
  type ReviewPeekWindow,
} from "../common/reviewPeek.js";
import type {
  ReviewInlineEditorFactory,
  ReviewInlineFindSpec,
  ReviewFindQuery,
  ReviewInlineFindResult,
  ReviewInlineEditorHandle,
  ReviewInlineEditorSpec,
} from "../common/reviewProtocol.js";
import {
  IReviewCodeResourceService,
  type ReviewCodeModelReference,
  type ReviewUnifiedCodeModelReference,
} from "./reviewCodeResourceService.js";
import {
  ReviewMultiDiffUIElementFactory,
  reviewMultiDiffLabelUris,
  type ReviewMultiDiffHeaderEntry,
} from "./reviewMultiDiff.js";
import { markReviewEmbeddedEditor } from "./reviewEmbeddedNavigation.js";
import {
  provideReviewUnifiedDefinition,
  provideReviewUnifiedHover,
} from "./reviewUnifiedDefinition.js";
import { ContentHoverController } from "../../editor/contrib/hover/browser/contentHoverController.js";
import { IExtensionService } from "../../workbench/services/extensions/common/extensions.js";

import { reviewUnifiedDiffDecorations, reviewUnifiedLineNumbers } from "./reviewUnifiedEditor.js";
import { reviewCodePeekRangeCounts } from "../common/reviewProtocol.js";

const INLINE_HEADER_HEIGHT = MULTI_DIFF_RESOURCE_HEADER_HEIGHT;
const CONTENT_HEIGHT_EPSILON = 0.5;
const reviewInlineEditors = new WeakSet<ICodeEditor>();

interface InlineFindMatch {
  readonly editor: ICodeEditor;
  readonly range: Range;
}

/** The existing widgets also accept source loaded from the review API. */
export interface ReviewInlineSource {
  snippet(): Promise<ReviewCodeModelReference>;
  diff(): Promise<import("./reviewCodeResourceService.js").ReviewCodeDiffTarget | undefined>;
}

/** API sources feed the same unified diff builder as legacy sources. */
async function acquireUnifiedFromSource(
  resources: IReviewCodeResourceService,
  spec: Pick<ReviewInlineFindSpec, "path" | "side" | "ranges">,
  source: ReviewInlineSource,
) {
  const target = await source.diff();
  return (
    target &&
    resources.acquireUnifiedDiffForTarget(spec.path, spec.side, spec.ranges, target)
  );
}

export class ReviewInlineEditorService
  extends Disposable
  implements ReviewInlineEditorFactory, ICompositeCodeEditor
{
  private readonly _onDidChangeActiveEditor = this._register(
    new Emitter<ICompositeCodeEditor>(),
  );
  readonly onDidChangeActiveEditor = this._onDidChangeActiveEditor.event;
  private readonly handles = new Set<InlineEditorHandle>();
  private readonly handlesByEditor = new WeakMap<ICodeEditor, InlineEditorHandle>();
  private activeHandle: InlineEditorHandle | undefined;
  private _activeCodeEditor: ICodeEditor | undefined;
  private lastSelectionEditor: ICodeEditor | undefined;
  private overflowWidgetsDomNode: HTMLElement | undefined;

  get activeCodeEditor(): ICodeEditor | undefined {
    return this._activeCodeEditor;
  }

  get selectionCodeEditor(): ICodeEditor | undefined {
    return this._activeCodeEditor ?? this.lastSelectionEditor;
  }

  static owns(editor: ICodeEditor): boolean {
    return reviewInlineEditors.has(editor);
  }

  constructor(
    @IInstantiationService
    private readonly instantiationService: IInstantiationService,
    @IReviewCodeResourceService
    private readonly resources: IReviewCodeResourceService,
    @ICodeEditorService
    private readonly codeEditorService: ICodeEditorService,
    @ILanguageFeaturesService
    private readonly languageFeaturesService: ILanguageFeaturesService,
    @ITextModelService
    private readonly textModelService: ITextModelService,
    @IExtensionService
    private readonly extensionService: IExtensionService,
  ) {
    super();
    this._register(
      this.codeEditorService.registerCodeEditorOpenHandler(
        (input, source, sideBySide) =>
          this.openUnifiedNavigation(input, source, sideBySide),
      ),
    );
    this._register(
      this.languageFeaturesService.definitionProvider.register(
        { scheme: REVIEW_UNIFIED_SCHEME, exclusive: true },
        {
          provideDefinition: (model, position, token) =>
            provideReviewUnifiedDefinition(
              this.resources,
              this.textModelService,
              this.extensionService,
              this.languageFeaturesService.definitionProvider,
              model,
              position,
              token,
              getDefinitionsAtPosition,
            ),
        },
      ),
    );
    this._register(
      this.languageFeaturesService.hoverProvider.register(
        { scheme: REVIEW_UNIFIED_SCHEME, exclusive: true },
        {
          provideHover: (model, position, token) =>
            provideReviewUnifiedHover(
              this.resources,
              this.textModelService,
              this.extensionService,
              this.languageFeaturesService.hoverProvider,
              model,
              position,
              token,
              getHoversPromise,
            ),
        },
      ),
    );
  }

  private async openUnifiedNavigation(
    input: ITextResourceEditorInput,
    source: ICodeEditor | null,
    sideBySide?: boolean,
  ): Promise<ICodeEditor | null> {
    const sourceHandle = source
      ? this.handlesByEditor.get(source)
      : undefined;
    if (input.resource.scheme !== REVIEW_UNIFIED_SCHEME) {
      sourceHandle?.didNavigate();
      return null;
    }
    const unified = this.resources.unifiedResource(input.resource);
    if (!unified) return null;

    const selection = input.options?.selection;
    const startLine = selection?.startLineNumber ?? 1;
    const endLine = selection?.endLineNumber ?? startLine;
    const mapped =
      unified.targetForRange(startLine, endLine) ??
      unified.targetForRange(startLine, startLine);
    if (!mapped) return null;

    const target = await this.resources.target(mapped.path, mapped.side);
    const opened = await this.codeEditorService.openCodeEditor(
      {
        ...input,
        resource: target.resource,
        options: selection
          ? {
              ...input.options,
              selection: {
                startLineNumber: mapped.startLine,
                startColumn: selection.startColumn,
                endLineNumber: mapped.endLine,
                endColumn: selection.endColumn,
              },
            }
          : input.options,
      },
      source,
      sideBySide,
    );
    if (opened && source) {
      sourceHandle?.didNavigate();
    }
    return opened;
  }

  /**
   * Hosts hover/definition widgets from every inline peek editor. The node
   * must live outside .review-canvas-root: its container-query containment
   * makes it the containing block for position: fixed descendants, so
   * viewport-fixed overflow widgets parented anywhere inside it render
   * mis-anchored and clipped.
   */
  setOverflowWidgetsDomNode(node: HTMLElement): void {
    this.overflowWidgetsDomNode = node;
  }

  create(spec: ReviewInlineEditorSpec, source?: ReviewInlineSource): ReviewInlineEditorHandle {
    const handle = new InlineEditorHandle(
      spec,
      this.instantiationService,
      this.resources,
      this.overflowWidgetsDomNode,
      () => {
        this.handles.delete(handle);
        if (this.activeHandle === handle) {
          this.activeHandle = undefined;
          this.setActiveEditor(undefined);
        }
        this.updateMetrics(spec.container.ownerDocument);
      },
      () => this.updateMetrics(spec.container.ownerDocument),
      (control) => {
        this.activeHandle = handle;
        this.lastSelectionEditor = control;
        this.setActiveEditor(control);
      },
      () => {
        queueMicrotask(() => {
          if (this.activeHandle !== handle) return;
          if ([...this.handles].some((candidate) => candidate.hasTextFocus())) {
            return;
          }
          this.activeHandle = undefined;
          this.setActiveEditor(undefined);
        });
      },
      (control) => this.handlesByEditor.set(control, handle),
      source,
    );
    this.handles.add(handle);
    this.updateMetrics(spec.container.ownerDocument);
    return handle;
  }

  async find(
    spec: ReviewInlineFindSpec,
    query: ReviewFindQuery,
    source?: ReviewInlineSource,
  ): Promise<ReviewInlineFindResult> {
    if (!query.text) return { matchCount: 0 };
    {
      const unified = source
        ? await acquireUnifiedFromSource(this.resources, spec, source)
        : await this.resources.acquireUnifiedDiff(spec.path, spec.side, spec.ranges);
      if (unified) {
        try {
          return {
            matchCount: findModelRanges(
              unified.model,
              unified.windows,
              query,
            ).length,
          };
        } finally {
          unified.dispose();
        }
      }
    }
    const snippet = source
      ? await source.snippet()
      : await this.resources.acquireSnippet(spec.path, spec.side, spec.ranges);
    try {
      return {
        matchCount: findModelRanges(snippet.model, snippet.windows, query).length,
      };
    } finally {
      snippet.dispose();
    }
  }

  reset(): void {
    for (const handle of [...this.handles]) handle.dispose();
    this.handles.clear();
    this.activeHandle = undefined;
    this.lastSelectionEditor = undefined;
    this.setActiveEditor(undefined);
    this.resources.reset();
  }

  /**
   * Makes an editor this service did not build — today an inner editor of the
   * in-tab diff — the composite's active one. Find and the editor context
   * keys read the composite.
   *
   * These editors deliberately stay out of `reviewInlineEditors`. That set
   * marks an editor as an inline peek, and the LSP telemetry reports its
   * members as `inline_peek`. The in-tab diff is a real diff editor and must
   * keep reporting as one.
   */
  setExternalActiveEditor(editor: ICodeEditor | undefined): void {
    this.activeHandle = undefined;
    if (editor) this.lastSelectionEditor = editor;
    this.setActiveEditor(editor);
  }

  /** Drops an adopted editor once its owner goes away. */
  clearExternalActiveEditor(editor: ICodeEditor): void {
    if (this._activeCodeEditor !== editor) return;
    this.setActiveEditor(undefined);
  }

  private setActiveEditor(editor: ICodeEditor | undefined): void {
    if (this._activeCodeEditor === editor) return;
    this._activeCodeEditor = editor;
    this._onDidChangeActiveEditor.fire(this);
  }

  private updateMetrics(document: Document): void {
    const handles = [...this.handles];
    document.body.dataset["reviewInlineEditorWidgetCount"] = String(
      handles.filter((handle) => handle.hasWidget).length,
    );
    document.body.dataset["reviewInlineEditorModelCount"] = String(
      handles.filter((handle) => handle.hasModel).length,
    );
  }
}

class InlineEditorHandle extends Disposable implements ReviewInlineEditorHandle {
  private readonly _onDidChangeHeight = this._register(new Emitter<number>());
  readonly onDidChangeHeight = this._onDidChangeHeight.event;
  private readonly _onDidError = this._register(new Emitter<string>());
  readonly onDidError = this._onDidError.event;
  private readonly editorStore = this._register(new DisposableStore());
  private readonly collapsed = observableValue(this, false);
  private readonly header: MultiDiffEditorResourceHeader;
  private readonly body: HTMLElement;
  private headerEntry: ReviewMultiDiffHeaderEntry | undefined;
  private editor: CodeEditorWidget | undefined;
  private modelReference: ReviewCodeModelReference | undefined;
  private unifiedModelReference: ReviewUnifiedCodeModelReference | undefined;
  private decoration: IEditorDecorationsCollection | undefined;
  private diffDecoration: IEditorDecorationsCollection | undefined;
  private readonly findDecorations = new Map<
    ICodeEditor,
    IEditorDecorationsCollection
  >();
  private findMatches: InlineFindMatch[] = [];
  private findGeneration = 0;
  private readonly initialized: Promise<void>;
  private disposed = false;
  private active: boolean;
  private _height: number;
  private expandedHeight: number;
  private readonly startedAt = performance.now();

  get height(): number {
    return this._height;
  }

  get hasWidget(): boolean {
    return this.editor !== undefined;
  }

  get hasModel(): boolean {
    return (
      this.modelReference !== undefined ||
      this.unifiedModelReference !== undefined
    );
  }

  constructor(
    private readonly spec: ReviewInlineEditorSpec,
    private readonly instantiationService: IInstantiationService,
    private readonly resources: IReviewCodeResourceService,
    private readonly overflowWidgetsDomNode: HTMLElement | undefined,
    private readonly onDispose: () => void,
    private readonly onStateChange: () => void,
    private readonly onDidFocusControl: (control: ICodeEditor) => void,
    private readonly onDidBlurControl: () => void,
    private readonly onDidBindControl: (control: ICodeEditor) => void,
    private readonly source?: ReviewInlineSource,
  ) {
    super();
    if (spec.ranges.length === 0) {
      throw new Error("Inline editor requires at least one range.");
    }
    this.active = spec.active;
    this.expandedHeight = estimatedHeight(spec.ranges, spec.heightMode);
    this._height = this.expandedHeight;
    spec.container.classList.add("review-inline-code-editor");
    spec.container.dataset["reviewInlineEditorPath"] = spec.path;
    spec.container.dataset["reviewInlineEditorSide"] = spec.side;
    const document = spec.container.ownerDocument;
    const headerHost = document.createElement("div");
    headerHost.className =
      "review-inline-editor-header-host monaco-component multiDiffEditor";
    const headerEntry = document.createElement("div");
    headerEntry.className = "multiDiffEntry";
    headerHost.append(headerEntry);
    const headerFactory = this.instantiationService.createInstance(
      ReviewMultiDiffUIElementFactory,
      () => (this.headerEntry ? [this.headerEntry] : []),
      "hidden",
      undefined,
      false,
      undefined,
    );
    this.header = this._register(
      this.instantiationService.createInstance(
        MultiDiffEditorResourceHeader,
        headerEntry,
        headerFactory,
        this.collapsed,
        () => this.collapsed.set(!this.collapsed.get(), undefined),
      ),
    );
    this.body = document.createElement("div");
    this.body.className = "review-inline-editor-body";
    spec.container.append(headerHost, this.body);
    this.setHeader(
      URI.from({ scheme: "file", path: `/${this.spec.path}` }),
      URI.from({ scheme: "file", path: `/${this.spec.path}` }),
    );
    this._register(
      autorun((reader) => {
        const collapsed = this.collapsed.read(reader);
        this.body.style.display = collapsed ? "none" : "block";
        this.setHeight(collapsed ? INLINE_HEADER_HEIGHT : this.expandedHeight);
      }),
    );
    this.initialized = this.initialize();
  }

  hasTextFocus(): boolean {
    return this.editor?.hasTextFocus() ?? false;
  }

  setActive(active: boolean): void {
    if (this.active === active) return;
    this.active = active;
    this.updateDecoration();
  }

  setCollapsed(collapsed: boolean): void {
    this.collapsed.set(collapsed, undefined);
  }

  didNavigate(): void {
    this.spec.onDidNavigate?.();
  }

  async setFindQuery(query: ReviewFindQuery): Promise<ReviewInlineFindResult> {
    const requestGeneration = ++this.findGeneration;
    await this.initialized;
    if (this.disposed || requestGeneration !== this.findGeneration) {
      return { matchCount: 0 };
    }
    if (!query.text) {
      this.clearFind();
      return { matchCount: 0 };
    }
    const matches: InlineFindMatch[] = [];
    const codeEditor = this.editor;
    const modelReference = this.unifiedModelReference ?? this.modelReference;
    if (codeEditor && modelReference) {
      matches.push(
        ...this.findModelMatches(
          codeEditor,
          modelReference.model,
          modelReference.windows,
          query,
        ),
      );
    }
    if (requestGeneration !== this.findGeneration) return { matchCount: 0 };
    this.findMatches = matches;
    this.applyFindDecorations();
    return { matchCount: matches.length };
  }

  revealFindMatch(index: number): void {
    const match = this.findMatches[index];
    if (!match) return;
    this.collapsed.set(false, undefined);
    this.applyFindDecorations(index);
    match.editor.revealRangeInCenter(match.range);
  }

  clearActiveFindMatch(): void {
    this.applyFindDecorations();
  }

  clearFind(): void {
    this.findGeneration += 1;
    this.findMatches = [];
    for (const collection of this.findDecorations.values()) collection.clear();
    this.findDecorations.clear();
  }

  override dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearFind();
    this.decoration?.clear();
    this.diffDecoration?.clear();
    this.editorStore.dispose();
    this.spec.container.replaceChildren();
    this.spec.container.classList.remove(
      "review-inline-code-editor",
      "review-inline-unified-diff",
    );
    super.dispose();
    this.onDispose();
  }

  private async initialize(): Promise<void> {
    try {
      {
        const unifiedReference = this.source
          ? await acquireUnifiedFromSource(this.resources, this.spec, this.source)
          : await this.resources.acquireUnifiedDiff(
              this.spec.path,
              this.spec.side,
              this.spec.ranges,
            );
        if (unifiedReference) {
          if (this.disposed) {
            unifiedReference.dispose();
            return;
          }
          this.initializeUnifiedEditor(unifiedReference);
          return;
        }
      }
      const modelReference = this.source
        ? await this.source.snippet()
        : await this.resources.acquireSnippet(
            this.spec.path,
            this.spec.side,
            this.spec.ranges,
          );
      if (this.disposed) {
        modelReference.dispose();
        return;
      }
      this.modelReference = modelReference;
      this.editorStore.add(modelReference);
      const editor = this.instantiationService.createInstance(
        CodeEditorWidget,
        this.body,
        inlineEditorOptions(this.overflowWidgetsDomNode),
        {
          telemetryData: { source: "reviewInlineCodeEditor" },
          contributions: EditorExtensionsRegistry.getEditorContributions(),
        },
      );
      this.editor = editor;
      reviewInlineEditors.add(editor);
      this.spec.container.dataset["reviewInlineEditorKind"] = "code";
      this.editorStore.add(editor);
      editor.setModel(modelReference.model);
      this.bindFocus(editor);
      this.trackScroll(
        () => editor.getScrollTop(),
        (listener) => editor.onDidScrollChange(listener),
      );
      this.editorStore.add(
        editor.onDidContentSizeChange((event) =>
          this.layoutCodeEditorToContent(event.contentHeight),
        ),
      );
      this.applyRange();
      this.markCreated();
    } catch (error) {
      if (!this.disposed) this.emitError(error);
    }
  }

  private initializeUnifiedEditor(
    reference: ReviewUnifiedCodeModelReference,
  ): void {
    const labelUris = reviewMultiDiffLabelUris(reference.target.diffFile);
    this.setHeader(
      reference.target.original,
      reference.target.modified,
      labelUris.original,
      labelUris.modified,
      reviewCodePeekRangeCounts(reference.target.diffFile.patch, this.spec.countRanges ?? this.spec.ranges, this.spec.side),
    );
    this.unifiedModelReference = reference;
    this.editorStore.add(reference);
    const editor = this.instantiationService.createInstance(
      CodeEditorWidget,
      this.body,
      {
        ...inlineEditorOptions(this.overflowWidgetsDomNode),
        lineNumbers: reviewUnifiedLineNumbers(reference.rows),
      },
      {
        telemetryData: { source: "reviewInlineUnifiedCodeEditor" },
        contributions: EditorExtensionsRegistry.getEditorContributions(),
      },
    );
    this.editor = editor;
    reviewInlineEditors.add(editor);
    this.spec.container.dataset["reviewInlineEditorKind"] = "unified";
    this.spec.container.classList.add("review-inline-unified-diff");
    this.editorStore.add(editor);
    editor.setModel(reference.model);
    this.diffDecoration = editor.createDecorationsCollection();
    this.diffDecoration.set(
      reviewUnifiedDiffDecorations(reference.rows),
    );
    this.bindFocus(editor);
    this.trackScroll(
      () => editor.getScrollTop(),
      (listener) => editor.onDidScrollChange(listener),
    );
    this.editorStore.add(
      editor.onDidContentSizeChange((event) =>
        this.layoutCodeEditorToContent(event.contentHeight),
      ),
    );
    this.applyRange();
    this.markCreated();
  }

  private applyRange(): void {
    const codeEditor = this.editor;
    const modelReference = this.unifiedModelReference ?? this.modelReference;
    if (!codeEditor || !modelReference) return;
    this.applyWindows(codeEditor, modelReference.windows);
    this.layoutCodeEditorToContent();
    codeEditor.revealRangeInCenter(this.primaryRange());
    this.updateDecoration();
  }

  private layoutCodeEditorToContent(contentHeight?: number): void {
    const codeEditor = this.editor;
    const modelReference = this.unifiedModelReference ?? this.modelReference;
    if (!codeEditor || !modelReference) return;
    const windows = modelReference.windows;
    const lineCount = reviewPeekWindowsLineCount(windows);
    const rendered = reviewPeekWindowsRenderedHeight(codeEditor, windows);
    const estimated =
      (this.spec.heightMode === "content"
        ? lineCount
        : Math.min(REVIEW_PEEK_MAX_VISIBLE_LINES, lineCount)) *
      REVIEW_PEEK_LINE_HEIGHT;
    const renderedHeight =
      rendered !== undefined && rendered > CONTENT_HEIGHT_EPSILON
        ? Math.ceil(rendered)
        : estimated;
    // The editor's content-size event is the authoritative post-relayout
    // measurement; line geometry can still reflect the pre-zone layout during
    // that callback.
    const measured = Math.max(
      renderedHeight,
      contentHeight !== undefined && contentHeight > CONTENT_HEIGHT_EPSILON
        ? Math.ceil(contentHeight)
        : 0,
    );
    const height =
      this.spec.heightMode === "content"
        ? measured
        : reviewPeekCappedHeight(measured);
    this.setExpandedHeight(height + INLINE_HEADER_HEIGHT);
    codeEditor.layout({
      width: Math.max(1, this.spec.container.clientWidth),
      height,
    });
  }

  private setHeader(
    original: URI | undefined,
    modified: URI | undefined,
    originalLabelUri = original,
    modifiedLabelUri = modified,
    counts?: { additions: number; deletions: number },
  ): void {
    this.headerEntry = {
      original,
      modified,
      additions: counts?.additions,
      deletions: counts?.deletions,
      onDidOpen: this.spec.onDidOpen,
    };
    this.header.setData({
      originalLabelUri,
      modifiedLabelUri,
      originalUri: original,
      modifiedUri: modified,
      label: {
        name: this.spec.title,
        description: this.spec.description,
        resource: modifiedLabelUri ?? originalLabelUri,
      },
    });
  }

  private trackScroll(
    getScrollTop: () => number,
    onDidScroll: (listener: () => void) => IDisposable,
  ): void {
    const recordScrollTop = () => {
      this.spec.container.dataset["reviewInlineEditorScrollTop"] = String(
        getScrollTop(),
      );
    };
    recordScrollTop();
    this.editorStore.add(onDidScroll(recordScrollTop));
  }

  private markCreated(): void {
    this.spec.container.dataset["reviewInlineEditorCreationDuration"] = (
      performance.now() - this.startedAt
    ).toFixed(1);
    this.onStateChange();
  }

  private bindFocus(
    editor: ICodeEditor,
    store: DisposableStore = this.editorStore,
  ): void {
    store.add(markReviewEmbeddedEditor(editor));
    this.onDidBindControl(editor);
    store.add(
      editor.onDidFocusEditorText(() => {
        this.spec.onDidFocus?.();
        this.onDidFocusControl(editor);
      }),
    );
    store.add(editor.onDidBlurEditorText(() => this.onDidBlurControl()));
    const hover = ContentHoverController.get(editor);
    if (hover) {
      store.add(
        hover.onHoverContentsChanged(() => {
          const content = hover.getWidgetContent()?.trim();
          if (content) this.spec.onDidShowHover?.();
        }),
      );
    }
  }

  private updateDecoration(): void {
    const editor = this.editor;
    if (!editor) return;
    this.decoration ??= editor.createDecorationsCollection();
    this.decoration.set(
      this.ranges().map((range) => ({
        range,
        options: {
          description: "Review inline CodePeek authored range",
          isWholeLine: true,
          className: this.rangeClassName(),
          lineNumberClassName: "review-inline-code-lineno",
        },
      })),
    );
    editor.render(true);
  }

  private findModelMatches(
    editor: ICodeEditor,
    model: ITextModel,
    windows: readonly ReviewPeekWindow[],
    query: ReviewFindQuery,
  ): InlineFindMatch[] {
    return findModelRanges(model, windows, query)
      .map((match) => ({ editor, range: match.range }));
  }

  private applyFindDecorations(activeIndex = -1): void {
    const editors = new Set(this.findMatches.map((match) => match.editor));
    for (const editor of editors) {
      let collection = this.findDecorations.get(editor);
      if (!collection) {
        collection = editor.createDecorationsCollection();
        this.findDecorations.set(editor, collection);
      }
      collection.set(
        this.findMatches.flatMap((match, index) =>
          match.editor === editor
            ? [{
                range: match.range,
                options: {
                  description: "Review Find match",
                  className:
                    index === activeIndex
                      ? "review-inline-find-match review-inline-find-match-active"
                      : "review-inline-find-match",
                },
              }]
            : [],
        ),
      );
    }
  }

  private rangeClassName(): string {
    return this.active
      ? "review-inline-code-range review-inline-code-range-active"
      : "review-inline-code-range";
  }

  private applyWindows(
    editor: ICodeEditor,
    windows: readonly ReviewPeekWindow[],
  ): void {
    const model = editor.getModel();
    if (!model) return;
    editor.setHiddenAreas(
      reviewPeekHiddenAreas(model.getLineCount(), windows).map(
        (area) =>
          new Range(
            area.startLineNumber,
            1,
            area.endLineNumber,
            1,
          ),
      ),
      this,
    );
  }

  private ranges(): Range[] {
    if (this.unifiedModelReference) {
      return this.unifiedModelReference.ranges.map(
        (range) =>
          new Range(
            range.startLine,
            1,
            range.endLine,
            Number.MAX_SAFE_INTEGER,
          ),
      );
    }
    return this.spec.ranges.map(
      (range) =>
        new Range(
          range.startLine,
          1,
          range.endLine,
          Number.MAX_SAFE_INTEGER,
        ),
    );
  }

  private primaryRange(): Range {
    return this.ranges()[0]!;
  }

  private setHeight(height: number): void {
    if (height === this._height) return;
    this._height = height;
    this._onDidChangeHeight.fire(height);
  }

  private setExpandedHeight(height: number): void {
    this.expandedHeight = height;
    this.setHeight(this.collapsed.get() ? INLINE_HEADER_HEIGHT : height);
  }

  private emitError(error: unknown): void {
    this._onDidError.fire(
      error instanceof Error ? error.message : String(error),
    );
  }
}

function estimatedHeight(
  ranges: readonly { startLine: number; endLine: number }[],
  heightMode: "capped" | "content",
): number {
  const lineCount = ranges.reduce((total, range) => {
    const contextBefore = Math.min(3, Math.max(0, range.startLine - 1));
    return total + range.endLine - range.startLine + 1 + contextBefore + 3;
  }, 0);
  const visibleLineCount =
    heightMode === "content"
      ? lineCount
      : Math.min(REVIEW_PEEK_MAX_VISIBLE_LINES, lineCount);
  return (
    visibleLineCount * REVIEW_PEEK_LINE_HEIGHT + INLINE_HEADER_HEIGHT
  );
}

function findModelRanges(
  model: ITextModel,
  windows: readonly ReviewPeekWindow[],
  query: ReviewFindQuery,
) {
  const searchRanges = windows.map(
    (window) =>
      new Range(
        window.startLine,
        1,
        window.endLine,
        model.getLineMaxColumn(window.endLine),
      ),
  );
  return model
    .findMatches(
      query.text,
      searchRanges,
      query.isRegex,
      query.matchCase,
      query.wholeWord ? USUAL_WORD_SEPARATORS : null,
      false,
    )
    .filter((match) => !match.range.isEmpty());
}

function inlineEditorOptions(
  overflowWidgetsDomNode?: HTMLElement,
): IEditorConstructionOptions {
  return {
    overflowWidgetsDomNode,
    readOnly: true,
    domReadOnly: false,
    minimap: { enabled: false },
    folding: false,
    stickyScroll: { enabled: false },
    glyphMargin: false,
    lineNumbers: "on",
    lineNumbersMinChars: 3,
    lineDecorationsWidth: 8,
    overviewRulerLanes: 0,
    overviewRulerBorder: false,
    hideCursorInOverviewRuler: true,
    renderLineHighlight: "none",
    renderValidationDecorations: "off",
    selectionHighlight: false,
    occurrencesHighlight: "off",
    scrollBeyondLastLine: false,
    wordWrap: "off",
    links: true,
    quickSuggestions: false,
    suggestOnTriggerCharacters: false,
    acceptSuggestionOnEnter: "off",
    parameterHints: { enabled: false },
    inlineSuggest: { enabled: false },
    codeLens: false,
    dragAndDrop: false,
    dropIntoEditor: { enabled: false },
    pasteAs: { enabled: false },
    padding: { top: 0, bottom: 0 },
    scrollbar: {
      vertical: "auto",
      horizontal: "auto",
      alwaysConsumeMouseWheel: false,
      useShadows: false,
      verticalScrollbarSize: 8,
      horizontalScrollbarSize: 8,
    },
    fixedOverflowWidgets: true,
    automaticLayout: true,
  };
}
