import { Disposable } from "../../base/common/lifecycle.js";
import { createDecorator } from "../../platform/instantiation/common/instantiation.js";
import { ITerminalEditorService, ITerminalService, type ITerminalInstance } from "../../workbench/contrib/terminal/browser/terminal.js";
import { editorGroupToColumn } from "../../workbench/services/editor/common/editorGroupColumn.js";
import { GroupDirection, IEditorGroupsService, type IEditorGroup } from "../../workbench/services/editor/common/editorGroupsService.js";
import type { ReviewVerbRequest } from "../common/reviewProtocol.js";

export type HostQuestionTerminalRequest = Extract<ReviewVerbRequest, { name: "openHostQuestionTerminal" }>["args"];
export const IReviewHostQuestionTerminalService = createDecorator<IReviewHostQuestionTerminalService>("reviewHostQuestionTerminalService");
export interface IReviewHostQuestionTerminalService {
  readonly _serviceBrand: undefined;
  open(input: HostQuestionTerminalRequest): Promise<void>;
}

/** Launches host-prepared commands without depending on a legacy review session. */
export class ReviewHostQuestionTerminalService extends Disposable implements IReviewHostQuestionTerminalService {
  declare readonly _serviceBrand: undefined;
  private readonly runs = new Map<string, Promise<ITerminalInstance>>();
  private questionGroupId: number | undefined;

  constructor(
    @ITerminalService private readonly terminals: ITerminalService,
    @ITerminalEditorService private readonly editors: ITerminalEditorService,
    @IEditorGroupsService private readonly editorGroups: IEditorGroupsService,
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
      const created = pending;
      void created.then(instance => {
        this._register(instance.onDisposed(() => { if (this.runs.get(input.runId) === created) this.runs.delete(input.runId); }));
      }, () => { if (this.runs.get(input.runId) === created) this.runs.delete(input.runId); });
    }
    const instance = await pending;
    await this.editors.openEditor(instance, { viewColumn: this.questionGroup(input.reviewId).id });
    this.terminals.setActiveInstance(instance);
    await instance.focusWhenReady(true);
  }
}
