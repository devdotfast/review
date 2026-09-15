import {
  type CreateReviewCommentInput,
  type ReviewApiSourceLocation,
  type ReviewCommentAgentActivity,
  type ReviewCommentStoreBridge,
  type ReviewCommentStoreChange,
  type ReviewCommentStoreSnapshot,
  type ReviewCommentThreadRecord,
  type ReviewInlineEditorRange,
  type ReviewLocalCommentThread,
  gitLabDiffPositionRows,
} from "@dev.fast/review-protocol";

import type { ReviewApiClient } from "../../src/review-api/client";
import type { FeedbackSnapshot } from "../../src/review-api/feedback";
import type { QuestionStatus } from "../../src/review-api/questions";
import type { Result, Snapshot } from "../../src/review-api/store";
import { createClientId } from "./review-context";

/** Adapts server-owned feedback to the existing annotation UI. */
export class ApiComments implements ReviewCommentStoreBridge {
  private current: FeedbackSnapshot = {
    revision: -1,
    threads: [],
    submissions: [],
  };
  private snapshot: ReviewCommentStoreSnapshot = {
    commentThreads: new Map(),
    localComments: new Map(),
    agentActivities: new Map(),
    terminalThreadIds: new Set(),
    pendingCommentCount: 0,
  };
  private readonly listeners = new Set<
    (change: ReviewCommentStoreChange) => void
  >();
  private readonly pending = new Map<string, unknown>();
  private readonly abort = new AbortController();
  private submitting = false;
  private displayedVersion?: number;
  private acceptedVersion?: number;
  private readonly activities = new Map<string, ReviewCommentAgentActivity>();
  constructor(
    private readonly client: ReviewApiClient,
    private readonly reviewId: string,
    private readonly version: () => number,
    private readonly connectionError: (message?: string) => void = () => {},
  ) {}

  start() {
    void this.client.follow<FeedbackSnapshot>(
      this.reviewId,
      this.abort.signal,
      "feedback",
      async (next) => {
        if (this.displayedVersion === undefined) this.accept(next);
        else await this.refresh();
        this.connectionError();
      },
      () => this.connectionError("Comment connection lost. Reconnecting…"),
    );
  }
  dispose() {
    this.abort.abort();
    this.listeners.clear();
  }
  readonly subscribe = (
    listener: (change: ReviewCommentStoreChange) => void,
  ) => {
    this.listeners.add(listener);

    return () => {
      this.listeners.delete(listener);
    };
  };
  readonly getSnapshot = () => this.snapshot;
  readonly canEditMessage = (threadId: string, messageId: string) =>
    this.current.threads
      .find((thread) => thread.id === threadId)
      ?.messages.some((message) => message.id === messageId && message.draft) ??
    false;

  async originalSource(threadId: string): Promise<{
    source: ReviewApiSourceLocation;
    range: ReviewInlineEditorRange;
  }> {
    const thread = this.current.threads.find((item) => item.id === threadId);

    if (thread?.target.kind !== "code")
      throw new Error("This thread has no original code location.");
    const position = thread.target.original_position;
    const rows = gitLabDiffPositionRows(position)!;
    const side = rows.start.new_line != null ? "head" : "base";

    const snapshot = await this.client.read<Snapshot>(
      `/${this.reviewId}?full=true&version=${thread.version}`,
    );

    return {
      source: {
        version: thread.version,
        side,
        file: (side === "head" ? position.new_path : position.old_path)!,
        commit:
          position.head_sha !== snapshot.pins.head ||
          position.start_sha !== snapshot.pins.base
            ? position.head_sha!
            : undefined,
      },
      range: {
        startLine: (side === "head"
          ? rows.start.new_line
          : rows.start.old_line)!,
        endLine: (side === "head" ? rows.end.new_line : rows.end.old_line)!,
      },
    };
  }

  async refresh() {
    const version = this.version();
    this.displayedVersion = version;
    this.accept(
      await this.client.read<FeedbackSnapshot>(
        `/${this.reviewId}/feedback?version=${version}`,
        this.abort.signal,
      ),
      version,
    );

    if (!this.abort.signal.aborted && version === this.displayedVersion)
      this.connectionError();
  }
  private accept(next: FeedbackSnapshot, version?: number) {
    if (
      this.abort.signal.aborted ||
      version !== this.displayedVersion ||
      next.revision < this.current.revision ||
      (next.revision === this.current.revision &&
        version === this.acceptedVersion)
    )
      return;
    this.acceptedVersion = version;
    this.current = next;
    this.publish();
  }
  private publish() {
    const previous = this.snapshot;

    const next = {
      ...previous,
      commentThreads: new Map<string, ReviewCommentThreadRecord>(),
      localComments: new Map<string, ReviewLocalCommentThread>(),
      pendingCommentCount: 0,
    };

    for (const thread of this.current.threads) {
      const record: ReviewCommentThreadRecord = {
        threadId: thread.id,
        target: thread.target,
        status: thread.resolved ? "resolved" : "open",
        messages: thread.messages.map((message) => ({
          id: message.id,
          body: message.body,
          by: message.by === "agent" ? "Agent" : "You",
          role: message.by === "agent" ? "agent" : "reviewer",
          format: message.by === "agent" ? "markdown" : "plain",
          agentInput: false,
          at: message.createdAt,
        })),
      };

      next.commentThreads.set(thread.id, record);

      const inputs = thread.messages
        .filter((message) => message.draft)
        .map((message) => ({
          threadId: thread.id,
          messageId: message.id,
          target: thread.target,
          body: message.body,
        }));

      if (inputs.length)
        next.localComments.set(thread.id, {
          thread: record,
          inputs,
          clientStatus: this.submitting ? "submitting" : "draft",
        });
      next.pendingCommentCount += inputs.length;
      const activity = this.activities.get(thread.id);

      const questionIndex = thread.messages.findIndex(
        (message) => message.id === activity?.messageId,
      );

      if (
        questionIndex >= 0 &&
        thread.messages
          .slice(questionIndex + 1)
          .some((message) => message.by === "agent")
      )
        this.activities.delete(thread.id);
    }

    this.snapshot = { ...next, agentActivities: new Map(this.activities) };

    const change = {
      threadIds: new Set([
        ...previous.commentThreads.keys(),
        ...next.commentThreads.keys(),
      ]),
    };

    for (const listener of this.listeners) listener(change);
  }
  private async send<Action extends { type: string }>(
    action: Action,
    commandId = createClientId(),
  ) {
    // Keep the exact request through a lost response, including its displayed version.
    if (!this.pending.has(commandId))
      this.pending.set(commandId, {
        commandId,
        operation: { type: "feedback", reviewId: this.reviewId, action },
      });

    const result = await this.client.post<Result>(
      "/commands",
      this.pending.get(commandId),
      this.abort.signal,
    );

    await this.refresh();
    this.pending.delete(commandId);

    return result;
  }
  async saveComment(input: CreateReviewCommentInput) {
    if (
      this.current.threads.some((thread) =>
        thread.messages.some((message) => message.id === input.messageId),
      )
    )
      return;
    await this.send(
      {
        type: "save",
        threadId: input.threadId,
        messageId: input.messageId,
        version: this.version(),
        target: input.target,
        body: input.body,
      },
      input.messageId,
    );
  }
  async persistComment(input: CreateReviewCommentInput) {
    if (
      this.current.threads.some((thread) =>
        thread.messages.some((message) => message.id === input.messageId),
      )
    )
      return;
    await this.send(
      {
        type: "post",
        threadId: input.threadId,
        messageId: input.messageId,
        version: this.version(),
        target: input.target,
        body: input.body,
      },
      input.messageId,
    );
  }
  async askAgent(input: CreateReviewCommentInput) {
    await this.persistComment(input);
    this.activities.set(input.threadId, {
      messageId: input.messageId,
      startedAt: new Date().toISOString(),
      status: "running",
    });
    this.publish();

    try {
      await this.client.post(
        `/${this.reviewId}/ask`,
        { threadId: input.threadId, messageId: input.messageId },
        this.abort.signal,
      );
      await this.refresh();
      void this.followRun(input.messageId, input.threadId);
    } catch (error) {
      this.activities.set(input.threadId, {
        messageId: input.messageId,
        startedAt: new Date().toISOString(),
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
      this.publish();
      throw error;
    }
  }
  async deleteLocalComment(threadId: string) {
    await this.send({ type: "discard-draft", threadId });
  }
  private async followRun(requestId: string, threadId?: string) {
    try {
      while (!this.abort.signal.aborted) {
        const result = await this.client.read<QuestionStatus>(
          `/${this.reviewId}/runs/${encodeURIComponent(requestId)}`,
          this.abort.signal,
        );

        if (result.status === "failed") throw new Error(result.error);

        if (result.status === "completed") {
          await this.refresh();

          if (threadId) this.activities.delete(threadId);
          this.publish();

          return;
        }

        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    } catch (error) {
      if (this.abort.signal.aborted) return;
      const message = error instanceof Error ? error.message : String(error);

      if (threadId) {
        this.activities.set(threadId, {
          messageId: requestId,
          startedAt: new Date().toISOString(),
          status: "failed",
          error: message,
        });
        this.publish();
      } else this.connectionError(message);
    }
  }
  async deleteComment(threadId: string) {
    if (
      this.current.threads
        .find((thread) => thread.id === threadId)
        ?.messages.some((message) => !message.draft)
    )
      throw new Error("Posted conversations cannot be deleted.");
    await this.deleteLocalComment(threadId);
  }
  async deleteCommentMessage(threadId: string, messageId: string) {
    await this.send({ type: "discard-draft", threadId, messageId });
  }
  async updateComment(threadId: string, body: string, messageId?: string) {
    messageId ??= this.current.threads
      .find((thread) => thread.id === threadId)
      ?.messages.find((message) => message.draft)?.id;

    if (!messageId) throw new Error("Choose a saved draft to edit.");
    await this.send({ type: "edit-draft", threadId, messageId, body });
  }
  async setCommentResolved(threadId: string, resolved: boolean) {
    await this.send({ type: "resolve", threadId, resolved });
  }
  async flushPendingComments() {
    const inputs = [...this.snapshot.localComments.values()].flatMap(
      (local) => local.inputs,
    );

    this.submitting = true;
    this.publish();

    return inputs;
  }
  resetPendingComments() {
    this.submitting = false;
    this.publish();
  }
  completeHumanReviewRound() {
    this.resetPendingComments();
  }
  async submit(
    decision: "approve" | "request-changes",
    submissionId: string,
    inputs: CreateReviewCommentInput[],
  ) {
    const result = await this.send(
      {
        type: "submit",
        version: this.version(),
        decision,
        messageIds: inputs.map((input) => input.messageId),
      },
      submissionId,
    );

    if (decision === "request-changes") {
      try {
        await this.client.post(
          `/${this.reviewId}/respond`,
          { submissionId: result.targetId },
          this.abort.signal,
        );
        void this.followRun(result.targetId!);
      } catch (error) {
        this.connectionError(
          `Your review was submitted, but the agent could not start: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
}
