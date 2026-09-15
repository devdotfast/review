/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IOpenerService } from "../../../platform/opener/common/opener.js";
import { encodeBase64 } from "../../../base/common/buffer.js";
import { Emitter, Event } from "../../../base/common/event.js";
import { Disposable, DisposableStore } from "../../../base/common/lifecycle.js";
import {
  type ICodeEditor,
  isCodeEditor,
  isDiffEditor,
} from "../../../editor/browser/editorBrowser.js";
import { ICodeEditorService } from "../../../editor/browser/services/codeEditorService.js";
import { Range } from "../../../editor/common/core/range.js";
import type { IEditorDecorationsCollection } from "../../../editor/common/editorCommon.js";
import {
  createDecorator,
} from "../../../platform/instantiation/common/instantiation.js";
import type { IEditorPane } from "../../../workbench/common/editor.js";
import { IEditorGroupsService } from "../../../workbench/services/editor/common/editorGroupsService.js";
import { IEditorService } from "../../../workbench/services/editor/common/editorService.js";
import {
  IWorkbenchLayoutService,
  Parts,
} from "../../../workbench/services/layout/browser/layoutService.js";
import { IHostService } from "../../../workbench/services/host/browser/host.js";
import {
  type ReviewDesktopState,
  type ReviewDiffSide,
  type JsonValue,
  type ReviewOpenEditorWire,
  type ReviewSurfaceEvent,
  type ReviewVerbResponse,
  type ReviewView,
  parseReviewVerbRequest,
  REVIEW_DISCORD_URL,
} from "../../common/reviewProtocol.js";
import { reviewSelectionRange } from "../../common/reviewSelection.js";
import {
  IReviewCodeResourceService,
  reviewResourceIdentity,
} from "../../services/reviewCodeResourceService.js";
import { IReviewCanvasEditorTabsService } from "../../services/reviewCanvasEditorTabsService.js";
import {
  IReviewSessionModelService,
  type ReviewDesktopSession,
} from "../../services/reviewSessionModelService.js";
import { IReviewSessionService } from "../../services/reviewSessionService.js";
import { IReviewDiffTabsService } from "../../services/reviewDiffTabs.js";
import { ReviewCanvasEditorInput } from "../../browser/parts/canvas/reviewCanvasEditorInput.js";
import { IReviewExplorerPartsService } from "../../browser/parts/explorer/reviewExplorerPart.js";

export const IReviewVerbsService =
  createDecorator<IReviewVerbsService>("reviewVerbsService");

export interface IReviewVerbsService {
  readonly _serviceBrand: undefined;
  readonly onDidEmitSurfaceEvent: Event<ReviewSurfaceEvent>;
  readonly onDidRequestCanvasFocus: Event<void>;
  dispatch(sessionId: string, value: JsonValue): Promise<ReviewVerbResponse>;
  state(): ReviewDesktopState;
  resetSession(): Promise<void>;
}

export class ReviewVerbsService
  extends Disposable
  implements IReviewVerbsService
{
  declare readonly _serviceBrand: undefined;

  private readonly _onDidEmitSurfaceEvent = this._register(
    new Emitter<ReviewSurfaceEvent>(),
  );
  readonly onDidEmitSurfaceEvent = this._onDidEmitSurfaceEvent.event;
  private readonly _onDidRequestCanvasFocus = this._register(
    new Emitter<void>(),
  );
  readonly onDidRequestCanvasFocus = this._onDidRequestCanvasFocus.event;

  private readonly editorStores = new Map<string, DisposableStore>();
  private revealDecoration: IEditorDecorationsCollection | undefined;

  constructor(
    @IEditorService private readonly editorService: IEditorService,
    @IEditorGroupsService
    private readonly editorGroupsService: IEditorGroupsService,
    @IWorkbenchLayoutService
    private readonly layoutService: IWorkbenchLayoutService,
    @ICodeEditorService private readonly codeEditorService: ICodeEditorService,
    @IReviewCodeResourceService
    private readonly codeResources: IReviewCodeResourceService,
    @IReviewSessionModelService
    private readonly sessionModelService: IReviewSessionModelService,
    @IReviewSessionService
    private readonly sessionService: IReviewSessionService,
    @IReviewDiffTabsService
    private readonly reviewDiffTabsService: IReviewDiffTabsService,
    @IReviewCanvasEditorTabsService
    private readonly tabsService: IReviewCanvasEditorTabsService,
    @IReviewExplorerPartsService
    private readonly explorerParts: IReviewExplorerPartsService,
    @IHostService private readonly hostService: IHostService,
    @IOpenerService private readonly openerService: IOpenerService,
  ) {
    super();
    for (const editor of codeEditorService.listCodeEditors())
      this.trackEditor(editor);
    this._register(
      codeEditorService.onCodeEditorAdd((editor) => this.trackEditor(editor)),
    );
    this._register(
      codeEditorService.onCodeEditorRemove((editor) =>
        this.untrackEditor(editor),
      ),
    );
  }

  async dispatch(
    sessionId: string,
    value: JsonValue,
  ): Promise<ReviewVerbResponse> {
    try {
      const request = parseReviewVerbRequest(value);
      switch (request.name) {
        case "joinDiscord":
          await this.openerService.open(REVIEW_DISCORD_URL, { openExternal: true });
          break;
        case "openFile":
          await this.openFile(request.args);
          break;
        case "showReviewView":
          await this.showReviewView(request.args.view);
          break;
        case "openSourceTree":
          // Bind the tab to the active review so a later re-activation can
          // re-acquire the session after Home clears the active model.
          await this.tabsService.openSource(
            true,
            this.sessionModelService.activeModel?.session.review.uuid,
          );
          this.explorerParts.show();
          break;
        case "openDiff":
          await this.openDiff(request.args.path, request.args.previousPath);
          break;
        case "reveal":
          await this.revealCode(request.args);
          break;
        case "focusCanvas":
          this._onDidRequestCanvasFocus.fire();
          break;
        case "captureScreenshot":
          return { ok: true, result: await this.captureScreenshot() };
        case "openReviewRevision": {
          const descriptor = this.sessionService.sessions.find(
            (candidate) => candidate.sessionId === sessionId,
          );
          if (!descriptor) {
            throw new Error("Unknown review session for openReviewRevision.");
          }
          if (request.args.revision) {
            await this.tabsService.openReviewRevision(
              descriptor.reviewUuid,
              request.args.revision,
              request.args.sealedAt,
              true,
            );
          } else {
            await this.tabsService.openReview(descriptor.reviewUuid, true);
          }
          break;
        }
        case "openReview":
          await this.tabsService.openReview(
            request.args.reviewUuid,
            request.args.active,
          );
          break;
        case "state":
          return { ok: true, result: this.state() };
      }
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async captureScreenshot(): Promise<
    { dataUrl: string } | undefined
  > {
    try {
      const screenshot = await this.hostService.getScreenshot();
      if (!screenshot) return undefined;
      return {
        dataUrl: `data:image/jpeg;base64,${encodeBase64(screenshot)}`,
      };
    } catch {
      return undefined;
    }
  }

  state(): ReviewDesktopState {
    const session = this.requireSession();
    const openEditors = this.codeEditorService
      .listCodeEditors()
      .map((editor) => this.editorIdentity(editor, session))
      .filter((value): value is ReviewOpenEditorWire => value !== null);
    const active = this.codeEditorService.getActiveCodeEditor();
    const activeEditor = active ? this.editorIdentity(active, session) : null;
    const selection = active?.getSelection();
    return {
      openEditors,
      activeEditor,
      selection:
        activeEditor && selection
          ? {
              path: activeEditor.path,
              startLine: selection.startLineNumber,
              startColumn: selection.startColumn,
              endLine: selection.endLineNumber,
              endColumn: selection.endColumn,
            }
          : null,
    };
  }

  async resetSession(): Promise<void> {
    this.clearRevealDecoration();
    await Promise.all(
      this.editorGroupsService.parts.flatMap((part) =>
        part.groups.map((group) =>
          group.closeEditors(
            group.editors.filter(
              (editor) => !(editor instanceof ReviewCanvasEditorInput),
            ),
          ),
        ),
      ),
    );
  }

  private async openFile(args: {
    path: string;
    line?: number;
    column?: number;
    endLine?: number;
    preserveFocus?: boolean;
  }): Promise<void> {
    const pane = await this.openFileEditor(args);
    if (!pane) throw new Error(`Unable to open review file: ${args.path}`);
    this.emitEditorState();
  }

  private async openFileEditor(args: {
    path: string;
    line?: number;
    column?: number;
    endLine?: number;
    preserveFocus?: boolean;
  }): Promise<IEditorPane | undefined> {
    this.requireSession();
    this.layoutService.setPartHidden(false, Parts.EDITOR_PART);
    const resource = (await this.codeResources.target(args.path, "head"))
      .resource;
    return this.editorService.openEditor(
      {
        resource,
        options: {
          pinned: true,
          preserveFocus: args.preserveFocus,
          revealIfVisible: true,
          selection:
            args.line === undefined
              ? undefined
              : {
                  startLineNumber: args.line,
                  startColumn: args.column ?? 1,
                  endLineNumber: args.endLine ?? args.line,
                  endColumn: Number.MAX_SAFE_INTEGER,
                },
        },
      },
      this.editorGroupsService.mainPart.activeGroup,
    );
  }

  private async openDiff(
    filePath: string,
    previousPath?: string,
  ): Promise<void> {
    const pane = await this.openDiffEditor({ filePath, previousPath });
    if (!pane) throw new Error(`Unable to open review diff: ${filePath}`);
    this.emitEditorState();
  }

  /**
   * The dispatcher reveals the Review tab before asking the app to show a view.
   */
  private async showReviewView(view: ReviewView): Promise<void> {
    this.requireSession();
    this._onDidRequestCanvasFocus.fire();
    this._onDidEmitSurfaceEvent.fire({ event: "showReviewView", view });
  }

  private async openDiffEditor(args: {
    filePath: string;
    previousPath?: string;
    selection?: Range;
    preserveFocus?: boolean;
  }): Promise<IEditorPane | undefined> {
    return this.reviewDiffTabsService.open(args);
  }

  private async revealCode(args: {
    path: string;
    startLine: number;
    endLine: number;
    side?: ReviewDiffSide;
    highlight?: boolean;
    preserveFocus?: boolean;
  }): Promise<void> {
    const side = args.side ?? "head";
    const preserveFocus = args.preserveFocus ?? true;
    this.clearRevealDecoration();
    const range = new Range(
      args.startLine,
      1,
      args.endLine,
      Number.MAX_SAFE_INTEGER,
    );
    const diffFile = (await this.codeResources.target(args.path, side))
      .diffFile;

    let pane: IEditorPane | undefined;
    let targetEditor: ICodeEditor;
    if (diffFile) {
      pane = await this.openDiffEditor({
        filePath: diffFile.path,
        previousPath: diffFile.previousPath,
        selection: side === "head" ? range : undefined,
        preserveFocus,
      });
      const control = pane?.getControl();
      if (!pane || !isDiffEditor(control)) {
        throw new Error(`Unable to open review diff: ${diffFile.path}`);
      }
      targetEditor =
        side === "base"
          ? control.getOriginalEditor()
          : control.getModifiedEditor();
    } else {
      pane = await this.openFileEditor({
        path: args.path,
        line: args.startLine,
        endLine: args.endLine,
        preserveFocus,
      });
      const control = pane?.getControl();
      if (!pane || !isCodeEditor(control)) {
        throw new Error(`Unable to open review file: ${args.path}`);
      }
      targetEditor = control;
    }

    targetEditor.setSelection(range);
    targetEditor.revealRangeInCenter(range);
    if (!preserveFocus) targetEditor.focus();
    if (args.highlight === true) {
      this.revealDecoration = targetEditor.createDecorationsCollection([
        {
          range,
          options: {
            description: "Review reveal range",
            isWholeLine: true,
            className: "review-reveal-line",
          },
        },
      ]);
    }
    this.emitEditorState(targetEditor);
  }

  private clearRevealDecoration(): void {
    this.revealDecoration?.clear();
    this.revealDecoration = undefined;
  }

  private trackEditor(editor: ICodeEditor): void {
    if (editor.isSimpleWidget) return;
    const id = editor.getId();
    if (this.editorStores.has(id)) return;
    const store = new DisposableStore();
    store.add(editor.onDidFocusEditorText(() => this.emitEditorState(editor)));
    store.add(
      editor.onDidChangeCursorSelection(() => this.emitEditorState(editor)),
    );
    this.editorStores.set(id, store);
    this._register(store);
  }

  private untrackEditor(editor: ICodeEditor): void {
    this.editorStores.get(editor.getId())?.dispose();
    this.editorStores.delete(editor.getId());
  }

  private emitEditorState(
    editor = this.codeEditorService.getActiveCodeEditor(),
  ): void {
    const session = this.sessionModelService.activeModel?.session;
    const identity =
      editor && session ? this.editorIdentity(editor, session) : null;
    this._onDidEmitSurfaceEvent.fire({
      event: "activeEditorChanged",
      path: identity?.path ?? null,
    });
    const selection = editor?.getSelection();
    if (identity && selection) {
      this._onDidEmitSurfaceEvent.fire({
        event: "editorSelectionChanged",
        path: identity.path,
        range: reviewSelectionRange(
          selection.getStartPosition(),
          selection.getEndPosition(),
        ),
      });
    }
  }

  private editorIdentity(
    editor: ICodeEditor,
    session: ReviewDesktopSession,
  ): ReviewOpenEditorWire | null {
    if (editor.isSimpleWidget) return null;
    const uri = editor.getModel()?.uri;
    return uri ? reviewResourceIdentity(session, uri) : null;
  }

  private requireSession(): ReviewDesktopSession {
    const session = this.sessionModelService.activeModel?.session;
    if (!session) throw new Error("No active Review Desktop session.");
    return session;
  }
}
