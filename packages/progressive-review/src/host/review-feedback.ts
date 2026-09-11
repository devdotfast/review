import { createHash, randomUUID } from "node:crypto";

import {
  HOST_LIMITS,
  type HostDiagramItem,
  type HostDocumentState,
  type HostFeedbackCommand,
  type HostFeedbackQuery,
  type HostFeedbackTarget,
  type HostMessage,
  type HostNode,
  type HostPrincipal,
  type HostQuestionContext,
  HostQuestionContextSchema,
  type HostQuestionExcerpt,
  type HostQuestionRun,
  type HostSourceQuote,
  type HostThread,
  type HostThreadMapping,
  type JsonValue,
  canonicalHostJson,
} from "@dev.fast/review-protocol";
import { z } from "zod";

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
    private readonly questions?: {
      capabilities(): Promise<HostQuestionRun["harness"][]>;
      defaultHarness?(): HostQuestionRun["harness"] | undefined;
    },
  ) {}

  async prepare(
    request: HostFeedbackCommand,
    access: HostAccess,
  ): Promise<() => JsonValue> {
    const checkState = () => {
      if (
        request.type === "question.complete" ||
        request.type === "attention.update"
      )
        this.store.review(request.input.reviewId);
      else this.mutableReview(request.input.reviewId);
    };
    checkState();
    const commit = await this.prepareCommand(request, access);
    return () => {
      checkState();
      return commit();
    };
  }

  private async prepareCommand(
    request: HostFeedbackCommand,
    access: HostAccess,
  ): Promise<() => JsonValue> {
    const input = request.input;
    const reviewId = input.reviewId;
    const now = new Date().toISOString();
    if ("body" in input && input.body !== undefined) checkBody(input.body);
    switch (request.type) {
      case "draft.save": {
        const input = request.input;
        const evidence = await this.targetEvidence(reviewId, input.target);
        return () => {
          this.mutableReview(reviewId);
          const before =
            input.expectedDraftVersion === null
              ? null
              : this.store.draft(reviewId, input.draftId, access.principal.id);
          const draft = this.store.saveDraft(
            {
              id: input.draftId,
              reviewId,
              principalId: access.principal.id,
              draftVersion: before ? before.draftVersion + 1 : 0,
              target: input.target,
              evidence,
              body: input.body,
              createdAt: before?.createdAt ?? now,
              updatedAt: now,
            },
            input.expectedDraftVersion,
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
            input.expectedDraftVersion,
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
            id: randomUUID(),
            threadId: input.threadId,
            body: input.body,
            author: access.principal,
            replyToMessageId: input.replyToMessageId ?? null,
            questionRunId: null,
            createdAt: now,
          });
      }
      case "thread.set_status": {
        const input = request.input;
        return () => {
          const thread = this.store.setThreadStatus(
            reviewId,
            input.threadId,
            input.expectedThreadVersion,
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
          this.store.reviewSnapshot(reviewId, input.reviewVersion);
          const messages: HostMessage[] = [];
          for (const selection of input.drafts) {
            const draft = this.store.draft(
              reviewId,
              selection.draftId,
              access.principal.id,
            );
            if (draft.draftVersion !== selection.expectedDraftVersion)
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
              selection.expectedDraftVersion,
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
                  reviewVersion: input.reviewVersion,
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
            reviewVersion: input.reviewVersion,
            decision: input.decision,
            createdBy: access.principal.id,
            createdAt: now,
            threadIds: messages.map((message) => message.threadId),
            messageIds: messages.map((message) => message.id),
          };
          this.store.putSubmission(submission);
          this.store.appendEvent(reviewId, "feedback.submitted", {
            submission,
          });
          return submission;
        };
      }
      case "question.start": {
        const input = request.input;
        const harness = await this.resolveHarness(input.harness);
        const evidence = await this.targetEvidence(reviewId, input.target);
        const document = this.store.document(
          reviewId,
          input.target.reviewVersion,
        );
        const threadId = randomUUID();
        const context = this.freezeContext(
          document,
          input.target,
          {
            threadId,
            reviewVersion: document.reviewVersion,
            status: "exact",
            target: input.target,
            evidence,
          },
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
            threadId,
          );
          const run = this.createRun(
            created.thread,
            created.message,
            context,
            harness,
            access.principal,
            now,
          );
          return { ...created, run };
        };
      }
      case "question.follow_up": {
        const input = request.input;
        const harness = await this.resolveHarness(input.harness);
        const document = this.store.document(reviewId, input.reviewVersion);
        const mapping = await this.mapping(
          reviewId,
          input.threadId,
          input.reviewVersion,
        );
        return () => {
          const thread = this.store.thread(reviewId, input.threadId);
          const context = this.freezeContext(
            document,
            thread.target,
            mapping,
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
            harness,
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
          this.complete(reviewId, input.runId, input.body, access.principal);
      }
      case "attention.update": {
        const input = request.input;
        return () => {
          const before = this.store.attention(reviewId, access.principal.id);
          if (input.lastViewedReviewVersion !== undefined)
            this.store.reviewSnapshot(reviewId, input.lastViewedReviewVersion);
          if (
            input.lastViewedReviewVersion === undefined &&
            (input.pinned === undefined || input.pinned === before.pinned)
          ) {
            if (input.expectedAttentionVersion !== before.attentionVersion)
              throw new HostStoreError(
                "VERSION_CONFLICT",
                "The attention state changed. Refresh before updating it.",
              );
            return before;
          }
          const attention = this.store.updateAttention(
            {
              ...before,
              attentionVersion: before.attentionVersion + 1,
              pinned: input.pinned ?? before.pinned,
              lastViewedReviewVersion:
                input.lastViewedReviewVersion === undefined
                  ? before.lastViewedReviewVersion
                  : input.lastViewedReviewVersion,
              lastViewedAt:
                input.lastViewedReviewVersion === undefined
                  ? before.lastViewedAt
                  : now,
            },
            input.expectedAttentionVersion,
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
          (sequence) =>
            this.store.drafts(input.reviewId, principal.id, sequence),
          request.input,
          `drafts:${input.reviewId}:${principal.id}`,
          this.store.feedbackSequence("drafts", input.reviewId, principal.id),
        );
      case "threads.list":
        return feedbackPage(
          (sequence) =>
            this.store
              .threads(input.reviewId, sequence)
              .filter(
                (thread) =>
                  !request.input.status ||
                  thread.status === request.input.status,
              ),
          request.input,
          `threads:${input.reviewId}:${request.input.status ?? "all"}`,
          this.store.feedbackSequence("threads", input.reviewId),
        );
      case "thread.get":
        return {
          thread: this.store.thread(input.reviewId, request.input.threadId),
          messages: feedbackPage(
            (sequence) =>
              this.store
                .messages(input.reviewId, request.input.threadId)
                .filter((message) => message.ordinal <= sequence),
            request.input,
            `messages:${input.reviewId}:${request.input.threadId}`,
            this.store.messages(input.reviewId, request.input.threadId).at(-1)
              ?.ordinal ?? 0,
            true,
          ),
        };
      case "feedback.list":
        return feedbackPage(
          (sequence) => this.store.submissions(input.reviewId, sequence),
          request.input,
          `submissions:${input.reviewId}`,
          this.store.feedbackSequence("submissions", input.reviewId),
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
          (sequence) =>
            this.store
              .questionRuns(input.reviewId, sequence)
              .filter(
                (run) =>
                  !request.input.threadId ||
                  run.threadId === request.input.threadId,
              ),
          request.input,
          `questions:${input.reviewId}:${request.input.threadId ?? "all"}`,
          this.store.feedbackSequence("questions", input.reviewId),
        );
      case "attention.get":
        return this.store.attention(input.reviewId, principal.id);
    }
  }

  async mapping(
    reviewId: string,
    threadId: string,
    reviewVersion: number,
  ): Promise<HostThreadMapping> {
    const thread = this.store.thread(reviewId, threadId);
    const original = this.store.document(reviewId, thread.target.reviewVersion);
    const current = this.store.document(reviewId, reviewVersion);
    const missing = (
      reason: Extract<HostThreadMapping, { status: "missing" }>["reason"],
    ) => missingMapping(threadId, reviewVersion, reason);
    // A selected commit remains a selected-commit comparison. It may be shown
    // on another version only when that comparison belongs to that version.
    if (thread.target.kind === "source" && thread.target.comparisonCommit) {
      const comparisonCommit = thread.target.comparisonCommit;
      const samePins =
        original.binding.repositoryId === current.binding.repositoryId &&
        original.binding.baseCommit === current.binding.baseCommit &&
        original.binding.headCommit === current.binding.headCommit;
      if (!samePins) {
        if (current.binding.baseCommit === current.binding.headCommit)
          return missing("comparison_not_available");
        try {
          const commits = await this.source.commits(current.binding);
          if (!commits.some((commit) => commit.oid === comparisonCommit))
            return missing("comparison_not_available");
        } catch (error) {
          if (
            !(error instanceof EvidenceProviderError) &&
            !(error instanceof HostStoreError)
          )
            throw error;
          return missing("source_unavailable");
        }
      }
      return {
        threadId,
        reviewVersion,
        status: "exact",
        target: { ...thread.target, reviewVersion },
        evidence: thread.evidence,
      };
    }
    if (thread.target.kind !== "source") {
      // Selection quotes refer to the observed content. Without a proven text
      // relocation, do not claim an edited node/document is an exact mapping.
      const selected = thread.target;
      if (
        (selected.kind === "node" || selected.kind === "document") &&
        selected.selection &&
        (selected.kind === "document"
          ? original.contentHash !== current.contentHash
          : canonicalHostJson(original.nodes[selected.nodeId] ?? null) !==
            canonicalHostJson(current.nodes[selected.nodeId] ?? null))
      )
        return missing("selection_changed");
      if ("nodeId" in selected) {
        const before = original.nodes[selected.nodeId];
        const after = current.nodes[selected.nodeId];
        if (!after) return missing("target_removed");
        if (before?.type !== after.type) return missing("identity_mismatch");
        if (
          selected.kind === "diagram" &&
          before.type === "software_map" &&
          after.type === "software_map"
        ) {
          const beforeMap = this.store.mapVersion(
            reviewId,
            before.mapVersionId,
          );
          const afterMap = this.store.mapVersion(reviewId, after.mapVersionId);
          if (beforeMap.mapId !== afterMap.mapId)
            return missing("identity_mismatch");
        }
      }
      try {
        const evidence = await this.targetEvidence(reviewId, {
          ...thread.target,
          reviewVersion,
        });
        return {
          threadId,
          reviewVersion,
          status: "exact",
          target: { ...thread.target, reviewVersion },
          evidence,
        };
      } catch (error) {
        if (
          !(error instanceof HostStoreError) &&
          !(error instanceof EvidenceProviderError)
        )
          throw error;
        return missing(
          error.code === "NOT_FOUND" ? "target_removed" : "source_unavailable",
        );
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
        reviewVersion,
        status: "exact",
        target: { ...thread.target, reviewVersion },
        evidence: retained,
      };

    try {
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
      if (!mapped.proposed || mapped.status === "missing")
        return missing("selection_changed");
      const target: HostFeedbackTarget = {
        kind: "source",
        reviewVersion,
        range: mapped.proposed,
      };
      const evidence = await this.targetEvidence(reviewId, target);
      return {
        threadId,
        reviewVersion,
        status: mapped.status,
        target,
        evidence,
      };
    } catch (error) {
      if (
        !(error instanceof HostStoreError) &&
        !(error instanceof EvidenceProviderError)
      )
        throw error;
      return missing("source_unavailable");
    }
  }

  /** Called only inside a host command transaction, including executor callbacks. */
  complete(
    reviewId: string,
    runId: string,
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
      if (!message || message.body !== body)
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
        id: randomUUID(),
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
    threadId = randomUUID(),
  ) {
    this.mutableReview(reviewId);
    const thread: HostThread = {
      id: threadId,
      reviewId,
      threadVersion: 0,
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
    const document = this.store.document(reviewId, target.reviewVersion);
    if (target.kind === "document") return null;
    if (target.kind === "source") {
      if (target.comparisonCommit)
        return this.source.quote(
          document.binding,
          target.range,
          target.comparisonCommit,
        );
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
      const anchorId = this.diagramAnchor(reviewId, node, target.item);
      return anchorId ? (document.evidence[anchorId] ?? null) : null;
    }
    return node.type === "code_peek"
      ? (document.evidence[node.anchorId] ?? null)
      : null;
  }

  private diagramAnchor(
    reviewId: string,
    node: HostNode,
    item: HostDiagramItem,
  ): string | null {
    switch (item.kind) {
      case "actor":
        if (
          node.type === "sequence" &&
          node.messages.some(
            (message) =>
              message.fromActorId === item.actorId ||
              message.toActorId === item.actorId,
          )
        )
          return null;
        break;
      case "message": {
        const message =
          node.type === "sequence" &&
          node.messages.find((message) => message.id === item.messageId);
        if (message)
          return message.evidence.kind === "anchor"
            ? message.evidence.anchorId
            : null;
        break;
      }
      case "frame": {
        const frame =
          node.type === "call_stack_diff" &&
          node[item.side].find((frame) => frame.id === item.frameId);
        if (frame) return frame.anchorId;
        break;
      }
      case "use_case":
        if (
          node.type === "database_lens" &&
          node.useCases.some((useCase) => useCase.id === item.useCaseId)
        )
          return null;
        break;
      case "operation": {
        const operation =
          node.type === "database_lens" &&
          node.useCases
            .find((useCase) => useCase.id === item.useCaseId)
            ?.operations.find((operation) => operation.id === item.operationId);
        if (operation) return operation.anchorId;
        break;
      }
      case "map_element":
        if (
          node.type === "software_map" &&
          Object.hasOwn(
            this.store.mapVersion(reviewId, node.mapVersionId).elements,
            item.elementId,
          )
        )
          return null;
        break;
      case "map_relationship":
        if (
          node.type === "software_map" &&
          Object.hasOwn(
            this.store.mapVersion(reviewId, node.mapVersionId).relationships,
            item.relationshipId,
          )
        )
          return null;
        break;
    }
    throw new HostStoreError(
      "NOT_FOUND",
      "The selected diagram item is not in the observed node.",
    );
  }

  private freezeContext(
    document: HostDocumentState,
    target: HostFeedbackTarget,
    viewedTarget: HostThreadMapping,
    question: string,
    messages: HostMessage[],
  ): HostQuestionContext {
    const review = this.store.reviewSnapshot(
      document.reviewId,
      document.reviewVersion,
    );
    // Bounded excerpts are explicitly labelled. The immutable version/target is
    // available through API reads when the fresh agent needs more detail.
    const viewed = viewedTarget.target;
    const { evidence, ...mapping } = viewedTarget;
    const selected =
      viewed && "nodeId" in viewed
        ? (document.nodes[viewed.nodeId] ?? document)
        : document;
    const material: HostQuestionContext["material"] = {
      schemaVersion: 1,
      review: { title: excerpt(review.title, 1_000) },
      binding: {
        repositoryId: document.binding.repositoryId,
        baseCommit: document.binding.baseCommit,
        headCommit: document.binding.headCommit,
      },
      mapVersions: review.mapVersions,
      originalTarget: target,
      viewedTarget: mapping,
      sourceEvidence: evidence
        ? {
            span: evidence.span,
            text: excerpt(evidence.text, 4_000),
            sha256: evidence.sha256,
          }
        : null,
      documentJson: excerpt(canonicalHostJson(selected), 8_000),
      priorMessages: messages.slice(-8).map((message) => ({
        id: message.id,
        author: message.author,
        body: excerpt(message.body, 1_000),
      })),
      priorMessagesOmitted: Math.max(0, messages.length - 8),
    };
    const context: HostQuestionContext = {
      id: randomUUID(),
      reviewId: document.reviewId,
      reviewVersion: document.reviewVersion,
      question,
      material,
    };
    // JSON escaping can expand otherwise bounded text. Leave room for executor instructions.
    const tooLarge = () =>
      Buffer.byteLength(canonicalHostJson(context)) > 56 * 1024;
    const omitted = { state: "omitted", reason: "context_limit" } as const;
    if (tooLarge()) material.documentJson = omitted;
    if (tooLarge()) {
      material.priorMessagesOmitted += material.priorMessages.length;
      material.priorMessages = [];
    }
    if (tooLarge() && material.sourceEvidence)
      material.sourceEvidence.text = omitted;
    if (tooLarge()) material.review.title = omitted;
    if (tooLarge())
      throw new EvidenceProviderError(
        "RESOURCE_LIMIT",
        "The question and its required target context exceed 56 KiB.",
      );
    return HostQuestionContextSchema.parse(context);
  }

  private async resolveHarness(
    requested: HostQuestionRun["harness"] | undefined,
  ): Promise<HostQuestionRun["harness"]> {
    if (requested) return requested;
    const available = [
      ...new Set((await this.questions?.capabilities()) ?? []),
    ];
    const configured = this.questions?.defaultHarness?.();
    if (configured && available.includes(configured)) return configured;
    if (available.length === 1) return available[0]!;
    invalid(
      "Choose an available question harness explicitly; no default is configured.",
    );
  }

  private mutableReview(reviewId: string) {
    const review = this.store.review(reviewId);
    if (review.deletedAt !== null || review.state === "closed")
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
function excerpt(value: string, bytes: number): HostQuestionExcerpt {
  if (Buffer.byteLength(value) <= bytes)
    return { state: "complete", text: value };
  const prefix = Buffer.from(value).subarray(0, bytes);
  return {
    state: "truncated",
    text: prefix.toString("utf8").replace(/\ufffd$/, ""),
  };
}
function missingMapping(
  threadId: string,
  reviewVersion: number,
  reason: Extract<HostThreadMapping, { status: "missing" }>["reason"],
): HostThreadMapping {
  return {
    threadId,
    reviewVersion,
    status: "missing",
    target: null,
    evidence: null,
    reason,
  };
}
const feedbackCursorSchema = z.object({
  scope: z.string(),
  sequence: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  afterId: z.string(),
});

function feedbackPage<T extends JsonValue & { id: string }>(
  read: (sequence: number) => T[],
  input: { cursor?: string; limit?: number },
  scope: string,
  latestSequence: number,
  messages = false,
) {
  let sequence = latestSequence;
  let afterId: string | undefined;
  if (input.cursor) {
    try {
      const cursor = feedbackCursorSchema.parse(
        JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8")),
      );
      if (cursor.scope !== scope || cursor.sequence > latestSequence)
        throw new Error("Invalid feedback cursor");
      sequence = cursor.sequence;
      afterId = cursor.afterId;
    } catch {
      throw new HostStoreError(
        "CURSOR_EXPIRED",
        "This cursor cannot continue the selected collection. Refresh before continuing.",
      );
    }
  }
  const items = read(sequence);
  if (!messages)
    items.sort(
      (a, b) =>
        String("createdAt" in b ? b.createdAt : "").localeCompare(
          String("createdAt" in a ? a.createdAt : ""),
        ) || b.id.localeCompare(a.id),
    );
  let start = 0;
  if (afterId) {
    const index = items.findIndex((item) => item.id === afterId);
    if (index < 0)
      throw new HostStoreError(
        "CURSOR_EXPIRED",
        "Refresh this collection before continuing.",
      );
    start = index + 1;
  }
  const selected = items.slice(start, start + (input.limit ?? 100));
  const last = selected.at(-1);
  return {
    items: selected,
    nextCursor:
      last && start + selected.length < items.length
        ? Buffer.from(
            JSON.stringify({ scope, sequence, afterId: last.id }),
          ).toString("base64url")
        : null,
  };
}
