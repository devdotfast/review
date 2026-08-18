/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import "../browser/media/review.css";

import {
  $,
  append,
  Dimension,
} from "../../base/browser/dom.js";
import {
  Orientation,
  SplitView,
} from "../../base/browser/ui/splitview/splitview.js";
import { Emitter, Event } from "../../base/common/event.js";
import { Disposable, toDisposable } from "../../base/common/lifecycle.js";
import { isEqual } from "../../base/common/resources.js";
import { URI } from "../../base/common/uri.js";
import { ElementSizeObserver } from "../../editor/browser/config/elementSizeObserver.js";
import type { IDiffEditor } from "../../editor/browser/editorBrowser.js";
import { MultiDiffEditorWidget } from "../../editor/browser/widget/multiDiffEditor/multiDiffEditorWidget.js";
import { MultiDiffEditorViewModel } from "../../editor/browser/widget/multiDiffEditor/multiDiffEditorViewModel.js";
import { IDiffEditorOptions } from "../../editor/common/config/editorOptions.js";
import type { IMultiDiffEditorViewState } from "../../editor/browser/widget/multiDiffEditor/multiDiffEditorWidgetImpl.js";
import { ITextResourceConfigurationService } from "../../editor/common/services/textResourceConfiguration.js";
import { ITextModelService } from "../../editor/common/services/resolverService.js";
import { IInstantiationService } from "../../platform/instantiation/common/instantiation.js";
import { MultiDiffEditorInput } from "../../workbench/contrib/multiDiffEditor/browser/multiDiffEditorInput.js";
import {
  IMultiDiffSourceResolverService,
  MultiDiffEditorItem,
} from "../../workbench/contrib/multiDiffEditor/browser/multiDiffSourceResolverService.js";
import { IEditorGroupsService } from "../../workbench/services/editor/common/editorGroupsService.js";
import { IEditorService } from "../../workbench/services/editor/common/editorService.js";
import { ITextFileService } from "../../workbench/services/textfile/common/textfiles.js";
import {
  type ReviewCommitScope,
  type ReviewDiffFileWire,
} from "../common/reviewProtocol.js";
import {
  orderReviewDiffFiles,
  ReviewChangedFilesTree,
} from "../browser/reviewChangedFilesTree.js";
import type {
  IReviewCodeResourceService,
} from "./reviewCodeResourceService.js";
import type { ReviewDesktopSession } from "./reviewSessionModelService.js";
import {
  ReviewMultiDiffUIElementFactory,
  reviewMultiDiffLabelUris,
} from "./reviewMultiDiff.js";

const FILE_TREE_MINIMUM_WIDTH = 180;
const DIFF_MINIMUM_WIDTH = 320;
const FILE_TREE_COLLAPSE_WIDTH =
  FILE_TREE_MINIMUM_WIDTH + DIFF_MINIMUM_WIDTH;
const INLINE_COMMENT_WIDTH_RESERVE = 480;
const OPEN_INLINE_COMMENT_SELECTOR = [
  ".review-widget.compact-comment-thread:not(:has(.review-comment))",
  ".review-widget.compact-comment-thread:has(.comment-form-container.expand)",
].join(", ");
const REVIEW_FILES_DIFF_EDITOR_OPTIONS = {
  hideUnchangedRegions: { enabled: true },
  originalEditable: false,
  readOnly: true,
  glyphMargin: false,
  lineNumbersMinChars: 3,
} satisfies IDiffEditorOptions;

export interface ReviewFilesEditorEntry {
  readonly file: ReviewDiffFileWire;
  readonly original: URI;
  readonly modified: URI;
  readonly goToFileResource: URI;
}

/** The multi-diff source URI that identifies one session's changed files. */
export function reviewFilesSourceUri(
  session: ReviewDesktopSession,
  scope?: ReviewCommitScope,
): URI {
  return URI.from({
    scheme: "devfast-review-files",
    authority: session.session.sessionId,
    path: session.session.routePath ?? "/",
    query: scope?.commit ? `commit=${scope.commit}` : undefined,
  });
}

/** Resolves one diff entry per changed file, base and head side by side. */
export async function buildReviewFilesEntries(
  codeResources: IReviewCodeResourceService,
  scope?: ReviewCommitScope,
): Promise<readonly ReviewFilesEditorEntry[]> {
  const files = orderReviewDiffFiles(await codeResources.files(scope));
  return Promise.all(
    files.map(async (file): Promise<ReviewFilesEditorEntry> => {
      const modified = await codeResources.target(file.path, "head", scope);
      const original = await codeResources.target(
        file.previousPath ?? file.path,
        "base",
        scope,
      );
      return {
        file,
        original: original.resource,
        modified: modified.resource,
        goToFileResource:
          file.status === "deleted" ? original.resource : modified.resource,
      };
    }),
  );
}

export class ReviewFilesEditorInput extends MultiDiffEditorInput {
  static override readonly ID = "workbench.input.devfast.reviewFiles";
  static readonly EDITOR_ID = "workbench.editor.devfast.reviewFiles";

  constructor(
    source: URI,
    readonly entries: readonly ReviewFilesEditorEntry[],
    @ITextModelService textModelService: ITextModelService,
    @ITextResourceConfigurationService
    textResourceConfigurationService: ITextResourceConfigurationService,
    @IInstantiationService instantiationService: IInstantiationService,
    @IMultiDiffSourceResolverService
    multiDiffSourceResolverService: IMultiDiffSourceResolverService,
    @ITextFileService textFileService: ITextFileService,
  ) {
    super(
      source,
      "Files",
      entries.map(
        (entry) =>
          new MultiDiffEditorItem(
            entry.original,
            entry.modified,
            entry.goToFileResource,
            undefined,
            undefined,
            reviewMultiDiffLabelUris(entry.file),
            REVIEW_FILES_DIFF_EDITOR_OPTIONS,
          ),
      ),
      true,
      textModelService,
      textResourceConfigurationService,
      instantiationService,
      multiDiffSourceResolverService,
      textFileService,
    );
  }

  override get typeId(): string {
    return ReviewFilesEditorInput.ID;
  }

  override get editorId(): string {
    return ReviewFilesEditorInput.EDITOR_ID;
  }
}

/**
 * The changed-files diff UI — a file list beside a multi-diff widget — as a
 * plain widget. It owns no editor pane, so the Review canvas can mount it into
 * a container the app supplies. The container's size drives the layout: the
 * canvas gives the host element its bounds through CSS, not through a pane
 * layout call.
 */
export class ReviewFilesDiffView extends Disposable {
  private readonly _onDidChangeActiveControl = this._register(
    new Emitter<void>(),
  );
  readonly onDidChangeActiveControl = this._onDidChangeActiveControl.event;

  private readonly root: HTMLElement;
  private readonly splitView: SplitView<number>;
  private readonly changedFilesTree: ReviewChangedFilesTree;
  private readonly widget: MultiDiffEditorWidget;
  private viewModel: MultiDiffEditorViewModel | undefined;
  private input: ReviewFilesEditorInput | undefined;
  private inlineCommentOpen = false;

  constructor(
    private readonly container: HTMLElement,
    overflowWidgetsDomNode: HTMLElement | undefined,
    @IInstantiationService
    private readonly reviewInstantiationService: IInstantiationService,
    @ITextResourceConfigurationService
    private readonly textResourceConfigurationService: ITextResourceConfigurationService,
    @IEditorService private readonly editorService: IEditorService,
    @IEditorGroupsService
    private readonly editorGroupService: IEditorGroupsService,
  ) {
    super();
    this.root = append(container, $(".review-files-editor"));
    const fileTree = append(this.root, $(".review-files-editor-tree"));
    const diffContainer = append(this.root, $(".review-files-editor-diffs"));

    this.widget = this._register(
      this.reviewInstantiationService.createInstance(
        MultiDiffEditorWidget,
        diffContainer,
        this.reviewInstantiationService.createInstance(
          ReviewMultiDiffUIElementFactory,
          () =>
            this.input
              ? this.input.entries.map((entry) => ({
                  original: entry.original,
                  modified: entry.modified,
                  additions: entry.file.additions,
                  deletions: entry.file.deletions,
                  onDidOpen: () => {
                    void this.editorService.openEditor(
                      {
                        resource: entry.goToFileResource,
                        options: { pinned: true, revealIfVisible: true },
                      },
                      this.editorGroupService.mainPart.activeGroup,
                    );
                  },
                }))
              : [],
          "auto",
          // Hover and definition widgets must escape the canvas root, whose
          // container-query containment clips position: fixed descendants.
          overflowWidgetsDomNode,
          undefined,
          false,
          undefined,
        ),
        undefined,
      ),
    );
    this._register(
      this.widget.onDidChangeActiveControl(() =>
        this._onDidChangeActiveControl.fire(),
      ),
    );
    this._register(
      this.widget.onDidChangeActiveItem(() =>
        this.syncFileSelectionFromWidget(),
      ),
    );
    const commentObserver = new MutationObserver(() => {
      const inlineCommentOpen = Boolean(
        diffContainer.querySelector(OPEN_INLINE_COMMENT_SELECTOR),
      );
      if (this.inlineCommentOpen === inlineCommentOpen) return;
      this.inlineCommentOpen = inlineCommentOpen;
      this.layout();
    });
    commentObserver.observe(diffContainer, {
      attributes: true,
      attributeFilter: ["class"],
      childList: true,
      subtree: true,
    });
    this._register(toDisposable(() => commentObserver.disconnect()));

    this.changedFilesTree = this._register(
      this.reviewInstantiationService.createInstance(
        ReviewChangedFilesTree,
        fileTree,
      ),
    );
    this._register(
      this.changedFilesTree.onDidOpenFile((file) => {
        const element = this.input?.entries.find(
          (entry) => entry.file.path === file.path,
        );
        if (!element) return;
        this.reveal({
          original: element.original,
          modified: element.modified,
        });
      }),
    );
    this.splitView = this._register(
      new SplitView<number>(this.root, {
        orientation: Orientation.HORIZONTAL,
        proportionalLayout: true,
      }),
    );
    this.splitView.addView(
      {
        element: fileTree,
        layout: (width, _offset, height) => {
          fileTree.style.width = `${width}px`;
          this.changedFilesTree.layout(height ?? 0, width);
        },
        maximumSize: 380,
        minimumSize: FILE_TREE_MINIMUM_WIDTH,
        onDidChange: Event.None,
      },
      260,
    );
    this.splitView.addView(
      {
        element: diffContainer,
        layout: (width, _offset, height) => {
          diffContainer.style.width = `${width}px`;
          this.widget.layout(new Dimension(width, height ?? 0));
        },
        maximumSize: Number.POSITIVE_INFINITY,
        minimumSize: DIFF_MINIMUM_WIDTH,
        onDidChange: Event.None,
      },
      740,
    );

    const sizeObserver = this._register(
      new ElementSizeObserver(this.container, undefined),
    );
    this._register(sizeObserver.onDidChange(() => this.layout()));
    sizeObserver.startObserving();
    this.layout();
    // Registered last so it runs last: the widgets above tear their own DOM
    // down, and they must do that while the tree is still attached.
    this._register(toDisposable(() => this.root.remove()));
  }

  async setInput(
    input: ReviewFilesEditorInput,
    viewState: IMultiDiffEditorViewState | undefined,
  ): Promise<void> {
    this.input = input;
    const viewModel = await input.getViewModel();
    if (this._store.isDisposed) return;
    this.viewModel = viewModel;
    // The canvas mounts this view without a user gesture, so the widget's
    // first-change navigation must never take keyboard focus.
    this.widget.setViewModel(viewModel, { preserveFocus: true, viewState });
    this.changedFilesTree.setFiles(input.entries.map((entry) => entry.file));
    this.syncFileSelectionFromWidget();
  }

  getViewState(): IMultiDiffEditorViewState | undefined {
    return this.viewModel ? this.widget.getViewState() : undefined;
  }

  getActiveControl(): IDiffEditor | undefined {
    return this.widget.getActiveControl();
  }

  toggleRenderSideBySide(): void {
    const resource = this.widget.getActiveItem()?.modified;
    if (!resource) return;
    const key = "diffEditor.renderSideBySide";
    const current =
      this.textResourceConfigurationService.getValue<boolean>(resource, key) ??
      true;
    void this.textResourceConfigurationService.updateValue(
      resource,
      key,
      !current,
    );
  }

  focus(): void {
    this.widget.getActiveControl()?.focus();
  }

  layout(): void {
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    if (width <= 0 || height <= 0) return;

    const availableWidth =
      width - (this.inlineCommentOpen ? INLINE_COMMENT_WIDTH_RESERVE : 0);
    const fileTreeVisible = availableWidth >= FILE_TREE_COLLAPSE_WIDTH;
    if (this.splitView.isViewVisible(0) !== fileTreeVisible) {
      this.splitView.setViewVisible(0, fileTreeVisible);
    }

    this.splitView.layout(width, height);
  }
  private reveal(resource: {
    original: URI | undefined;
    modified: URI | undefined;
  }): void {
    this.widget.reveal(resource, { highlight: true });
  }

  private syncFileSelectionFromWidget(): void {
    const resource = this.widget.getActiveItem();
    const input = this.input;
    if (!resource || !input) return;
    const index = input.entries.findIndex(
      (entry) =>
        sameResource(entry.original, resource.original) &&
        sameResource(entry.modified, resource.modified),
    );
    if (index === -1) return;
    this.changedFilesTree.setActiveFile(input.entries[index].file.path);
  }
}
function sameResource(left: URI | undefined, right: URI | undefined): boolean {
  return left === undefined ? right === undefined : !!right && isEqual(left, right);
}
