/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Dimension } from "../../base/browser/dom.js";
import { Emitter } from "../../base/common/event.js";
import {
  Disposable,
  DisposableStore,
  type IDisposable,
} from "../../base/common/lifecycle.js";
import { autorun, observableValue } from "../../base/common/observable.js";
import { URI } from "../../base/common/uri.js";
import type { IEditorConstructionOptions } from "../../editor/browser/config/editorConfiguration.js";
import { ElementSizeObserver } from "../../editor/browser/config/elementSizeObserver.js";
import type {
  ICodeEditor,
  IDiffEditor,
} from "../../editor/browser/editorBrowser.js";
import { ICodeEditorService } from "../../editor/browser/services/codeEditorService.js";
import { CodeEditorWidget } from "../../editor/browser/widget/codeEditor/codeEditorWidget.js";
import { EditorExtensionsRegistry } from "../../editor/browser/editorExtensions.js";
import { MultiDiffEditorWidget } from "../../editor/browser/widget/multiDiffEditor/multiDiffEditorWidget.js";
import {
  MULTI_DIFF_RESOURCE_HEADER_HEIGHT,
  MultiDiffEditorResourceHeader,
} from "../../editor/browser/widget/multiDiffEditor/multiDiffEditorResourceHeader.js";
import type { IDiffEditorOptions } from "../../editor/common/config/editorOptions.js";
import { Range } from "../../editor/common/core/range.js";
import { USUAL_WORD_SEPARATORS } from "../../editor/common/core/wordHelper.js";
import type {
  ICompositeCodeEditor,
  IEditorDecorationsCollection,
} from "../../editor/common/editorCommon.js";
import type { ITextModel } from "../../editor/common/model.js";
import { ITextModelService } from "../../editor/common/services/resolverService.js";
import { ITextResourceConfigurationService } from "../../editor/common/services/textResourceConfiguration.js";
import { IInstantiationService } from "../../platform/instantiation/common/instantiation.js";
import type { ITextResourceEditorInput } from "../../platform/editor/common/editor.js";
import { REVIEW_UNIFIED_SCHEME } from "../common/reviewCodeResources.js";
import {
  REVIEW_PEEK_LINE_HEIGHT,
  REVIEW_PEEK_MAX_VISIBLE_LINES,
  reviewPeekCappedHeight,
  reviewPeekHiddenAreas,
  reviewPeekMultiDiffBodyHeightLimit,
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
  type ReviewCodeDiffTarget,
  type ReviewCodeModelReference,
} from "./reviewCodeResourceService.js";
import {
  ReviewMultiDiffUIElementFactory,
  reviewMultiDiffLabelUris,
  type ReviewMultiDiffHeaderEntry,
} from "./reviewMultiDiff.js";
import { markReviewEmbeddedEditor } from "./reviewEmbeddedNavigation.js";
import {
  computeMultiDiffEditorOptions,
  MultiDiffEditorInput,
} from "../../workbench/contrib/multiDiffEditor/browser/multiDiffEditorInput.js";
import { MultiDiffEditorItem } from "../../workbench/contrib/multiDiffEditor/browser/multiDiffSourceResolverService.js";
import { ID as COMMENT_EDITOR_CONTRIBUTION_ID } from "../../workbench/contrib/comments/browser/commentsController.js";
import { ContentHoverController } from "../../editor/contrib/hover/browser/contentHoverController.js";

const INLINE_HEADER_HEIGHT = MULTI_DIFF_RESOURCE_HEADER_HEIGHT;
const CONTENT_HEIGHT_EPSILON = 0.5;
const reviewInlineEditors = new WeakSet<ICodeEditor>();

interface InlineDiffModel {
  readonly original: ITextModel;
  readonly modified: ITextModel;
  readonly originalWindows: readonly ReviewPeekWindow[];
  readonly modifiedWindows: readonly ReviewPeekWindow[];
}

interface InlineFindMatch {
  readonly editor: ICodeEditor;
  readonly range: Range;
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
    @ITextResourceConfigurationService
    private readonly textResourceConfigurationService: ITextResourceConfigurationService,
    @ICodeEditorService
    private readonly codeEditorService: ICodeEditorService,
    @ITextModelService
    private readonly textModelService: ITextModelService,
  ) {
    super();
    this._register(
      this.codeEditorService.registerCodeEditorOpenHandler(
        (input, source, sideBySide) =>
          this.openUnifiedNavigation(input, source, sideBySide),
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

  create(spec: ReviewInlineEditorSpec): ReviewInlineEditorHandle {
    const handle = new InlineEditorHandle(
      spec,
      this.instantiationService,
      this.resources,
      this.textResourceConfigurationService,
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
    );
    this.handles.add(handle);
    this.updateMetrics(spec.container.ownerDocument);
    return handle;
  }

  async find(
    spec: ReviewInlineFindSpec,
    query: ReviewFindQuery,
  ): Promise<ReviewInlineFindResult> {
    if (!query.text) return { matchCount: 0 };
    const diff = await this.resources.resolveDiff(
      spec.path,
      spec.side,
      spec.ranges,
    );
    if (diff) {
      const [original, modified] = await Promise.all([
        this.textModelService.createModelReference(diff.original),
        this.textModelService.createModelReference(diff.modified),
      ]);
      try {
        const originalModel = original.object.textEditorModel;
        const modifiedModel = modified.object.textEditorModel;
        if (!originalModel || !modifiedModel) return { matchCount: 0 };
        const windows = diff.windows(
          originalModel.getLineCount(),
          modifiedModel.getLineCount(),
        );
        return {
          matchCount:
            findModelRanges(originalModel, windows.original, query).length +
            findModelRanges(modifiedModel, windows.modified, query).length,
        };
      } finally {
        original.dispose();
        modified.dispose();
      }
    }
    const snippet = await this.resources.acquireSnippet(
      spec.path,
      spec.side,
      spec.ranges,
    );
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
   * in-tab diff — the composite's active one. Find, the editor context keys,
   * and the comment commands all read the composite.
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
  private readonly activeDiffEditorStore = this._register(
    new DisposableStore(),
  );
  private readonly collapsed = observableValue(this, false);
  private readonly header: MultiDiffEditorResourceHeader;
  private readonly body: HTMLElement;
  private headerEntry: ReviewMultiDiffHeaderEntry | undefined;
  private editor: CodeEditorWidget | undefined;
  private multiDiffEditor: MultiDiffEditorWidget | undefined;
  private modelReference: ReviewCodeModelReference | undefined;
  private diffModel: InlineDiffModel | undefined;
  private decoration: IEditorDecorationsCollection | undefined;
  private readonly diffRangeDecorations = new Map<
    ICodeEditor,
    IEditorDecorationsCollection
  >();
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
  /**
   * Confines the widget's scroll space to the peek window. Alignment view
   * zones for hidden out-of-window hunks inflate the widget's content
   * height; without the range the widget would scroll into that filler,
   * trap the wheel there, and size the scrollbar against unreachable room.
   * With it, scrollTop 0 is the window top, Monaco releases the wheel to
   * the document at both boundaries, and the Auto scrollbar hides itself
   * when the window fits.
   */
  private readonly scrollRange = observableValue<
    { start: number; endExclusive: number } | undefined
  >(this, undefined);
  private readonly startedAt = performance.now();

  get height(): number {
    return this._height;
  }

  get hasWidget(): boolean {
    return this.editor !== undefined || this.multiDiffEditor !== undefined;
  }

  get hasModel(): boolean {
    return this.modelReference !== undefined || this.diffModel !== undefined;
  }

  constructor(
    private readonly spec: ReviewInlineEditorSpec,
    private readonly instantiationService: IInstantiationService,
    private readonly resources: IReviewCodeResourceService,
    private readonly textResourceConfigurationService: ITextResourceConfigurationService,
    private readonly overflowWidgetsDomNode: HTMLElement | undefined,
    private readonly onDispose: () => void,
    private readonly onStateChange: () => void,
    private readonly onDidFocusControl: (control: ICodeEditor) => void,
    private readonly onDidBlurControl: () => void,
    private readonly onDidBindControl: (control: ICodeEditor) => void,
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
    if (this.editor?.hasTextFocus()) return true;
    const diffEditor = this.multiDiffEditor?.getActiveControl();
    return Boolean(
      diffEditor?.getOriginalEditor().hasTextFocus() ||
        diffEditor?.getModifiedEditor().hasTextFocus(),
    );
  }

  setActive(active: boolean): void {
    if (this.active === active) return;
    this.active = active;
    if (this.multiDiffEditor && active) this.applyRange();
    else this.updateDecoration();
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
    const modelReference = this.modelReference;
    if (codeEditor && modelReference) {
      matches.push(
        ...this.findModelMatches(
          codeEditor,
          modelReference.model,
          modelReference.windows,
          query,
        ),
      );
    } else if (this.diffModel) {
      const diffEditor = this.multiDiffEditor?.getActiveControl();
      if (diffEditor) {
        matches.push(
          ...this.findModelMatches(
            diffEditor.getOriginalEditor(),
            this.diffModel.original,
            this.diffModel.originalWindows,
            query,
          ),
          ...this.findModelMatches(
            diffEditor.getModifiedEditor(),
            this.diffModel.modified,
            this.diffModel.modifiedWindows,
            query,
          ),
        );
      }
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
    for (const collection of this.diffRangeDecorations.values()) {
      collection.clear();
    }
    this.diffRangeDecorations.clear();
    this.editorStore.dispose();
    this.spec.container.replaceChildren();
    this.spec.container.classList.remove("review-inline-code-editor");
    super.dispose();
    this.onDispose();
  }

  private async initialize(): Promise<void> {
    try {
      const diffTarget = await this.resources.resolveDiff(
        this.spec.path,
        this.spec.side,
        this.spec.ranges,
      );
      if (diffTarget) {
        if (this.disposed) return;
        await this.initializeMultiDiffEditor(diffTarget);
        return;
      }
      const modelReference = await this.resources.acquireSnippet(
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
          contributions: reviewInlineEditorContributions(
            this.spec.commentsEnabled === true,
          ),
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
        editor.onDidContentSizeChange(() => this.layoutCodeEditorToContent()),
      );
      this.applyRange();
      this.markCreated();
    } catch (error) {
      if (!this.disposed) this.emitError(error);
    }
  }

  private async initializeMultiDiffEditor(
    target: ReviewCodeDiffTarget,
  ): Promise<void> {
    const labelUris = reviewMultiDiffLabelUris(target.diffFile);
    this.setHeader(
      target.original,
      target.modified,
      labelUris.original,
      labelUris.modified,
    );
    const options = inlineDiffEditorOptions(
      computeMultiDiffEditorOptions(
        this.textResourceConfigurationService.getValue(
          labelUris.modified ?? labelUris.original,
        ),
      ),
    );
    const input = this.instantiationService.createInstance(
      MultiDiffEditorInput,
      URI.from({
        scheme: "devfast-review-code-peek",
        path: `/${this.spec.path}`,
        query: `${this.spec.side}:${this.spec.ranges
          .map(
            (range) =>
              `${range.side ?? this.spec.side}:${range.startLine}-${range.endLine}`,
          )
          .join(",")}`,
      }),
      this.spec.title,
      [
        new MultiDiffEditorItem(
          target.original,
          target.modified,
          this.spec.side === "base" ? target.original : target.modified,
          undefined,
          undefined,
          labelUris,
          options,
          {
            name: this.spec.title,
            description: this.spec.description,
            resource: labelUris.modified ?? labelUris.original,
          },
        ),
      ],
      true,
    );
    let viewModel: Awaited<ReturnType<MultiDiffEditorInput["getViewModel"]>>;
    try {
      viewModel = await input.getViewModel();
    } catch (error) {
      input.dispose();
      throw error;
    }
    if (this.disposed) {
      input.dispose();
      return;
    }
    this.editorStore.add(input);
    const document = viewModel.items.get()[0]?.documentDiffItem;
    if (!document?.original || !document.modified) {
      throw new Error(
        `Native diff could not resolve text content: ${this.spec.path}`,
      );
    }
    const windows = target.windows(
      document.original.getLineCount(),
      document.modified.getLineCount(),
    );
    this.diffModel = {
      original: document.original,
      modified: document.modified,
      originalWindows: windows.original,
      modifiedWindows: windows.modified,
    };
    const widget = this.instantiationService.createInstance(
      MultiDiffEditorWidget,
      this.body,
      this.instantiationService.createInstance(
        ReviewMultiDiffUIElementFactory,
        () => [
          this.headerEntry!,
        ],
        "hidden",
        this.overflowWidgetsDomNode,
        this.scrollRange,
        true,
        reviewInlineDiffEditorContributions(
          this.spec.commentsEnabled === true,
        ),
      ),
      options,
    );
    this.multiDiffEditor = widget;
    this.spec.container.dataset["reviewInlineEditorKind"] = "multi-diff";
    this.editorStore.add(widget);
    const sizeObserver = this.editorStore.add(
      new ElementSizeObserver(this.spec.container, undefined),
    );
    this.editorStore.add(
      sizeObserver.onDidChange(() => this.layoutMultiDiffToContent()),
    );
    sizeObserver.startObserving();
    this.trackScroll(
      () => widget.getScrollTop(),
      (listener) => widget.onDidScroll(listener),
    );
    this.editorStore.add(
      widget.onDidChangeActiveControl(() => this.bindActiveDiffEditor()),
    );
    this.editorStore.add(
      widget.onDidChangeContentHeight(() => this.layoutMultiDiffToContent()),
    );
    widget.setViewModel(viewModel, {
      preserveFocus: true,
      initialScrollPosition: "top",
    });
    this.applyRange();
    this.bindActiveDiffEditor();
    this.markCreated();
  }

  private bindActiveDiffEditor(): void {
    this.activeDiffEditorStore.clear();
    this.diffRangeDecorations.clear();
    const diffEditor = this.multiDiffEditor?.getActiveControl();
    if (diffEditor && this.diffModel) {
      const originalEditor = diffEditor.getOriginalEditor();
      const modifiedEditor = diffEditor.getModifiedEditor();
      for (const editor of [originalEditor, modifiedEditor]) {
        reviewInlineEditors.add(editor);
        this.bindFocus(editor, this.activeDiffEditorStore);
      }
      this.activeDiffEditorStore.add(
        diffEditor.onDidUpdateDiff(() => this.applyRange()),
      );
      // Diff view zones can change after the outer widget lays out. Track the
      // inner editors so the peek height and scroll range stay current.
      this.activeDiffEditorStore.add(
        diffEditor.onDidContentSizeChange(() =>
          this.layoutMultiDiffToContent(),
        ),
      );
    }
    this.applyRange();
  }

  private applyRange(): void {
    const multiDiffEditor = this.multiDiffEditor;
    const diffModel = this.diffModel;
    if (multiDiffEditor && diffModel) {
      const diffEditor = multiDiffEditor.getActiveControl();
      this.spec.container.dataset["reviewInlineEditorRangeRestricted"] =
        "true";
      if (diffEditor) {
        this.applyWindows(
          diffEditor.getOriginalEditor(),
          diffModel.originalWindows,
        );
        this.applyWindows(
          diffEditor.getModifiedEditor(),
          diffModel.modifiedWindows,
        );
        this.updateDiffDecorations(diffEditor);
        // reveal() scrolls the widget to the top of the item, which for a
        // windowed peek can be alignment view zones for hidden hunks. It
        // must run before layoutMultiDiffToContent(), whose scroll pin
        // repositions the viewport at the window's rendered top.
        multiDiffEditor.reveal({
          original: diffModel.original.uri,
          modified: diffModel.modified.uri,
        });
      }
      this.layoutMultiDiffToContent();
      return;
    }
    const codeEditor = this.editor;
    const modelReference = this.modelReference;
    if (!codeEditor || !modelReference) return;
    this.applyWindows(codeEditor, modelReference.windows);
    this.layoutCodeEditorToContent();
    codeEditor.revealRangeInCenter(this.primaryRange());
    this.updateDecoration();
  }

  private layoutCodeEditorToContent(): void {
    const codeEditor = this.editor;
    const modelReference = this.modelReference;
    if (!codeEditor || !modelReference) return;
    const windows = modelReference.windows;
    const lineCount = reviewPeekWindowsLineCount(windows);
    const rendered = reviewPeekWindowsRenderedHeight(codeEditor, windows);
    const estimated =
      (this.spec.heightMode === "content"
        ? lineCount
        : Math.min(REVIEW_PEEK_MAX_VISIBLE_LINES, lineCount)) *
      REVIEW_PEEK_LINE_HEIGHT;
    const measured =
      rendered !== undefined && rendered > CONTENT_HEIGHT_EPSILON
        ? Math.ceil(rendered)
        : estimated;
    const height =
      this.spec.heightMode === "content"
        ? measured
        : reviewPeekCappedHeight(
            measured,
            this.commentViewZoneHeight(codeEditor),
          );
    this.setExpandedHeight(height + INLINE_HEADER_HEIGHT);
    codeEditor.layout({
      width: Math.max(1, this.spec.container.clientWidth),
      height,
    });
  }

  private layoutMultiDiffToContent(): void {
    const multiDiffEditor = this.multiDiffEditor;
    if (!multiDiffEditor) return;
    const bodyHeight = this.multiDiffBodyHeight(multiDiffEditor);
    this.setExpandedHeight(bodyHeight + INLINE_HEADER_HEIGHT);
    multiDiffEditor.layout(
      new Dimension(
        Math.max(1, this.spec.container.clientWidth),
        bodyHeight,
      ),
    );
    this.applyMultiDiffScrollRange(multiDiffEditor, bodyHeight);
  }

  /**
   * The peek window's offsets inside the widget's content space. Hunks
   * before the window leave alignment view zones ABOVE its lines, so the
   * window's rendered top is a real content offset, not 0. Recomputed on
   * every layout — word wrap resolves asynchronously and grows both the
   * offset and the rendered height after the first measure.
   */
  private applyMultiDiffScrollRange(
    multiDiffEditor: MultiDiffEditorWidget,
    bodyHeight: number,
  ): void {
    const diffEditor = multiDiffEditor.getActiveControl();
    const diffModel = this.diffModel;
    if (!diffEditor || !diffModel) return;
    const modifiedEditor = diffEditor.getModifiedEditor();
    const firstModifiedWindow = diffModel.modifiedWindows[0];
    if (!modifiedEditor.getModel() || !firstModifiedWindow) return;
    const top = modifiedEditor.getTopForLineNumber(
      firstModifiedWindow.startLine,
    );
    if (top < 0) return;
    const rendered = reviewPeekWindowsRenderedHeight(
      modifiedEditor,
      diffModel.modifiedWindows,
    );
    this.scrollRange.set(
      { start: top, endExclusive: top + Math.max(rendered ?? 0, bodyHeight) },
      undefined,
    );
  }

  /**
   * All bounds are computed here, at layout time, from current state — this
   * runs from size and content-height events in any order relative to
   * applyRange(), so cached limits would go stale. A rendered-window
   * measurement is used as-is (wrap-aware, exact); anything else — no active
   * control, model-less inner editors — is clamped to the window-derived
   * bound so the widget's getContentHeight(), which alignment view zones for
   * hidden out-of-window hunks inflate permanently, can never reach the DOM
   * unbounded.
   */
  private multiDiffBodyHeight(
    multiDiffEditor: MultiDiffEditorWidget,
  ): number {
    const heightMode = this.spec.heightMode;
    const cap = REVIEW_PEEK_MAX_VISIBLE_LINES * REVIEW_PEEK_LINE_HEIGHT;
    const rendered = this.multiDiffWindowContentHeight();
    if (rendered !== undefined && rendered > CONTENT_HEIGHT_EPSILON) {
      if (heightMode === "content") return Math.ceil(rendered);
      return this.cappedMultiDiffWindowContentHeight() ?? cap;
    }
    const diffModel = this.diffModel;
    const windowBound = diffModel
      ? reviewPeekMultiDiffBodyHeightLimit(
          heightMode,
          diffModel.originalWindows,
          diffModel.modifiedWindows,
        )
      : cap;
    const measured = multiDiffEditor.getContentHeight();
    return measured > CONTENT_HEIGHT_EPSILON
      ? Math.min(windowBound, Math.ceil(measured))
      : windowBound;
  }

  /**
   * Height of the peek windows as actually rendered: includes wrapped lines
   * and the in-window diff zones, excludes the alignment view zones the diff
   * editor creates for hidden out-of-window hunks. Those zones survive
   * setHiddenAreas and count toward getContentHeight(), so the widget
   * measurement over-reports by the size of every hunk outside the window.
   */
  private multiDiffWindowContentHeight(): number | undefined {
    const diffEditor = this.multiDiffEditor?.getActiveControl();
    const diffModel = this.diffModel;
    if (!diffEditor || !diffModel) return undefined;
    const original = reviewPeekWindowsRenderedHeight(
      diffEditor.getOriginalEditor(),
      diffModel.originalWindows,
    );
    const modified = reviewPeekWindowsRenderedHeight(
      diffEditor.getModifiedEditor(),
      diffModel.modifiedWindows,
    );
    if (original === undefined && modified === undefined) return undefined;
    return Math.max(original ?? 0, modified ?? 0);
  }

  private cappedMultiDiffWindowContentHeight(): number | undefined {
    const diffEditor = this.multiDiffEditor?.getActiveControl();
    const diffModel = this.diffModel;
    if (!diffEditor || !diffModel) return undefined;
    const originalEditor = diffEditor.getOriginalEditor();
    const modifiedEditor = diffEditor.getModifiedEditor();
    const original = reviewPeekWindowsRenderedHeight(
      originalEditor,
      diffModel.originalWindows,
    );
    const modified = reviewPeekWindowsRenderedHeight(
      modifiedEditor,
      diffModel.modifiedWindows,
    );
    if (original === undefined && modified === undefined) return undefined;
    return Math.max(
      original === undefined
        ? 0
        : reviewPeekCappedHeight(
            Math.ceil(original),
            this.commentViewZoneHeight(originalEditor),
          ),
      modified === undefined
        ? 0
        : reviewPeekCappedHeight(
            Math.ceil(modified),
            this.commentViewZoneHeight(modifiedEditor),
          ),
    );
  }

  private commentViewZoneHeight(editor: ICodeEditor): number {
    const editorNode = editor.getDomNode();
    if (!editorNode) return 0;
    let height = 0;
    for (const zone of editorNode.querySelectorAll<HTMLElement>(
      ".review-widget.compact-comment-thread[monaco-view-zone]",
    )) {
      height += zone.getBoundingClientRect().height;
    }
    return height;
  }

  private setHeader(
    original: URI | undefined,
    modified: URI | undefined,
    originalLabelUri = original,
    modifiedLabelUri = modified,
  ): void {
    this.headerEntry = {
      original,
      modified,
      additions: this.spec.diffStats?.additions,
      deletions: this.spec.diffStats?.deletions,
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
    const diffEditor = this.multiDiffEditor?.getActiveControl();
    if (diffEditor) {
      this.updateDiffDecorations(diffEditor);
      return;
    }
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

  private updateDiffDecorations(diffEditor: IDiffEditor): void {
    const defaultSide = this.spec.side;
    const editors: readonly (readonly ["base" | "head", ICodeEditor])[] = [
      ["base", diffEditor.getOriginalEditor()],
      ["head", diffEditor.getModifiedEditor()],
    ];
    for (const [side, editor] of editors) {
      let collection = this.diffRangeDecorations.get(editor);
      if (!collection) {
        collection = editor.createDecorationsCollection();
        this.diffRangeDecorations.set(editor, collection);
      }
      collection.set(
        this.spec.ranges
          .filter((range) => (range.side ?? defaultSide) === side)
          .map((range) => ({
            range: new Range(
              range.startLine,
              1,
              range.endLine,
              Number.MAX_SAFE_INTEGER,
            ),
            options: {
              description: "Review inline CodePeek authored range",
              isWholeLine: true,
              className: this.rangeClassName(),
              lineNumberClassName: "review-inline-code-lineno",
            },
          })),
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

function reviewInlineEditorContributions(commentsEnabled: boolean) {
  const contributions = EditorExtensionsRegistry.getEditorContributions();
  return commentsEnabled
    ? contributions
    : contributions.filter(
        (contribution) => contribution.id !== COMMENT_EDITOR_CONTRIBUTION_ID,
      );
}

function reviewInlineDiffEditorContributions(commentsEnabled: boolean) {
  const contributions = reviewInlineEditorContributions(commentsEnabled);
  return {
    originalEditor: { contributions },
    modifiedEditor: { contributions },
  };
}

function inlineDiffEditorOptions(
  nativeOptions: IDiffEditorOptions,
): IDiffEditorOptions {
  return {
    ...nativeOptions,
    ...inlineEditorOptions(),
    renderSideBySide: nativeOptions.renderSideBySide,
    useInlineViewWhenSpaceIsLimited: true,
    renderSideBySideInlineBreakpoint: 720,
    compactMode: true,
    renderMarginRevertIcon: false,
    renderGutterMenu: false,
    originalEditable: false,
    diffCodeLens: false,
    renderOverviewRuler: false,
    diffWordWrap: "off",
    hideUnchangedRegions: {
      enabled: false,
    },
  };
}
