import { Disposable } from "../../base/common/lifecycle.js";
import { createDecorator } from "../../platform/instantiation/common/instantiation.js";
import { INotificationService } from "../../platform/notification/common/notification.js";
import { ITerminalEditorService, ITerminalService, type ITerminalInstance } from "../../workbench/contrib/terminal/browser/terminal.js";
import { editorGroupToColumn } from "../../workbench/services/editor/common/editorGroupColumn.js";
import { GroupDirection, IEditorGroupsService, type IEditorGroup } from "../../workbench/services/editor/common/editorGroupsService.js";
import type { ReviewVerbRequest } from "../common/reviewProtocol.js";

export type HostQuestionTerminalRequest = Extract<ReviewVerbRequest, { name: "openHostQuestionTerminal" }>["args"];
export const IReviewHostQuestionTerminalService = createDecorator<IReviewHostQuestionTerminalService>("reviewHostQuestionTerminalService");
export interface IReviewHostQuestionTerminalService {
  readonly _serviceBrand: undefined;
  open(input: HostQuestionTerminalRequest): Promise<void>;
  reveal(reviewId: string, runId: string): Promise<void>;
}

/** Launches host-prepared commands without depending on a legacy review session. */
export class ReviewHostQuestionTerminalService extends Disposable implements IReviewHostQuestionTerminalService {
  declare readonly _serviceBrand: undefined;
  private readonly runs = new Map<string, Promise<ITerminalInstance>>();
  private readonly reviewIds = new Map<string, string>();
  private questionGroupId: number | undefined;

  constructor(
    @ITerminalService private readonly terminals: ITerminalService,
    @ITerminalEditorService private readonly editors: ITerminalEditorService,
    @IEditorGroupsService private readonly editorGroups: IEditorGroupsService,
    @INotificationService private readonly notifications: INotificationService,
  ) { super(); }

  private questionGroup(reviewId: string): IEditorGroup {
    const existing = this.questionGroupId === undefined ? undefined : this.editorGroups.getGroup(this.questionGroupId);
    if (existing) return existing;
    const reviewGroup = this.editorGroups.groups.find(group => group.editors.some(editor => {
      const resource = editor.resource;
      return resource?.scheme === "devfast-review-canvas" && resource.authority === "host-review" && resource.path === `/${reviewId}`;
    }));
    const group = this.editorGroups.addGroup(reviewGroup ?? this.editorGroups.mainPart.activeGroup, GroupDirection.RIGHT);
    this.questionGroupId = group.id;
    return group;
  }

  async open(input: HostQuestionTerminalRequest): Promise<void> {
    let pending = this.runs.get(input.runId);
    if (!pending) {
      const group = this.questionGroup(input.reviewId);
      pending = this.terminals.createTerminal({
        config: {
          executable: input.command.executable, args: input.command.args,
          cwd: input.command.cwd, env: { ...input.command.env, CLICOLOR: "1", CLICOLOR_FORCE: "1", COLORTERM: "truecolor", FORCE_COLOR: "3", NO_COLOR: null, TERM: "xterm-256color" },
          isTransient: true, useShellEnvironment: true,
          name: `${input.session.harness} · Question ${input.questionId.slice(0, 8)}`,
        },
        // Terminal creation converts grid columns to groups; openEditor takes IDs.
        location: { viewColumn: editorGroupToColumn(this.editorGroups, group) },
      });
      this.runs.set(input.runId, pending);
      this.reviewIds.set(input.runId, input.reviewId);
      const created = pending;
      void created.then(instance => {
        this._register(instance.onDisposed(() => { if (this.runs.get(input.runId) === created) { this.runs.delete(input.runId); this.reviewIds.delete(input.runId); } }));
      }, () => { if (this.runs.get(input.runId) === created) { this.runs.delete(input.runId); this.reviewIds.delete(input.runId); } });
    }
    const instance = await pending;
    await this.editors.openEditor(instance, { viewColumn: this.questionGroup(input.reviewId).id });
    this.terminals.setActiveInstance(instance);
    await instance.focusWhenReady(true);
  }

  /** Reveals a live host-started terminal; never reconstructs launch commands in the client. */
  async reveal(reviewId: string, runId: string): Promise<void> {
    try {
      const pending = this.reviewIds.get(runId) === reviewId ? this.runs.get(runId) : undefined;
      const instance = pending ? await pending : undefined;
      if (!instance || instance.isDisposed) throw new Error("This question's terminal is no longer open. Start a new Ask to continue the discussion.");
      await this.editors.openEditor(instance, { viewColumn: this.questionGroup(reviewId).id });
      this.terminals.setActiveInstance(instance);
      await instance.focusWhenReady(true);
    } catch (error) {
      this.notifications.error(error instanceof Error ? error.message : String(error));
      throw error;
    }
  }
}
