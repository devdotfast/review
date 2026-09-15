import {
  type CreateReviewCommentInput,
  type ReviewApiSourceLocation,
  type ReviewCommentAgentActivity,
  type ReviewCommentAgentSession,
  type ReviewCommentStoreBridge,
  type ReviewCommentStoreChange,
  type ReviewCommentStoreSnapshot,
  type ReviewCommentThreadRecord,
  type ReviewInlineEditorRange,
  type ReviewLocalCommentThread,
  type ThreadTarget,
  gitLabDiffPositionRows,
} from "./contracts.js";
import type { ReviewApiClient, ReviewApiSummary } from "./review-api-client.js";

export interface QuestionStatus {
  status: "running" | "completed" | "failed";
  error?: string;
}

export interface QuestionRun extends QuestionStatus {
  requestId: string;
  threadIds: string[];
  startedAt: string;
  session?: ReviewCommentAgentSession;
}

export interface FeedbackMessage {
  id: string;
  version: number;
  body: string;
  by: "user" | "agent";
  draft: boolean;
  createdAt: string;
}

export interface FeedbackThread {
  id: string;
  version: number;
  target: ThreadTarget;
  resolved: boolean;
  messages: FeedbackMessage[];
}

export interface FeedbackSubmission {
  id: string;
  version: number;
  decision: "approve" | "request-changes";
  messageIds: string[];
  createdAt: string;
}

export interface FeedbackSnapshot {
  revision: number;
  threads: FeedbackThread[];
  submissions: FeedbackSubmission[];
  /** Runtime-only answer status, added by the HTTP host. */
  runs?: QuestionRun[];
}

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
  private refreshId = 0;
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

    const snapshot = await this.client.read<Pick<ReviewApiSummary, "pins">>(
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
    const request = ++this.refreshId;
    const version = this.version();
    this.displayedVersion = version;

    const next = await this.client.read<FeedbackSnapshot>(
      `/${this.reviewId}/feedback?version=${version}`,
      this.abort.signal,
    );

    if (request !== this.refreshId) return;
    this.accept(next, version);

    if (!this.abort.signal.aborted && version === this.displayedVersion)
      this.connectionError();
  }
  private accept(next: FeedbackSnapshot, version?: number) {
    if (
      this.abort.signal.aborted ||
      version !== this.displayedVersion ||
      next.revision < this.current.revision ||
      (next.revision === this.current.revision &&
        version === this.acceptedVersion &&
        JSON.stringify(next.runs) === JSON.stringify(this.current.runs))
    )
      return;
    this.acceptedVersion = version;
    this.current = next;
    this.publish();
  }
  private publish() {
    const previous = this.snapshot;
    const activities = new Map<string, ReviewCommentAgentActivity>();

    for (const run of this.current.runs ?? []) {
      for (const threadId of run.threadIds) {
        if (run.status === "completed") activities.delete(threadId);
        else
          activities.set(threadId, {
            messageId: run.requestId,
            startedAt: run.startedAt,
            ...(run.status === "failed"
              ? ({
                  status: "failed",
                  error: run.error ?? "The agent could not finish.",
                } as const)
              : ({ status: "running" } as const)),
          });
      }
    }

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
        agentSession: [...(this.current.runs ?? [])]
          .reverse()
          .find((run) => run.threadIds.includes(thread.id))?.session,
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
    }

    this.snapshot = { ...next, agentActivities: activities };

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
    commandId: string = crypto.randomUUID(),
  ) {
    // Keep the exact request through a lost response, including its displayed version.
    if (!this.pending.has(commandId))
      this.pending.set(commandId, {
        commandId,
        operation: { type: "feedback", reviewId: this.reviewId, action },
      });

    const result = await this.client.post<{ targetId?: string }>(
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
    await this.client.post(
      `/${this.reviewId}/ask`,
      { threadId: input.threadId, messageId: input.messageId },
      this.abort.signal,
    );
    await this.refresh();
  }
  async deleteLocalComment(threadId: string) {
    await this.send({ type: "discard-draft", threadId });
  }
  private unanswered(threadId: string) {
    const thread = this.current.threads.find(
      (thread) => thread.id === threadId,
    );

    for (const message of [...(thread?.messages ?? [])].reverse()) {
      if (message.draft || message.by !== "user") continue;

      const submission = this.current.submissions.find((item) =>
        item.messageIds.includes(message.id),
      );

      if (submission && submission.decision !== "request-changes") continue;

      if (
        !submission &&
        thread!.messages
          .slice(thread!.messages.indexOf(message) + 1)
          .some((reply) => reply.by === "agent")
      )
        continue;
      const requestId = submission?.id ?? message.id;

      if (
        !thread!.messages.some(
          (answer) => answer.id === `answer:${requestId}:${threadId}`,
        )
      )
        return submission
          ? { submissionId: submission.id }
          : { threadId, messageId: message.id };
    }

    return undefined;
  }
  canRetryAgent(threadId: string) {
    return (
      this.snapshot.agentActivities.get(threadId)?.status !== "running" &&
      Boolean(this.unanswered(threadId))
    );
  }
  async retryAgent(threadId: string) {
    const input = this.unanswered(threadId);

    if (!input) return;
    await this.client.post(
      `/${this.reviewId}/${"submissionId" in input ? "respond" : "ask"}`,
      input,
      this.abort.signal,
    );
    await this.refresh();
  }
  async openTerminal(threadId: string) {
    const run = [...(this.current.runs ?? [])]
      .reverse()
      .find((run) => run.threadIds.includes(threadId));

    if (!run?.session)
      throw new Error("This conversation has no available agent terminal.");
    await this.client.post(
      `/${this.reviewId}/runs/${encodeURIComponent(run.requestId)}/terminal`,
      {},
      this.abort.signal,
    );
    await this.refresh();
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
        await this.refresh();
      } catch (error) {
        this.connectionError(
          `Your review was submitted, but the agent could not start: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
}
