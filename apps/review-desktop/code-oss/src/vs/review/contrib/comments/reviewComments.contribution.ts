/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from "../../../base/common/cancellation.js";
import { Codicon } from "../../../base/common/codicons.js";
import { Emitter } from "../../../base/common/event.js";
import {
  Disposable,
  MutableDisposable,
} from "../../../base/common/lifecycle.js";
import { extUri } from "../../../base/common/resources.js";
import { generateUuid } from "../../../base/common/uuid.js";
import { URI, type UriComponents } from "../../../base/common/uri.js";
import { Range, type IRange } from "../../../editor/common/core/range.js";
import {
  CommentMode,
  CommentState,
  CommentThreadApplicability,
  CommentThreadCollapsibleState,
  CommentThreadState,
  type Comment,
  type CommentInput,
  type CommentReaction,
  type CommentThread,
} from "../../../editor/common/languages.js";
import { localize } from "../../../nls.js";
import {
  Action2,
  MenuId,
  MenuRegistry,
  registerAction2,
} from "../../../platform/actions/common/actions.js";
import {
  ContextKeyExpr,
  IContextKeyService,
  RawContextKey,
  type IContextKey,
} from "../../../platform/contextkey/common/contextkey.js";
import type { ServicesAccessor } from "../../../platform/instantiation/common/instantiation.js";
import { INotificationService } from "../../../platform/notification/common/notification.js";
import {
  type ICommentController,
  type ICommentInfo,
  ICommentService,
  type INotebookCommentInfo,
} from "../../../workbench/contrib/comments/browser/commentService.js";
import {
  type IWorkbenchContribution,
  registerWorkbenchContribution2,
  WorkbenchPhase,
} from "../../../workbench/common/contributions.js";
import {
  REVIEW_BASE_SCHEME,
  REVIEW_HEAD_SCHEME,
  REVIEW_UNIFIED_SCHEME,
} from "../../common/reviewCodeResources.js";
import {
  createGitLabTextDiffPosition,
  gitLabDiffPositionRows,
  type CodeThreadTarget,
  type ReviewCommentAgentActivity,
  type ReviewCommentStoreBridge,
  type ReviewCommentStoreSnapshot,
  type ReviewCommentThreadRecord,
  type ReviewDiffFileWire,
} from "../../common/reviewProtocol.js";
import {
  IReviewCodeResourceService,
} from "../../services/reviewCodeResourceService.js";
import {
  IReviewSessionModelService,
  type ReviewSessionModel,
} from "../../services/reviewSessionModelService.js";
import { IReviewSessionService } from "../../services/reviewSessionService.js";

const REVIEW_COMMENT_OWNER = "devfast.review.comments";
const REVIEW_COMMENT_CONTROLLER = "devfastReviewComments";
const REVIEW_COMMENT_SUBMIT_MENU = new MenuId(
  "devfast.review.comments.submitMenu",
);
const ASK_NOW_COMMAND = "devfast.review.comments.askNow";
const ADD_TO_REVIEW_COMMAND = "devfast.review.comments.addToReview";
const EDIT_COMMENT_COMMAND = "devfast.review.comments.edit";
const SAVE_COMMENT_COMMAND = "devfast.review.comments.save";
const CANCEL_EDIT_COMMAND = "devfast.review.comments.cancelEdit";
const DELETE_COMMENT_COMMAND = "devfast.review.comments.deleteMessage";
const RESOLVE_THREAD_COMMAND = "devfast.review.comments.resolve";
const UNRESOLVE_THREAD_COMMAND = "devfast.review.comments.unresolve";
const DELETE_THREAD_COMMAND = "devfast.review.comments.deleteThread";
const REVIEW_COMMENT_MESSAGE = "devfastReviewCommentMessage";
const REVIEW_COMMENT_AGENT_ACTIVITY = "devfastReviewCommentAgentActivity";
const REVIEW_COMMENT_MESSAGE_EDITING = "devfastReviewCommentMessageEditing";
const REVIEW_COMMENT_THREAD_DRAFT = "devfastReviewCommentThreadDraft";
const REVIEW_COMMENT_THREAD_OPEN = "devfastReviewCommentThreadOpen";
const REVIEW_COMMENT_THREAD_RESOLVED = "devfastReviewCommentThreadResolved";
/* False while the tutorial Review is bound. The tutorial replaces the corner
   control with Close and lives outside the review store, so a batched comment
   has nothing to submit to. "Ask now" answers in the thread and needs no
   originating agent session, so it is the whole verb set there. */
const ReviewCanAddToReviewContext = new RawContextKey<boolean>(
  "devfastReviewCanAddToReview",
  true,
);

interface ReviewCommentReplyContext {
  readonly thread: CommentThread;
  readonly text: string;
}

interface ReviewCommentNodeContext {
  readonly thread: CommentThread;
  readonly commentUniqueId: number;
  readonly text?: string;
}

interface ReviewCodeResourceIdentity {
  readonly path: string;
  readonly side: "base" | "head";
}

interface BaseThreadProjection {
  readonly threadId: string;
  readonly target: CodeThreadTarget;
  readonly resource: URI;
  readonly range: IRange | undefined;
  readonly label?: string;
  readonly outdated: boolean;
}

interface CommentThreadProjection extends BaseThreadProjection {
  readonly record: ReviewCommentThreadRecord;
  readonly draft: boolean;
  readonly agentActivity: ReviewCommentAgentActivity | undefined;
}

type ThreadProjection = CommentThreadProjection;

function resourceProjectionKey(threadId: string, resource: URI | string): string {
  const resourceValue =
    typeof resource === "string" ? resource : resource.toString();
  return `${threadId}\u0000${resourceValue}`;
}

function codeRangeLabel(target: CodeThreadTarget, draft = false): string {
  const draftLabel = draft ? "Draft \u00b7 " : "";
  const rows = gitLabDiffPositionRows(target.position);
  if (!rows) return `${draftLabel}Code`;
  const headStart = rows.start.new_line;
  const headEnd = rows.end.new_line;
  if (headStart !== null && headEnd !== null) {
    const lines =
      headStart === headEnd ? `L${headStart}` : `L${headStart}\u2013${headEnd}`;
    return `${draftLabel}${lines} \u00b7 head`;
  }
  const baseStart = rows.start.old_line;
  const baseEnd = rows.end.old_line;
  if (baseStart !== null && baseEnd !== null) {
    const lines =
      baseStart === baseEnd ? `L${baseStart}` : `L${baseStart}\u2013${baseEnd}`;
    return `${draftLabel}${lines} \u00b7 base`;
  }
  const startLine = headStart ?? baseStart;
  const endLine = headEnd ?? baseEnd;
  return startLine !== null && endLine !== null
    ? `${draftLabel}L${startLine}\u2192L${endLine} \u00b7 diff`
    : `${draftLabel}Code`;
}

function codeResourceRangeLabel(
  range: IRange,
  surface: "base" | "head" | "diff",
  draft = false,
): string {
  const lines =
    range.startLineNumber === range.endLineNumber
      ? `L${range.startLineNumber}`
      : `L${range.startLineNumber}\u2013${range.endLineNumber}`;
  const draftLabel = draft ? "Draft \u00b7 " : "";
  return `${draftLabel}${lines} \u00b7 ${surface}`;
}

function agentActivityLabel(activity: ReviewCommentAgentActivity): string {
  if (activity.status === "running") return "Running\u2026";
  return `Failed: ${"error" in activity ? activity.error : "Unknown error"}`;
}

class ReviewCommentThread implements CommentThread<IRange> {
  private readonly _onDidChangeComments = new Emitter<
    readonly Comment[] | undefined
  >();
  readonly onDidChangeComments = this._onDidChangeComments.event;
  private readonly _onDidChangeInput = new Emitter<CommentInput | undefined>();
  readonly onDidChangeInput = this._onDidChangeInput.event;
  private readonly _onDidChangeLabel = new Emitter<string | undefined>();
  readonly onDidChangeLabel = this._onDidChangeLabel.event;
  private readonly _onDidChangeCollapsibleState = new Emitter<
    CommentThreadCollapsibleState | undefined
  >();
  readonly onDidChangeCollapsibleState =
    this._onDidChangeCollapsibleState.event;
  private readonly _onDidChangeState = new Emitter<
    CommentThreadState | undefined
  >();
  readonly onDidChangeState = this._onDidChangeState.event;
  private readonly _onDidChangeCanReply = new Emitter<boolean>();
  readonly onDidChangeCanReply = this._onDidChangeCanReply.event;
  private readonly _onDidChangeInitialCollapsibleState = new Emitter<
    CommentThreadCollapsibleState | undefined
  >();
  readonly onDidChangeInitialCollapsibleState =
    this._onDidChangeInitialCollapsibleState.event;

  readonly controllerHandle = 1;
  readonly extensionId = undefined;
  contextValue = REVIEW_COMMENT_THREAD_OPEN;
  readonly initialCollapsibleState = CommentThreadCollapsibleState.Expanded;
  input: CommentInput | undefined;
  label: string | undefined;
  comments: readonly Comment[] | undefined;
  private _collapsibleState = CommentThreadCollapsibleState.Expanded;
  get collapsibleState(): CommentThreadCollapsibleState {
    return this._collapsibleState;
  }
  set collapsibleState(state: CommentThreadCollapsibleState) {
    if (state === this._collapsibleState) return;
    this._collapsibleState = state;
    this._onDidChangeCollapsibleState.fire(state);
  }
  state = CommentThreadState.Unresolved;
  applicability = CommentThreadApplicability.Current;
  canReply = false;
  isDisposed = false;
  isTemplate: boolean;
  editorId?: string;
  resource: string;
  range: IRange | undefined;
  private projection: ThreadProjection | undefined;
  private editingComment: number | undefined;

  constructor(
    readonly threadId: string,
    readonly commentThreadHandle: number,
    resource: URI,
    range: IRange,
    template: boolean,
    editorId?: string,
    label?: string,
  ) {
    this.resource = resource.toString();
    this.range = range;
    this.isTemplate = template;
    this.editorId = editorId;
    this.label = label;
    this.canReply = template;
    this.contextValue = template
      ? REVIEW_COMMENT_THREAD_DRAFT
      : REVIEW_COMMENT_THREAD_OPEN;
    this.comments = template ? [] : undefined;
  }

  isDocumentCommentThread(): this is CommentThread<IRange> {
    return true;
  }

  updateLabel(label: string): void {
    if (this.label === label) return;
    this.label = label;
    this._onDidChangeLabel.fire(label);
  }

  apply(projection: ThreadProjection): void {
    this.projection = projection;
    this.resource = projection.resource.toString();
    this.range = projection.range;
    this.isTemplate = false;
    this.editorId = undefined;
    this.canReply = projection.record.status !== "resolved";
    this.label =
      projection.label ?? codeRangeLabel(projection.target, projection.draft);
    this.state =
      projection.record.status === "resolved"
        ? CommentThreadState.Resolved
        : CommentThreadState.Unresolved;
    this.contextValue = projection.draft
      ? REVIEW_COMMENT_THREAD_DRAFT
      : projection.record.status === "resolved"
        ? REVIEW_COMMENT_THREAD_RESOLVED
        : REVIEW_COMMENT_THREAD_OPEN;
    this.applicability = projection.outdated
      ? CommentThreadApplicability.Outdated
      : CommentThreadApplicability.Current;
    this.renderComments();
    this._onDidChangeLabel.fire(this.label);
    this._onDidChangeState.fire(this.state);
    this._onDidChangeCanReply.fire(this.canReply);
  }

  editComment(uniqueId: number): void {
    if (
      !this.projection?.record.messages[uniqueId - 1]
    ) {
      return;
    }
    this.editingComment = uniqueId;
    this.renderComments();
  }

  cancelEdit(): void {
    if (this.editingComment === undefined) return;
    this.editingComment = undefined;
    this.renderComments();
  }

  finishEdit(): void {
    this.editingComment = undefined;
  }

  messageId(uniqueId: number): string | undefined {
    return this.projection?.record.messages[uniqueId - 1]?.id;
  }

  private renderComments(): void {
    const projection = this.projection;
    if (!projection) return;
    const comments: Comment[] = projection.record.messages.map((message, index) => {
      const uniqueIdInThread = index + 1;
      const editing = uniqueIdInThread === this.editingComment;
      return {
        uniqueIdInThread,
        body: message.body,
        userName: message.by,
        contextValue: editing
          ? REVIEW_COMMENT_MESSAGE_EDITING
          : REVIEW_COMMENT_MESSAGE,
        mode: editing ? CommentMode.Editing : CommentMode.Preview,
        state: projection.draft ? CommentState.Draft : CommentState.Published,
        timestamp: message.at,
      };
    });
    if (projection.agentActivity) {
      const activity = projection.agentActivity;
      comments.push({
        uniqueIdInThread: comments.length + 1,
        body: agentActivityLabel(activity),
        userName: "Agent",
        contextValue: REVIEW_COMMENT_AGENT_ACTIVITY,
        mode: CommentMode.Preview,
        state: CommentState.Draft,
        timestamp: activity.startedAt,
      });
    }
    this.comments = comments;
    this._onDidChangeComments.fire(this.comments);
  }

  dispose(): void {
    if (this.isDisposed) return;
    this.isDisposed = true;
    this._onDidChangeComments.dispose();
    this._onDidChangeInput.dispose();
    this._onDidChangeLabel.dispose();
    this._onDidChangeCollapsibleState.dispose();
    this._onDidChangeState.dispose();
    this._onDidChangeCanReply.dispose();
    this._onDidChangeInitialCollapsibleState.dispose();
  }
}

export class ReviewCommentController
  extends Disposable
  implements ICommentController
{
  readonly id = REVIEW_COMMENT_CONTROLLER;
  readonly label = localize("reviewCommentsLabel", "Review");
  readonly owner = REVIEW_COMMENT_OWNER;
  readonly contextValue = REVIEW_COMMENT_CONTROLLER;
  readonly features = {
    options: {
      prompt: localize("reviewCommentPrompt", "Reply\u2026"),
      placeHolder: localize(
        "reviewCommentPlaceholder",
        "Leave a comment on these lines\u2026",
      ),
      compactThreadWidget: true,
    },
  };
  readonly options = this.features.options;
  activeComment: { thread: CommentThread; comment?: Comment } | undefined;

  private readonly storeSubscription = this._register(
    new MutableDisposable<{ dispose(): void }>(),
  );
  private model: ReviewSessionModel | null = null;
  private commentStore: ReviewCommentStoreBridge | null = null;
  private threads = new Map<string, ReviewCommentThread>();
  private resourceThreads = new Map<string, ReviewCommentThread>();
  private projections = new Map<string, ThreadProjection>();
  private targets = new Map<string, CodeThreadTarget>();
  private commentingRangesModel: ReviewSessionModel | null | undefined;
  private commentingRangesState: string | undefined;
  private commentingRangesSessionId: string | undefined;
  private nextHandle = 1;
  private disposed = false;

  private readonly canAddToReview: IContextKey<boolean>;

  constructor(
    @ICommentService private readonly commentService: ICommentService,
    @IReviewSessionModelService
    private readonly sessionModelService: IReviewSessionModelService,
    @IReviewCodeResourceService
    private readonly codeResources: IReviewCodeResourceService,
    @IReviewSessionService
    private readonly sessionService: IReviewSessionService,
    @IContextKeyService contextKeyService: IContextKeyService,
  ) {
    super();
    this.canAddToReview =
      ReviewCanAddToReviewContext.bindTo(contextKeyService);
    this.commentService.registerCommentController(this.owner, this);
    this._register(
      this.commentService.onDidDeleteDataProvider((owner) => {
        if (!this.disposed && owner === undefined) {
          this.commentService.registerCommentController(this.owner, this);
          this.commentService.setWorkspaceComments(this.owner, [
            ...this.threads.values(),
          ]);
        }
      }),
    );
    this._register(
      this.sessionModelService.onDidChangeActiveModel((model) =>
        this.bindModel(model),
      ),
    );
    this.bindModel(this.sessionModelService.activeModel);
  }

  async createCommentThreadTemplate(
    resourceComponents: UriComponents,
    range: IRange | undefined,
    editorId?: string,
  ): Promise<void> {
    const resource = URI.revive(resourceComponents);
    const target = await this.targetForResource(resource, range);
    if (!target || !range) return;
    const threadId = generateUuid();
    const normalizedRange = wholeLineRange(range);
    const thread = new ReviewCommentThread(
      threadId,
      -1,
      resource,
      normalizedRange,
      true,
      editorId,
      codeRangeLabel(target),
    );
    this.threads.set(threadId, thread);
    this.resourceThreads.set(resourceProjectionKey(threadId, resource), thread);
    this.targets.set(threadId, target);
    this.commentService.updateComments(this.owner, {
      added: [thread],
      removed: [],
      changed: [],
      pending: [],
    });
  }

  async updateCommentThreadTemplate(
    threadHandle: number,
    range: IRange,
  ): Promise<void> {
    const thread = [...this.threads.values()].find(
      (candidate) =>
        candidate.isTemplate && candidate.commentThreadHandle === threadHandle,
    );
    if (!thread) return;
    thread.range = wholeLineRange(range);
    const resource = URI.parse(thread.resource);
    const target = await this.targetForResource(resource, range);
    if (target) {
      this.targets.set(thread.threadId, target);
      thread.updateLabel(codeRangeLabel(target));
    }
    this.commentService.updateComments(this.owner, {
      added: [],
      removed: [],
      changed: [thread],
      pending: [],
    });
  }

  deleteCommentThreadMain(threadId: string): void {
    const thread = this.threads.get(threadId);
    if (!thread?.isTemplate) return;
    this.threads.delete(threadId);
    this.resourceThreads.delete(
      resourceProjectionKey(threadId, thread.resource),
    );
    this.targets.delete(threadId);
    this.commentService.updateComments(this.owner, {
      added: [],
      removed: [thread],
      changed: [],
      pending: [],
    });
    thread.dispose();
  }

  async getDocumentComments(
    resource: URI,
    _token: CancellationToken,
  ): Promise<ICommentInfo<IRange>> {
    const unified = this.codeResources.unifiedResource(resource);
    const identity = this.resourceIdentity(resource);
    const surface = unified ? "diff" : identity?.side;
    const authorable = !!surface && this.model?.state === "active";
    const threads: ReviewCommentThread[] = [];
    for (const thread of this.threads.values()) {
      if (thread.isDisposed) continue;
      if (thread.isTemplate) {
        if (thread.resource === resource.toString()) threads.push(thread);
        continue;
      }
      const projection = this.projections.get(thread.threadId);
      if (!projection || projection.outdated) continue;
      const projectedRange = await this.codeResources.projectPosition(
        projection.target.position,
        resource,
      );
      const range = projectedRange
        ? new Range(
            projectedRange.startLine,
            1,
            projectedRange.endLine,
            Number.MAX_SAFE_INTEGER,
          )
        : undefined;
      if (!range || !surface) continue;
      threads.push(
        this.projectThread(
          projection,
          resource,
          range,
          codeResourceRangeLabel(range, surface, projection.draft),
        ),
      );
    }
    return {
      uniqueOwner: this.owner,
      label: this.label,
      threads,
      commentingRanges: {
        resource,
        ranges: authorable
          ? unified
            ? unified.commentingRanges.map(
                (range) => new Range(range.startLine, 1, range.endLine, 1),
              )
            : [new Range(1, 1, Number.MAX_SAFE_INTEGER, 1)]
          : [],
        fileComments: false,
      },
    };
  }

  async getNotebookComments(): Promise<INotebookCommentInfo> {
    return { uniqueOwner: this.owner, label: this.label, threads: [] };
  }

  async setActiveCommentAndThread(
    commentInfo: { thread: CommentThread; comment?: Comment } | undefined,
  ): Promise<void> {
    this.activeComment = commentInfo;
  }

  async toggleReaction(
    _uri: URI,
    _thread: CommentThread,
    _comment: Comment,
    _reaction: CommentReaction,
    _token: CancellationToken,
  ): Promise<void> {}

  async addToReview(context: ReviewCommentReplyContext): Promise<void> {
    const body = context.text.trim();
    if (!body) return;
    const model = this.model;
    const target = this.targets.get(context.thread.threadId);
    if (!model || model.state !== "active" || !target) {
      throw new Error("The active review no longer owns this comment.");
    }
    await model.comments.saveComment({
      threadId: context.thread.threadId,
      messageId: generateUuid(),
      target,
      body,
    });
  }

  askNow(context: ReviewCommentReplyContext): Promise<void> {
    const body = context.text.trim();
    if (!body) return Promise.resolve();
    const model = this.model;
    const target = this.targets.get(context.thread.threadId);
    if (!model || model.state !== "active" || !target) {
      throw new Error("The active review no longer owns this comment.");
    }
    return model.comments.askAgent({
      messageId: generateUuid(),
      threadId: context.thread.threadId,
      target,
      body,
    });
  }

  editComment(context: ReviewCommentNodeContext): void {
    (context.thread as ReviewCommentThread).editComment(
      context.commentUniqueId,
    );
  }

  cancelEdit(context: ReviewCommentNodeContext): void {
    (context.thread as ReviewCommentThread).cancelEdit();
  }

  async saveEdit(context: ReviewCommentNodeContext): Promise<void> {
    const body = context.text?.trim();
    if (!body) return;
    const thread = context.thread as ReviewCommentThread;
    const messageId = thread.messageId(context.commentUniqueId);
    if (!messageId || !this.model) return;
    thread.finishEdit();
    await this.model.comments.updateComment(thread.threadId, body, messageId);
  }

  async deleteMessage(context: ReviewCommentNodeContext): Promise<void> {
    const thread = context.thread as ReviewCommentThread;
    const messageId = thread.messageId(context.commentUniqueId);
    if (!messageId || !this.model) return;
    await this.model.comments.deleteCommentMessage(thread.threadId, messageId);
  }

  async setResolved(thread: CommentThread, resolved: boolean): Promise<void> {
    if (!this.model || thread.isTemplate) return;
    await this.model.comments.setCommentResolved(thread.threadId, resolved);
  }

  async deleteThread(thread: CommentThread): Promise<void> {
    if (thread.isTemplate) {
      this.deleteCommentThreadMain(thread.threadId);
      return;
    }
    if (!this.model) return;
    await this.model.comments.deleteComment(thread.threadId);
  }

  override dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearThreads();
    this.commentService.unregisterCommentController(this.owner);
    super.dispose();
  }

  private bindModel(model: ReviewSessionModel | null): void {
    this.canAddToReview.set(
      model !== null &&
        model.reviewUuid !== this.sessionService.tutorialReview?.uuid,
    );
    const commentStore = model?.comments ?? null;
    if (this.model === model && this.commentStore === commentStore) {
      this.updateCommentingRanges();
      return;
    }
    this.clearThreads();
    this.model = model;
    this.commentStore = commentStore;
    this.storeSubscription.clear();
    if (!model || !commentStore) {
      this.updateCommentingRanges();
      return;
    }
    const unsubscribeComments = commentStore.subscribe((change) =>
      this.syncThreads(change.threadIds),
    );
    this.storeSubscription.value = {
      dispose: unsubscribeComments,
    };
    this.syncThreads();
    this.updateCommentingRanges();
  }

  private syncThreads(changedThreadIds?: ReadonlySet<string>): void {
    const model = this.model;
    if (!model) return;
    const snapshot = model.comments.getSnapshot();
    const projections = this.buildProjections(snapshot);
    const previous = this.threads;
    const next = new Map<string, ReviewCommentThread>();
    const nextProjections = new Map<string, ThreadProjection>();
    const nextTargets = new Map<string, CodeThreadTarget>();
    const removed: ReviewCommentThread[] = [];
    const changed: ReviewCommentThread[] = [];

    for (const projection of projections) {
      const threadId = projection.threadId;
      const prior = previous.get(threadId);
      if (prior && changedThreadIds && !changedThreadIds.has(threadId)) {
        next.set(threadId, prior);
        nextProjections.set(
          threadId,
          this.projections.get(threadId) ?? projection,
        );
        nextTargets.set(threadId, this.targets.get(threadId) ?? projection.target);
        continue;
      }
      const resourceProjections = [...this.resourceThreads.values()].filter(
        (thread) => thread.threadId === threadId,
      );
      const thread =
        prior && !resourceProjections.includes(prior)
          ? prior
          : new ReviewCommentThread(
              threadId,
              this.nextHandle++,
              projection.resource,
              projection.range ?? new Range(1, 1, 1, 1),
              false,
            );
      thread.apply(projection);
      for (const resourceThread of resourceProjections) {
        const projectedResource = URI.parse(resourceThread.resource);
        const projectedRange = resourceThread.range;
        const projectedIdentity = this.resourceIdentity(projectedResource);
        resourceThread.apply({
          ...projection,
          resource: projectedResource,
          range: projectedRange,
          label:
            projectedIdentity && projectedRange
              ? codeResourceRangeLabel(
                  projectedRange,
                  projectedIdentity.side,
                  projection.draft,
                )
              : undefined,
        });
        if (this.visibleInEditor(resourceThread)) changed.push(resourceThread);
      }
      next.set(threadId, thread);
      nextProjections.set(threadId, projection);
      nextTargets.set(threadId, projection.target);
    }

    for (const [threadId, thread] of previous) {
      if (next.has(threadId)) continue;
      if (thread.isTemplate) {
        next.set(threadId, thread);
        const target = this.targets.get(threadId);
        if (target) nextTargets.set(threadId, target);
        continue;
      }
    }

    for (const [key, thread] of this.resourceThreads) {
      if (next.has(thread.threadId)) continue;
      this.resourceThreads.delete(key);
      if (this.visibleInEditor(thread)) removed.push(thread);
      if (
        !previous.has(thread.threadId) ||
        previous.get(thread.threadId) !== thread
      ) {
        thread.dispose();
      }
    }

    this.threads = next;
    this.projections = nextProjections;
    this.targets = nextTargets;
    if (removed.length || changed.length) {
      this.commentService.updateComments(this.owner, {
        added: [],
        removed,
        changed,
        pending: [],
      });
    }
    this.commentService.setWorkspaceComments(
      this.owner,
      [...this.threads.values()].filter((thread) => !thread.isTemplate),
    );
    for (const thread of previous.values()) {
      if (!next.has(thread.threadId) || next.get(thread.threadId) !== thread) {
        if (![...this.resourceThreads.values()].includes(thread)) {
          thread.dispose();
        }
      }
    }
  }

  private updateCommentingRanges(): void {
    const model = this.model;
    const state = model?.state;
    const sessionId = model?.session.session.sessionId;
    if (
      this.commentingRangesModel === model &&
      this.commentingRangesState === state &&
      this.commentingRangesSessionId === sessionId
    ) {
      return;
    }
    this.commentingRangesModel = model;
    this.commentingRangesState = state;
    this.commentingRangesSessionId = sessionId;
    this.commentService.updateCommentingRanges(
      this.owner,
      model
        ? {
            schemes: [
              "file",
              REVIEW_BASE_SCHEME,
              REVIEW_HEAD_SCHEME,
              REVIEW_UNIFIED_SCHEME,
            ],
          }
        : undefined,
    );
  }

  private buildProjections(
    snapshot: ReviewCommentStoreSnapshot,
  ): ThreadProjection[] {
    const model = this.model;
    if (!model) return [];
    const projections: ThreadProjection[] = [];
    for (const record of snapshot.commentThreads.values()) {
      if (record.target.kind !== "code") continue;
      const agentActivity = snapshot.agentActivities.get(record.threadId);
      if (agentActivity?.status === "starting") continue;
      const target = record.target;
      const rows = gitLabDiffPositionRows(target.position);
      const outdated =
        !!target.change_position ||
        !rows ||
        target.position.base_sha !== model.session.session.resolvedBaseRef ||
        target.position.start_sha !== model.session.session.resolvedBaseRef ||
        target.position.head_sha !== model.session.session.headRef;
      projections.push({
        threadId: record.threadId,
        target,
        record,
        resource: this.workspaceResourceForTarget(target),
        range: undefined,
        outdated,
        draft: snapshot.localComments.has(record.threadId),
        agentActivity,
      });
    }
    return projections;
  }

  private workspaceResourceForTarget(target: CodeThreadTarget): URI {
    const model = this.model!;
    const path =
      target.position.new_path ?? target.position.old_path ?? "unknown";
    const query = new URLSearchParams({
      path,
      version: model.session.session.sessionId,
      workspace: "true",
    });
    return URI.from({
      scheme: REVIEW_UNIFIED_SCHEME,
      path: `/${path}`,
      query: query.toString(),
    });
  }

  private async targetForResource(
    resource: URI,
    range: IRange | undefined,
  ): Promise<CodeThreadTarget | null> {
    const model = this.model;
    if (!model || model.state !== "active" || !range) return null;
    const rows = await this.codeResources.positionRowsForResourceRange(
      resource,
      Math.min(range.startLineNumber, range.endLineNumber),
      Math.max(range.startLineNumber, range.endLineNumber),
    );
    return rows
      ? this.targetForPositionRows(rows.diffFile, rows.start, rows.end)
      : null;
  }

  private targetForPositionRows(
    diffFile: ReviewDiffFileWire,
    start: { readonly old_line: number | null; readonly new_line: number | null },
    end: { readonly old_line: number | null; readonly new_line: number | null },
  ): CodeThreadTarget | null {
    const session = this.model?.session.session;
    if (!session?.resolvedBaseRef || !session.headRef) return null;
    const position = createGitLabTextDiffPosition({
      base_sha: session.resolvedBaseRef,
      start_sha: session.resolvedBaseRef,
      head_sha: session.headRef,
      old_path: diffFile.previousPath ?? diffFile.path,
      new_path: diffFile.path,
      start,
      end,
    });
    return { kind: "code", original_position: position, position };
  }

  private resourceIdentity(resource: URI): ReviewCodeResourceIdentity | null {
    const model = this.model;
    if (!model) return null;
    if (
      resource.scheme === REVIEW_BASE_SCHEME ||
      resource.scheme === REVIEW_HEAD_SCHEME
    ) {
      const query = new URLSearchParams(resource.query);
      if (query.get("version") !== model.session.session.sessionId) return null;
      const path = resource.path.replace(/^\/+/, "");
      if (!path) return null;
      return {
        path,
        side: resource.scheme === REVIEW_BASE_SCHEME ? "base" : "head",
      };
    }
    if (resource.scheme !== "file") return null;
    const rootPath = model.session.session.headRootPath;
    if (!rootPath) return null;
    const path = extUri.relativePath(URI.file(rootPath), resource);
    if (!path || path.startsWith("../")) return null;
    return { path, side: "head" };
  }

  private projectThread(
    projection: ThreadProjection,
    resource: URI,
    range: Range,
    label?: string,
  ): ReviewCommentThread {
    const key = resourceProjectionKey(projection.threadId, resource);
    let thread = this.resourceThreads.get(key);
    if (!thread) {
      thread = new ReviewCommentThread(
        projection.threadId,
        this.nextHandle++,
        resource,
        range,
        false,
      );
      this.resourceThreads.set(key, thread);
    }
    thread.apply({ ...projection, resource, range, label });
    return thread;
  }

  private visibleInEditor(thread: ReviewCommentThread): boolean {
    return (
      thread.isTemplate ||
      thread.applicability !== CommentThreadApplicability.Outdated
    );
  }

  private clearThreads(): void {
    const resourceThreads = [...this.resourceThreads.values()];
    const threads = new Set([
      ...this.threads.values(),
      ...resourceThreads,
    ]);
    const removed = resourceThreads.filter((thread) =>
      this.visibleInEditor(thread),
    );
    this.threads = new Map();
    this.resourceThreads = new Map();
    this.projections = new Map();
    this.targets = new Map();
    if (removed.length) {
      this.commentService.updateComments(this.owner, {
        added: [],
        removed,
        changed: [],
        pending: [],
      });
    }
    this.commentService.removeWorkspaceComments(this.owner);
    for (const thread of threads) thread.dispose();
  }
}

class ReviewCommentsContribution
  extends Disposable
  implements IWorkbenchContribution
{
  static readonly ID = "workbench.contrib.devfast.reviewComments";

  constructor(
    @ICommentService commentService: ICommentService,
    @IReviewSessionModelService sessionModelService: IReviewSessionModelService,
    @IReviewCodeResourceService codeResources: IReviewCodeResourceService,
    @IReviewSessionService sessionService: IReviewSessionService,
    @IContextKeyService contextKeyService: IContextKeyService,
  ) {
    super();
    this._register(
      new ReviewCommentController(
        commentService,
        sessionModelService,
        codeResources,
        sessionService,
        contextKeyService,
      ),
    );
  }
}

const reviewControllerWhen = ContextKeyExpr.equals(
  "commentController",
  REVIEW_COMMENT_CONTROLLER,
);
const reviewCommentWhen = (value: string) =>
  ContextKeyExpr.and(
    reviewControllerWhen,
    ContextKeyExpr.equals("comment", value),
  );
const reviewThreadWhen = (value: string) =>
  ContextKeyExpr.and(
    reviewControllerWhen,
    ContextKeyExpr.equals("commentThread", value),
  );
/* Outside the tutorial a draft thread gets the split control: "Ask now" with
   "Add to review" behind the chevron. The tutorial has only one verb, so it
   gets the plain "Ask now" button registered below instead. */
MenuRegistry.appendMenuItem(MenuId.CommentThreadActions, {
  submenu: REVIEW_COMMENT_SUBMIT_MENU,
  title: localize("reviewCommentSubmit", "Ask now"),
  group: "inline",
  order: 10,
  when: ContextKeyExpr.and(
    reviewThreadWhen(REVIEW_COMMENT_THREAD_DRAFT),
    ReviewCanAddToReviewContext,
  ),
});

registerAction2(
  class AddToReviewAction extends Action2 {
    constructor() {
      super({
        id: ADD_TO_REVIEW_COMMAND,
        title: localize("reviewCommentAddToReview", "Add to review"),
        menu: [
          {
            id: MenuId.CommentThreadActions,
            group: "inline",
            order: 10,
            when: ContextKeyExpr.and(
              reviewThreadWhen(REVIEW_COMMENT_THREAD_OPEN),
              ReviewCanAddToReviewContext,
            ),
          },
          {
            id: REVIEW_COMMENT_SUBMIT_MENU,
            group: "inline",
            order: 20,
            when: ContextKeyExpr.and(
              reviewThreadWhen(REVIEW_COMMENT_THREAD_DRAFT),
              ReviewCanAddToReviewContext,
            ),
          },
        ],
      });
    }

    override async run(
      accessor: ServicesAccessor,
      context: ReviewCommentReplyContext,
    ): Promise<void> {
      await runReviewAction(accessor, (controller) =>
        controller.addToReview(context),
      );
    }
  },
);

registerAction2(
  class AskNowAction extends Action2 {
    constructor() {
      super({
        id: ASK_NOW_COMMAND,
        title: localize("reviewCommentAskNow", "Ask now"),
        menu: [
          {
            id: MenuId.CommentThreadActions,
            group: "inline",
            order: 10,
            when: reviewThreadWhen(REVIEW_COMMENT_THREAD_OPEN),
          },
          {
            id: REVIEW_COMMENT_SUBMIT_MENU,
            group: "inline",
            order: 10,
            when: reviewThreadWhen(REVIEW_COMMENT_THREAD_DRAFT),
          },
          // The tutorial hides the split control, so the one verb it keeps
          // needs its own plain button on the thread.
          {
            id: MenuId.CommentThreadActions,
            group: "inline",
            order: 10,
            when: ContextKeyExpr.and(
              reviewThreadWhen(REVIEW_COMMENT_THREAD_DRAFT),
              ReviewCanAddToReviewContext.toNegated(),
            ),
          },
        ],
      });
    }

    override run(
      accessor: ServicesAccessor,
      context: ReviewCommentReplyContext,
    ): Promise<void> {
      return runReviewAction(accessor, (controller) =>
        controller.askNow(context),
      );
    }
  },
);

registerAction2(
  class EditCommentAction extends Action2 {
    constructor() {
      super({
        id: EDIT_COMMENT_COMMAND,
        title: localize("reviewCommentEdit", "Edit"),
        icon: Codicon.edit,
        menu: {
          id: MenuId.CommentTitle,
          group: "inline",
          order: 10,
          when: reviewCommentWhen(REVIEW_COMMENT_MESSAGE),
        },
      });
    }

    override run(
      accessor: ServicesAccessor,
      context: ReviewCommentNodeContext,
    ): void {
      void runReviewAction(accessor, (controller) =>
        controller.editComment(context),
      );
    }
  },
);

registerAction2(
  class DeleteCommentAction extends Action2 {
    constructor() {
      super({
        id: DELETE_COMMENT_COMMAND,
        title: localize("reviewCommentDelete", "Delete"),
        icon: Codicon.trash,
        menu: {
          id: MenuId.CommentTitle,
          group: "inline",
          order: 20,
          when: reviewCommentWhen(REVIEW_COMMENT_MESSAGE),
        },
      });
    }

    override async run(
      accessor: ServicesAccessor,
      context: ReviewCommentNodeContext,
    ): Promise<void> {
      await runReviewAction(accessor, (controller) =>
        controller.deleteMessage(context),
      );
    }
  },
);

registerAction2(
  class SaveCommentAction extends Action2 {
    constructor() {
      super({
        id: SAVE_COMMENT_COMMAND,
        title: localize("reviewCommentSave", "Save"),
        menu: {
          id: MenuId.CommentActions,
          group: "inline",
          order: 10,
          when: reviewCommentWhen(REVIEW_COMMENT_MESSAGE_EDITING),
        },
      });
    }

    override async run(
      accessor: ServicesAccessor,
      context: ReviewCommentNodeContext,
    ): Promise<void> {
      await runReviewAction(accessor, (controller) =>
        controller.saveEdit(context),
      );
    }
  },
);

registerAction2(
  class CancelCommentEditAction extends Action2 {
    constructor() {
      super({
        id: CANCEL_EDIT_COMMAND,
        title: localize("reviewCommentCancelEdit", "Cancel"),
        menu: {
          id: MenuId.CommentActions,
          group: "inline",
          order: 20,
          when: reviewCommentWhen(REVIEW_COMMENT_MESSAGE_EDITING),
        },
      });
    }

    override run(
      accessor: ServicesAccessor,
      context: ReviewCommentNodeContext,
    ): void {
      void runReviewAction(accessor, (controller) =>
        controller.cancelEdit(context),
      );
    }
  },
);

registerAction2(
  class ResolveThreadAction extends Action2 {
    constructor() {
      super({
        id: RESOLVE_THREAD_COMMAND,
        title: localize("reviewCommentResolve", "Resolve"),
        icon: Codicon.check,
        menu: {
          id: MenuId.CommentThreadTitle,
          group: "inline",
          order: 10,
          when: reviewThreadWhen(REVIEW_COMMENT_THREAD_OPEN),
        },
      });
    }

    override async run(
      accessor: ServicesAccessor,
      thread: CommentThread,
    ): Promise<void> {
      await runReviewAction(accessor, (controller) =>
        controller.setResolved(thread, true),
      );
    }
  },
);

registerAction2(
  class UnresolveThreadAction extends Action2 {
    constructor() {
      super({
        id: UNRESOLVE_THREAD_COMMAND,
        title: localize("reviewCommentUnresolve", "Unresolve"),
        icon: Codicon.refresh,
        menu: {
          id: MenuId.CommentThreadTitle,
          group: "inline",
          order: 10,
          when: reviewThreadWhen(REVIEW_COMMENT_THREAD_RESOLVED),
        },
      });
    }

    override async run(
      accessor: ServicesAccessor,
      thread: CommentThread,
    ): Promise<void> {
      await runReviewAction(accessor, (controller) =>
        controller.setResolved(thread, false),
      );
    }
  },
);

registerAction2(
  class DeleteThreadAction extends Action2 {
    constructor() {
      super({
        id: DELETE_THREAD_COMMAND,
        title: localize("reviewCommentDeleteThread", "Delete thread"),
        icon: Codicon.trash,
        menu: {
          id: MenuId.CommentThreadTitle,
          group: "inline",
          order: 20,
          when: reviewControllerWhen,
        },
      });
    }

    override async run(
      accessor: ServicesAccessor,
      thread: CommentThread,
    ): Promise<void> {
      await runReviewAction(accessor, (controller) =>
        controller.deleteThread(thread),
      );
    }
  },
);

async function runReviewAction(
  accessor: ServicesAccessor,
  action: (controller: ReviewCommentController) => void | Promise<void>,
): Promise<void> {
  const notificationService = accessor.get(INotificationService);
  const controller = accessor
    .get(ICommentService)
    .getCommentController(REVIEW_COMMENT_OWNER);
  if (!(controller instanceof ReviewCommentController)) return;
  try {
    await action(controller);
  } catch (error) {
    notificationService.error(
      error instanceof Error ? error.message : String(error),
    );
  }
}

registerWorkbenchContribution2(
  ReviewCommentsContribution.ID,
  ReviewCommentsContribution,
  WorkbenchPhase.BlockRestore,
);

function wholeLineRange(range: IRange): Range {
  return new Range(
    Math.min(range.startLineNumber, range.endLineNumber),
    1,
    Math.max(range.startLineNumber, range.endLineNumber),
    Number.MAX_SAFE_INTEGER,
  );
}
