import { createHash, randomUUID } from "node:crypto";

import {
  HOST_LIMITS,
  type HostDocumentState,
  type HostFeedbackCommand,
  type HostFeedbackQuery,
  type HostFeedbackTarget,
  type HostMessage,
  type HostPrincipal,
  type HostQuestionContext,
  type HostQuestionRun,
  type HostSourceQuote,
  type HostThread,
  type HostThreadMapping,
  type JsonValue,
  canonicalHostJson,
} from "@dev.fast/review-protocol";

import { proposeDocumentRepin } from "./document-repin";
import {
  type EvidenceProvider,
  EvidenceProviderError,
} from "./evidence-provider";
import type { LocalRepositorySource } from "./local-repository";
import { type HostAccess, HostAccessError } from "./review-host";
import { HostStoreError, type ReviewHostStore } from "./review-host-store";

/** Conversations are host data. The executor receives a frozen context only
 * after the question transaction has committed successfully. */
export class ReviewFeedback {
  constructor(
    private readonly store: ReviewHostStore,
    private readonly evidence: EvidenceProvider,
    private readonly source: LocalRepositorySource,
  ) {}

  async prepare(
    request: HostFeedbackCommand,
    access: HostAccess,
  ): Promise<() => JsonValue> {
    const input = request.input;
    const reviewId = input.reviewId;
    const now = new Date().toISOString();
    if (
      request.type !== "question.complete" &&
      request.type !== "review.attention" &&
      request.type !== "draft.delete"
    )
      this.mutableReview(reviewId);
    else this.store.review(reviewId);
    if ("body" in input && input.body !== undefined) checkBody(input.body);
    switch (request.type) {
      case "draft.save": {
        const input = request.input;
        const evidence = await this.targetEvidence(reviewId, input.target);
        return () => {
          this.mutableReview(reviewId);
          const before =
            input.expectedVersion === null
              ? null
              : this.store.draft(reviewId, input.draftId, access.principal.id);
          const draft = this.store.saveDraft(
            {
              id: input.draftId,
              reviewId,
              principalId: access.principal.id,
              version: before ? before.version + 1 : 0,
              target: input.target,
              evidence,
              body: input.body,
              createdAt: before?.createdAt ?? now,
              updatedAt: now,
            },
            input.expectedVersion,
          );
          this.store.appendEvent(
            reviewId,
            "draft.saved",
            { draft },
            access.principal.id,
          );
          return draft;
        };
      }
      case "draft.delete": {
        const input = request.input;
        return () => {
          this.store.deleteDraft(
            reviewId,
            input.draftId,
            access.principal.id,
            input.expectedVersion,
          );
          this.store.appendEvent(
            reviewId,
            "draft.deleted",
            { draftId: input.draftId },
            access.principal.id,
          );
          return { deleted: true };
        };
      }
      case "thread.create": {
        const input = request.input;
        const evidence = await this.targetEvidence(reviewId, input.target);
        return () =>
          this.createThread(
            reviewId,
            input.target,
            evidence,
            input.body,
            access.principal,
            now,
          );
      }
      case "thread.reply": {
        const input = request.input;
        return () =>
          this.appendMessage(reviewId, {
            id: input.messageId,
            threadId: input.threadId,
            body: input.body,
            author: access.principal,
            replyToMessageId: input.replyToMessageId ?? null,
            questionRunId: null,
            createdAt: now,
          });
      }
      case "thread.status": {
        const input = request.input;
        return () => {
          const thread = this.store.setThreadStatus(
            reviewId,
            input.threadId,
            input.expectedVersion,
            input.status,
          );
          this.store.appendEvent(reviewId, "thread.updated", { thread });
          return thread;
        };
      }
      case "feedback.submit": {
        const input = request.input;
        if (
          new Set(input.drafts.map((draft) => draft.draftId)).size !==
          input.drafts.length
        )
          invalid("A draft may only be selected once.");
        if (input.decision === "comment" && !input.drafts.length && !input.body)
          invalid("Comment feedback requires a message or a selected draft.");
        return () => {
          const review = this.mutableReview(reviewId);
          const checkpoint = this.store.checkpoint(
            reviewId,
            input.checkpointId,
          );
          if (
            input.decision !== "comment" &&
            checkpoint.id !== review.publishedCheckpointId
          )
            throw new HostStoreError(
              "VERSION_CONFLICT",
              "This checkpoint has been superseded. Review the current checkpoint before deciding.",
            );
          const messages: HostMessage[] = [];
          for (const selection of input.drafts) {
            const draft = this.store.draft(
              reviewId,
              selection.draftId,
              access.principal.id,
            );
            if (draft.version !== selection.expectedVersion)
              throw new HostStoreError(
                "VERSION_CONFLICT",
                "A selected draft changed. Refresh before submitting.",
              );
            messages.push(
              this.createThread(
                reviewId,
                draft.target,
                draft.evidence,
                draft.body,
                access.principal,
                now,
              ).message,
            );
            this.store.deleteDraft(
              reviewId,
              draft.id,
              access.principal.id,
              selection.expectedVersion,
            );
            this.store.appendEvent(
              reviewId,
              "draft.deleted",
              { draftId: draft.id },
              access.principal.id,
            );
          }
          if (input.body)
            messages.push(
              this.createThread(
                reviewId,
                {
                  kind: "document",
                  documentVersion: checkpoint.documentVersion,
                },
                null,
                input.body,
                access.principal,
                now,
              ).message,
            );
          const submission = {
            id: randomUUID(),
            reviewId,
            checkpointId: checkpoint.id,
            decision: input.decision,
            createdBy: access.principal.id,
            createdAt: now,
            threadIds: messages.map((message) => message.threadId),
            messageIds: messages.map((message) => message.id),
          };
          this.store.putSubmission(submission);
          if (input.decision === "request_changes") {
            const updated = this.store.updateReview(
              reviewId,
              review.version,
              (before) => ({
                ...before,
                workflow: "changes_requested",
                version: before.version + 1,
                updatedAt: now,
              }),
            );
            this.store.appendEvent(reviewId, "review.updated", {
              review: updated,
            });
          }
          this.store.appendEvent(reviewId, "feedback.submitted", {
            submission,
          });
          return submission;
        };
      }
      case "question.start": {
        const input = request.input;
        const evidence = await this.targetEvidence(reviewId, input.target);
        const document = this.store.document(
          reviewId,
          input.target.documentVersion,
        );
        const context = this.freezeContext(
          document,
          input.target,
          evidence,
          input.body,
          [],
        );
        return () => {
          const created = this.createThread(
            reviewId,
            input.target,
            evidence,
            input.body,
            access.principal,
            now,
          );
          const run = this.createRun(
            created.thread,
            created.message,
            context,
            input.harness,
            access.principal,
            now,
          );
          return { ...created, run };
        };
      }
      case "question.follow_up": {
        const input = request.input;
        return () => {
          const thread = this.store.thread(reviewId, input.threadId);
          const document = this.store.document(
            reviewId,
            thread.target.documentVersion,
          );
          const context = this.freezeContext(
            document,
            thread.target,
            thread.evidence,
            input.body,
            this.store.messages(reviewId, thread.id),
          );
          const message = this.appendMessage(reviewId, {
            id: randomUUID(),
            threadId: thread.id,
            body: input.body,
            author: access.principal,
            replyToMessageId: null,
            questionRunId: null,
            createdAt: now,
          });
          const run = this.createRun(
            thread,
            message,
            context,
            input.harness,
            access.principal,
            now,
          );
          return { thread, message, run };
        };
      }
      case "question.retry": {
        const input = request.input;
        return () => {
          const before = this.store.questionRun(reviewId, input.runId);
          if (before.state !== "failed" && before.state !== "interrupted")
            throw new HostStoreError(
              "INVALID_STATE",
              "Only failed or interrupted questions can be retried.",
            );
          // A new run retains the same question/context; there is no launch replay.
          const run: HostQuestionRun = {
            ...before,
            id: randomUUID(),
            requestedBy: access.principal.id,
            state: "pending",
            sessionId: null,
            answerMessageId: null,
            error: null,
            createdAt: now,
            updatedAt: now,
          };
          this.store.createQuestionRun(run);
          this.store.appendEvent(reviewId, "question.updated", { run });
          return run;
        };
      }
      case "question.complete": {
        const input = request.input;
        if (!access.runIds?.has(input.runId))
          throw new HostAccessError(
            "FORBIDDEN",
            "This credential cannot answer that question run.",
          );
        return () =>
          this.complete(
            reviewId,
            input.runId,
            input.outputId,
            input.body,
            access.principal,
          );
      }
      case "review.attention": {
        const input = request.input;
        return () => {
          const before = this.store.attention(reviewId, access.principal.id);
          if (
            input.viewedDocumentVersion !== undefined &&
            input.viewedDocumentVersion !== null
          )
            this.store.document(reviewId, input.viewedDocumentVersion);
          const attention = this.store.updateAttention(
            {
              ...before,
              version: before.version + 1,
              pinned: input.pinned ?? before.pinned,
              viewedDocumentVersion:
                input.viewedDocumentVersion === undefined
                  ? before.viewedDocumentVersion
                  : input.viewedDocumentVersion,
              viewedAt:
                input.viewedDocumentVersion === undefined
                  ? before.viewedAt
                  : now,
            },
            input.expectedVersion,
          );
          this.store.appendEvent(
            reviewId,
            "attention.updated",
            { attention },
            access.principal.id,
          );
          return attention;
        };
      }
    }
  }

  query(
    request: Exclude<HostFeedbackQuery, { type: "thread.mapping" }>,
    principal: HostPrincipal,
  ): JsonValue {
    const { input } = request;
    switch (request.type) {
      case "drafts.list":
        return feedbackPage(
          this.store.drafts(input.reviewId, principal.id),
          request.input,
          `drafts:${input.reviewId}:${principal.id}`,
        );
      case "threads.list":
        return feedbackPage(
          this.store
            .threads(input.reviewId)
            .filter(
              (thread) =>
                !request.input.status || thread.status === request.input.status,
            ),
          request.input,
          `threads:${input.reviewId}:${request.input.status ?? "all"}`,
        );
      case "thread.get":
        return {
          thread: this.store.thread(input.reviewId, request.input.threadId),
          messages: feedbackPage(
            this.store.messages(input.reviewId, request.input.threadId),
            request.input,
            `messages:${input.reviewId}:${request.input.threadId}`,
          ),
        };
      case "feedback.list":
        return feedbackPage(
          this.store.submissions(input.reviewId),
          request.input,
          `submissions:${input.reviewId}`,
        );
      case "feedback.get":
        return this.store.submission(
          input.reviewId,
          request.input.submissionId,
        );
      case "question.get":
        return this.store.questionRun(input.reviewId, request.input.runId);
      case "question.context": {
        const run = this.store.questionRun(input.reviewId, request.input.runId);
        return this.store.questionContext(input.reviewId, run.contextId);
      }
      case "questions.list":
        return feedbackPage(
          this.store
            .questionRuns(input.reviewId)
            .filter(
              (run) =>
                !request.input.threadId ||
                run.threadId === request.input.threadId,
            ),
          request.input,
          `questions:${input.reviewId}:${request.input.threadId ?? "all"}`,
        );
      case "attention.get":
        return this.store.attention(input.reviewId, principal.id);
    }
  }

  async mapping(
    reviewId: string,
    threadId: string,
    version: number,
  ): Promise<HostThreadMapping> {
    const thread = this.store.thread(reviewId, threadId);
    const original = this.store.document(
      reviewId,
      thread.target.documentVersion,
    );
    const current = this.store.document(reviewId, version);
    if (thread.target.kind !== "source") {
      try {
        await this.targetEvidence(reviewId, {
          ...thread.target,
          documentVersion: version,
        });
        return {
          threadId,
          documentVersion: version,
          status: "exact",
          target: { ...thread.target, documentVersion: version },
          evidence: thread.evidence,
        };
      } catch (error) {
        if (
          !(error instanceof HostStoreError) &&
          !(error instanceof EvidenceProviderError)
        )
          throw error;
        return {
          threadId,
          documentVersion: version,
          status: "missing",
          target: null,
          evidence: null,
        };
      }
    }
    const retained = thread.evidence;
    const range = thread.target.range;
    const commit =
      range.side === "base"
        ? current.binding.baseCommit
        : current.binding.headCommit;
    // Source-browser comments retain their own evidence, independently of
    // document anchors. An identical pinned selection needs no repository read.
    if (
      retained &&
      retained.span.repositoryId === current.binding.repositoryId &&
      retained.span.commit === commit &&
      retained.span.file === range.file &&
      retained.span.fromLine === range.fromLine &&
      retained.span.toLine === range.toLine
    )
      return {
        threadId,
        documentVersion: version,
        status: "exact",
        target: { ...thread.target, documentVersion: version },
        evidence: retained,
      };

    const proposal = await proposeDocumentRepin({
      document: {
        ...original,
        definitions: {
          target: {
            kind: "anchor",
            title: "Original comment target",
            source: thread.target.range,
          },
        },
      },
      binding: current.binding,
      source: this.source,
    });
    const mapped = proposal.anchorChanges[0]!;
    if (!mapped.proposed)
      return {
        threadId,
        documentVersion: version,
        status: "missing",
        target: null,
        evidence: null,
      };
    const target: HostFeedbackTarget = {
      kind: "source",
      documentVersion: version,
      range: mapped.proposed,
    };
    const evidence = await this.targetEvidence(reviewId, target);
    return {
      threadId,
      documentVersion: version,
      status: mapped.status,
      target,
      evidence,
    };
  }

  /** Called only inside a host command transaction, including executor callbacks. */
  complete(
    reviewId: string,
    runId: string,
    outputId: string,
    body: string,
    principal: HostPrincipal,
  ) {
    checkBody(body);
    const before = this.store.questionRun(reviewId, runId);
    if (principal.id !== before.assistant.id)
      throw new HostAccessError(
        "FORBIDDEN",
        "The answer principal does not own this question run.",
      );
    if (before.state === "completed") {
      const message = this.store
        .messages(reviewId, before.threadId)
        .find((item) => item.id === before.answerMessageId);
      if (!message || message.id !== outputId || message.body !== body)
        throw new HostStoreError(
          "IDEMPOTENCY_CONFLICT",
          "The question already has a different completed answer.",
        );
      return { run: before, message };
    }
    if (before.state !== "pending" && before.state !== "running")
      throw new HostStoreError(
        "INVALID_STATE",
        "This question run is no longer accepting output.",
      );
    const message = this.appendMessage(
      reviewId,
      {
        id: outputId,
        threadId: before.threadId,
        author: before.assistant,
        body,
        replyToMessageId: before.questionId,
        questionRunId: before.id,
        createdAt: new Date().toISOString(),
      },
      true,
    );
    const run = this.store.updateQuestionRun(reviewId, runId, {
      state: "completed",
      answerMessageId: message.id,
      error: null,
      updatedAt: new Date().toISOString(),
    });
    this.store.appendEvent(reviewId, "question.updated", { run });
    return { run, message };
  }

  private createThread(
    reviewId: string,
    target: HostFeedbackTarget,
    evidence: HostSourceQuote | null,
    body: string,
    author: HostPrincipal,
    now: string,
  ) {
    this.mutableReview(reviewId);
    const thread: HostThread = {
      id: randomUUID(),
      reviewId,
      version: 0,
      target,
      evidence,
      status: "open",
      createdBy: author.id,
      createdAt: now,
      updatedAt: now,
    };
    this.store.createThread(thread);
    this.store.appendEvent(reviewId, "thread.created", { thread });
    const message = this.appendMessage(reviewId, {
      id: randomUUID(),
      threadId: thread.id,
      author,
      body,
      replyToMessageId: null,
      questionRunId: null,
      createdAt: now,
    });
    return { thread, message };
  }

  private appendMessage(
    reviewId: string,
    message: Omit<HostMessage, "ordinal">,
    acceptedRun = false,
  ) {
    if (!acceptedRun) this.mutableReview(reviewId);
    const before = this.store
      .messages(reviewId, message.threadId)
      .find((item) => item.id === message.id);
    const accepted = this.store.appendMessage(reviewId, message);
    if (!before)
      this.store.appendEvent(reviewId, "message.appended", {
        message: accepted,
      });
    return accepted;
  }

  private createRun(
    thread: HostThread,
    message: HostMessage,
    context: HostQuestionContext,
    harness: HostQuestionRun["harness"],
    requestedBy: HostPrincipal,
    now: string,
  ) {
    const key = `ask:${harness}`;
    const existing = this.store.principal(key);
    const assistant = existing ?? {
      id: randomUUID(),
      kind: "agent" as const,
      displayName: `${harness} · Ask`,
    };
    if (!existing) this.store.putPrincipal(key, assistant);
    this.store.putQuestionContext(context);
    const run: HostQuestionRun = {
      id: randomUUID(),
      reviewId: thread.reviewId,
      threadId: thread.id,
      questionId: message.id,
      contextId: context.id,
      requestedBy: requestedBy.id,
      assistant,
      harness,
      state: "pending",
      sessionId: null,
      answerMessageId: null,
      error: null,
      createdAt: now,
      updatedAt: now,
    };
    this.store.createQuestionRun(run);
    this.store.appendEvent(thread.reviewId, "question.updated", { run });
    return run;
  }

  private async targetEvidence(
    reviewId: string,
    target: HostFeedbackTarget,
  ): Promise<HostSourceQuote | null> {
    const document = this.store.document(reviewId, target.documentVersion);
    if (target.kind === "document") return null;
    if (target.kind === "source") {
      // Retained document evidence keeps common selections usable offline.
      const match = Object.values(document.evidence).find(
        (quote) =>
          quote.span.commit ===
            (target.range.side === "base"
              ? document.binding.baseCommit
              : document.binding.headCommit) &&
          quote.span.file === target.range.file &&
          quote.span.fromLine <= target.range.fromLine &&
          quote.span.toLine >= target.range.toLine,
      );
      if (!match) return this.evidence.resolve(document.binding, target.range);
      const text = match.text
        .split("\n")
        .slice(
          target.range.fromLine - match.span.fromLine,
          target.range.toLine - match.span.fromLine + 1,
        )
        .join("\n");
      return {
        span: {
          ...match.span,
          fromLine: target.range.fromLine,
          toLine: target.range.toLine,
        },
        text,
        sha256: createHash("sha256").update(text).digest("hex"),
      };
    }
    const node = document.nodes[target.nodeId];
    if (!node)
      throw new HostStoreError(
        "NOT_FOUND",
        "The selected node is not in the observed document.",
      );
    if (target.kind === "diagram") {
      const ids =
        node.type === "sequence"
          ? node.messages.map((item) => item.id)
          : node.type === "call_stack_diff"
            ? [...node.base, ...node.head].map((item) => item.id)
            : node.type === "database_lens"
              ? node.useCases.flatMap((item) => [
                  item.id,
                  ...item.operations.map((operation) => operation.id),
                ])
              : [];
      if (!ids.includes(target.itemId))
        throw new HostStoreError(
          "NOT_FOUND",
          "The selected diagram item is not in the observed node.",
        );
    } else if (target.kind === "trace") {
      if (node.type !== "trace_quote" || node.eventId !== target.eventId)
        throw new HostStoreError(
          "NOT_FOUND",
          "The selected trace event is not quoted by this node.",
        );
      this.store.trace(reviewId, node.traceId);
    }
    return null;
  }

  private freezeContext(
    document: HostDocumentState,
    target: HostFeedbackTarget,
    evidence: HostSourceQuote | null,
    question: string,
    messages: HostMessage[],
  ): HostQuestionContext {
    const review = this.store.review(document.reviewId);
    // Bounded excerpts are explicitly labelled. The immutable version/target is
    // available through API reads when the fresh agent needs more detail.
    const selected =
      "nodeId" in target ? document.nodes[target.nodeId] : document;
    const material = {
      review: { id: review.id, title: clipUtf8(review.title, 1000) },
      binding: {
        repositoryId: document.binding.repositoryId,
        baseCommit: document.binding.baseCommit,
        headCommit: document.binding.headCommit,
      },
      document: {
        documentId: document.documentId,
        version: document.version,
        contentHash: document.contentHash,
      },
      target,
      sourceEvidence: evidence
        ? {
            span: evidence.span,
            textExcerpt: clipUtf8(evidence.text, 4000),
            sha256: evidence.sha256,
          }
        : null,
      documentJsonExcerpt: clipUtf8(canonicalHostJson(selected!), 8000),
      priorMessages: messages.slice(-8).map((message) => ({
        id: message.id,
        author: message.author,
        bodyExcerpt: clipUtf8(message.body, 1000),
      })),
      excerptNotice:
        "Context contains bounded excerpts. Read the named immutable document version or hosted thread for complete content. No author transcript is included.",
    };
    const context: HostQuestionContext = {
      id: randomUUID(),
      reviewId: document.reviewId,
      documentVersion: document.version,
      question,
      material,
    };
    // JSON escaping can expand otherwise bounded text. Leave room for executor instructions.
    if (Buffer.byteLength(canonicalHostJson(context)) > 56 * 1024)
      context.material = {
        ...material,
        documentJsonExcerpt: "Omitted: use document.get at the named version.",
        priorMessages: [],
        sourceEvidence: evidence
          ? {
              span: evidence.span,
              textExcerpt: "Omitted: use document.evidence.",
              sha256: evidence.sha256,
            }
          : null,
      };
    return context;
  }

  private mutableReview(reviewId: string) {
    const review = this.store.review(reviewId);
    if (review.deletedAt !== null || review.workflow === "closed")
      throw new HostStoreError(
        "INVALID_STATE",
        "Closed or trashed reviews do not accept new feedback.",
      );
    return review;
  }
}

function checkBody(body: string) {
  if (!body.trim()) invalid("A message must contain text.");
  if (Buffer.byteLength(body) > HOST_LIMITS.commentBytes)
    throw new EvidenceProviderError(
      "RESOURCE_LIMIT",
      "Messages may not exceed 32 KiB.",
    );
}
function invalid(message: string): never {
  throw new EvidenceProviderError("INVALID_REQUEST", message);
}
function clipUtf8(value: string, bytes: number) {
  if (Buffer.byteLength(value) <= bytes) return value;
  const prefix = Buffer.from(value).subarray(0, Math.max(0, bytes - 32));
  return `${prefix.toString("utf8").replace(/\ufffd$/, "")}\n[excerpt truncated]`;
}
function feedbackPage<T extends JsonValue & { id: string }>(
  items: T[],
  input: { cursor?: string; limit?: number },
  scope: string,
) {
  let start = 0;
  if (input.cursor) {
    const decoded = Buffer.from(input.cursor, "base64url").toString("utf8");
    const prefix = `${scope}:`;
    if (!decoded.startsWith(prefix))
      throw new HostStoreError(
        "CURSOR_EXPIRED",
        "Cursor belongs to a different query.",
      );
    const index = items.findIndex(
      (item) => item.id === decoded.slice(prefix.length),
    );
    if (index < 0)
      throw new HostStoreError(
        "CURSOR_EXPIRED",
        "Refresh this collection before continuing.",
      );
    start = index + 1;
  }
  const selected = items.slice(start, start + (input.limit ?? 50));
  const last = selected.at(-1);
  return {
    items: selected,
    nextCursor:
      last && start + selected.length < items.length
        ? Buffer.from(`${scope}:${last.id}`).toString("base64url")
        : null,
  };
}
