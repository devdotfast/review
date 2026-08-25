/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from "../../base/common/event.js";
import {
  Disposable,
  DisposableStore,
} from "../../base/common/lifecycle.js";
import type { ICodeEditor } from "../../editor/browser/editorBrowser.js";
import type { IMultiDiffEditorViewState } from "../../editor/browser/widget/multiDiffEditor/multiDiffEditorWidgetImpl.js";
import { IInstantiationService } from "../../platform/instantiation/common/instantiation.js";
import type {
  ReviewCommitScope,
  ReviewDiffFileWire,
  ReviewDiffViewFactory,
  ReviewDiffViewHandle,
  ReviewDiffViewSpec,
} from "../common/reviewProtocol.js";
import { IReviewCodeResourceService } from "./reviewCodeResourceService.js";
import {
  buildReviewFilesEntries,
  ReviewFilesDiffView,
  ReviewFilesEditorInput,
  reviewFilesSourceUri,
} from "./reviewFilesDiffView.js";
import type { ReviewInlineEditorService } from "./reviewInlineEditorService.js";
import { markReviewEmbeddedEditor } from "./reviewEmbeddedNavigation.js";
import { IReviewSessionModelService } from "./reviewSessionModelService.js";

/**
 * Mounts the changed-files diff UI inside the Review canvas. One instance
 * belongs to one canvas pane, so its view-state cache and its live handles
 * follow that pane's lifetime.
 */
export class ReviewDiffViewService
  extends Disposable
  implements ReviewDiffViewFactory
{
  private overflowWidgetsDomNode: HTMLElement | undefined;
  private readonly handles = new Set<DiffViewHandle>();
  /**
   * Scroll and expansion state per session document. The Diff view is a
   * conditionally rendered React sibling: a toggle away disposes the widget,
   * so the state must survive outside it.
   */
  private readonly viewStates = new Map<string, IMultiDiffEditorViewState>();

  constructor(
    private readonly inlineEditors: ReviewInlineEditorService,
    @IInstantiationService
    private readonly instantiationService: IInstantiationService,
    @IReviewSessionModelService
    private readonly sessionModelService: IReviewSessionModelService,
    @IReviewCodeResourceService
    private readonly codeResources: IReviewCodeResourceService,
  ) {
    super();
  }

  setOverflowWidgetsDomNode(node: HTMLElement): void {
    this.overflowWidgetsDomNode = node;
  }

  create(spec: ReviewDiffViewSpec): ReviewDiffViewHandle {
    const handle = new DiffViewHandle(
      spec,
      this.instantiationService,
      this.sessionModelService,
      this.codeResources,
      this.inlineEditors,
      this.overflowWidgetsDomNode,
      this.viewStates,
      () => this.handles.delete(handle),
    );
    this.handles.add(handle);
    return handle;
  }

  files(
    scope?: ReviewCommitScope,
  ): Promise<readonly ReviewDiffFileWire[]> {
    return this.codeResources.files(scope);
  }

  reset(): void {
    for (const handle of [...this.handles]) handle.dispose();
    this.handles.clear();
    this.viewStates.clear();
  }

  toggleRenderSideBySide(): void {
    for (const handle of this.handles) handle.toggleRenderSideBySide();
  }
}

class DiffViewHandle extends Disposable implements ReviewDiffViewHandle {
  private readonly _onDidError = this._register(new Emitter<string>());
  readonly onDidError = this._onDidError.event;
  private readonly activeControlStore = this._register(new DisposableStore());
  private view: ReviewFilesDiffView | undefined;
  private viewStateKey: string | undefined;
  private adoptedEditors: readonly ICodeEditor[] = [];
  private disposed = false;

  constructor(
    private readonly spec: ReviewDiffViewSpec,
    private readonly instantiationService: IInstantiationService,
    private readonly sessionModelService: IReviewSessionModelService,
    private readonly codeResources: IReviewCodeResourceService,
    private readonly inlineEditors: ReviewInlineEditorService,
    private readonly overflowWidgetsDomNode: HTMLElement | undefined,
    private readonly viewStates: Map<string, IMultiDiffEditorViewState>,
    private readonly onDispose: () => void,
  ) {
    super();
    void this.initialize();
  }

  focus(): void {
    this.view?.focus();
  }

  toggleRenderSideBySide(): void {
    this.view?.toggleRenderSideBySide();
  }

  override dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.captureViewState();
    // A view toggle disposes these editors. The composite must not keep one
    // of them as its active editor afterwards.
    for (const editor of this.adoptedEditors) {
      this.inlineEditors.clearExternalActiveEditor(editor);
    }
    this.adoptedEditors = [];
    this.view = undefined;
    super.dispose();
    this.onDispose();
  }

  private async initialize(): Promise<void> {
    try {
      const session = this.sessionModelService.activeModel?.session;
      if (!session) throw new Error("No active Review Desktop session.");
      this.viewStateKey = `${session.session.sessionId}:${session.session.routePath ?? "/"}:${this.spec.scope?.commit ?? "full"}`;
      const entries = await buildReviewFilesEntries(
        this.codeResources,
        this.spec.scope,
      );
      if (this.disposed) return;
      const store = this._register(new DisposableStore());
      // The input owns the text-model references its view model resolves, so
      // this handle disposes it alongside the view.
      const input = store.add(
        this.instantiationService.createInstance(
          ReviewFilesEditorInput,
          reviewFilesSourceUri(session, this.spec.scope),
          entries,
        ),
      );
      const view = store.add(
        this.instantiationService.createInstance(
          ReviewFilesDiffView,
          this.spec.container,
          this.overflowWidgetsDomNode,
        ),
      );
      this.view = view;
      store.add(
        view.onDidChangeActiveControl(() => this.bindActiveControl(view)),
      );
      await view.setInput(input, this.viewStates.get(this.viewStateKey));
      if (this.disposed) return;
      this.bindActiveControl(view);
    } catch (error) {
      if (this.disposed) return;
      this._onDidError.fire(
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  /**
   * Joins the embedded diff's inner editors to the canvas composite. Find, the
   * editor context keys, and the comment commands all act on the composite's
   * active editor, so a focused inner editor has to become that editor.
   */
  private bindActiveControl(view: ReviewFilesDiffView): void {
    this.activeControlStore.clear();
    const diffEditor = view.getActiveControl();
    if (!diffEditor) return;
    const editors: readonly ICodeEditor[] = [
      diffEditor.getOriginalEditor(),
      diffEditor.getModifiedEditor(),
    ];
    this.adoptedEditors = editors;
    for (const editor of editors) {
      this.activeControlStore.add(markReviewEmbeddedEditor(editor));
      this.activeControlStore.add(
        editor.onDidFocusEditorText(() =>
          this.inlineEditors.setExternalActiveEditor(editor),
        ),
      );
    }
  }

  private captureViewState(): void {
    const key = this.viewStateKey;
    const state = this.view?.getViewState();
    if (!key || !state) return;
    this.viewStates.set(key, state);
  }
}
