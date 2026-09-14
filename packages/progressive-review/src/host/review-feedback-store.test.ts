import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  type HostDraft,
  type HostFeedbackSubmission,
  type HostMessage,
  type HostPrincipal,
  type HostQuestionContext,
  type HostQuestionRun,
  type HostReviewState,
  type HostThread,
} from "@dev.fast/review-protocol";
import { afterEach, describe, expect, it } from "vitest";

import {
  type HostPreparedDocument,
  ReviewHostStore,
} from "./review-host-store.js";

const directories: string[] = [];
const stores = new Set<ReviewHostStore>();
const at = "2026-09-10T12:00:00.000Z";
const later = "2026-09-10T12:01:00.000Z";

afterEach(() => {
  for (const store of stores) store.close();
  stores.clear();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function open(databasePath: string) {
  const store = new ReviewHostStore(databasePath);
  stores.add(store);
  return store;
}

function write<T>(store: ReviewHostStore, action: () => T): T {
  let result!: T;
  store.command(
    {
      clientId: "feedback-store-test",
      commandId: randomUUID(),
      request: { type: "test.feedback" },
    },
    () => {
      result = action();
      return null;
    },
  );
  return result;
}

function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "review-feedback-store-"));
  directories.push(directory);
  const databasePath = path.join(directory, "review.db");
  let store = open(databasePath);
  const repositoryId = randomUUID();
  const human: HostPrincipal = {
    id: randomUUID(),
    kind: "human",
    displayName: "Reader",
  };
  const other: HostPrincipal = {
    id: randomUUID(),
    kind: "human",
    displayName: "Teammate",
  };
  const assistant: HostPrincipal = {
    id: randomUUID(),
    kind: "agent",
    displayName: "Answerer",
  };
  const text = "export const value = 1;";
  const prepared: HostPreparedDocument = {
    document: {
      schemaVersion: 1,
      roots: ["source"],
      nodes: {
        source: { id: "source", type: "code_peek", anchorId: "source" },
      },
      definitions: {
        source: {
          kind: "anchor",
          title: "Original code",
          source: {
            side: "head",
            file: "src/value.ts",
            fromLine: 1,
            toLine: 1,
          },
        },
      },
    },
    binding: {
      id: randomUUID(),
      repositoryId,
      selector: { kind: "range", baseRef: "main", headRef: "work" },
      baseCommit: "1".repeat(40),
      headCommit: "2".repeat(40),
      createdAt: at,
    },
    evidence: {
      source: {
        span: {
          repositoryId,
          commit: "2".repeat(40),
          blob: "3".repeat(40),
          file: "src/value.ts",
          fromLine: 1,
          toLine: 1,
        },
        text,
        sha256: createHash("sha256").update(text).digest("hex"),
      },
    },
  };
  write(store, () =>
    store.registerRepository({
      id: repositoryId,
      displayName: "Source",
      vcs: "git",
      localPath: directory,
    }),
  );
  const createReview = () => {
    const review: HostReviewState = {
      id: randomUUID(),
      repositoryId,
      stateVersion: 0,
      state: "open",
      latestReviewVersion: 0,
      createdBy: human.id,
      createdAt: at,
      deletedAt: null,
    };
    write(store, () =>
      store.createReview(review, prepared, {
        title: "Feedback",
        description: "",
        labels: [],
        mapVersions: { base: null, head: null },
      }),
    );
    return review;
  };
  const review = createReview();
  const draft = (principalId = human.id): HostDraft => ({
    id: randomUUID(),
    reviewId: review.id,
    principalId,
    draftVersion: 0,
    target: { kind: "node", reviewVersion: 0, nodeId: "source" },
    evidence: prepared.evidence.source!,
    body: "Could this race?",
    createdAt: at,
    updatedAt: at,
  });
  const thread = (): HostThread => ({
    id: randomUUID(),
    reviewId: review.id,
    threadVersion: 0,
    target: { kind: "node", reviewVersion: 0, nodeId: "source" },
    evidence: prepared.evidence.source!,
    status: "open",
    createdBy: human.id,
    createdAt: at,
    updatedAt: at,
  });
  const message = (threadId: string): Omit<HostMessage, "ordinal"> => ({
    id: randomUUID(),
    threadId,
    author: human,
    body: "Could this race?",
    replyToMessageId: null,
    questionRunId: null,
    createdAt: at,
  });
  const question = (existingThread?: HostThread) =>
    write(store, () => {
      const targetThread = existingThread ?? store.createThread(thread());
      const asked = store.appendMessage(review.id, message(targetThread.id));
      const context: HostQuestionContext = {
        id: randomUUID(),
        reviewId: review.id,
        reviewVersion: 0,
        question: asked.body,
        material: {
          schemaVersion: 1,
          review: { title: { state: "complete", text: "Feedback" } },
          binding: {
            repositoryId,
            baseCommit: prepared.binding.baseCommit,
            headCommit: prepared.binding.headCommit,
          },
          mapVersions: { base: null, head: null },
          originalTarget: targetThread.target,
          viewedTarget: {
            threadId: targetThread.id,
            reviewVersion: 0,
            status: "exact",
            target: targetThread.target,
          },
          sourceEvidence: {
            ...prepared.evidence.source!,
            text: { state: "complete", text: prepared.evidence.source!.text },
          },
          documentJson: {
            state: "complete",
            text: JSON.stringify(prepared.document),
          },
          priorMessages: [],
          priorMessagesOmitted: 0,
        },
      };
      store.putQuestionContext(context);
      const run: HostQuestionRun = {
        id: randomUUID(),
        reviewId: review.id,
        threadId: targetThread.id,
        questionId: asked.id,
        contextId: context.id,
        requestedBy: human.id,
        assistant,
        harness: "codex",
        state: "pending",
        sessionId: null,
        answerMessageId: null,
        error: null,
        createdAt: at,
        updatedAt: at,
      };
      store.createQuestionRun(run);
      return { thread: targetThread, asked, context, run };
    });
  return {
    get store() {
      return store;
    },
    databasePath,
    review,
    human,
    other,
    assistant,
    prepared,
    draft,
    thread,
    message,
    question,
    createReview,
    restart() {
      store.close();
      stores.delete(store);
      store = open(databasePath);
    },
    closeReview(trashed = false) {
      write(store, () =>
        store.updateReviewState(
          review.id,
          store.review(review.id).stateVersion,
          (before) => ({
            ...before,
            state: trashed ? before.state : "closed",
            deletedAt: trashed ? later : null,
          }),
        ),
      );
    },
  };
}

describe("feedback persistence", () => {
  it("keeps drafts private across principals, reviews, and restart", () => {
    const f = fixture();
    const first = f.draft();
    const second = f.draft(f.other.id);
    write(f.store, () => {
      f.store.saveDraft(first, null);
      f.store.saveDraft(second, null);
    });
    const unrelated = f.createReview();
    f.restart();
    expect(f.store.drafts(f.review.id, f.human.id)).toEqual([first]);
    expect(f.store.drafts(f.review.id, f.other.id)).toEqual([second]);
    expect(f.store.drafts(unrelated.id, f.human.id)).toEqual([]);
    expect(() => f.store.draft(f.review.id, first.id, f.other.id)).toThrow(
      "Draft not found",
    );
    expect(() => f.store.draft(unrelated.id, first.id, f.human.id)).toThrow(
      "Draft not found",
    );
    expect(() =>
      write(f.store, () =>
        f.store.deleteDraft(f.review.id, first.id, f.other.id, 0),
      ),
    ).toThrow("Draft not found");
    expect(() =>
      write(f.store, () =>
        f.store.saveDraft({ ...first, principalId: f.other.id }, null),
      ),
    ).toThrow("Draft not found");
    expect(f.store.draft(f.review.id, first.id, f.human.id)).toEqual(first);
  });

  it("uses draft CAS across independent connections and preserves creation identity", () => {
    const f = fixture();
    const initial = write(f.store, () => f.store.saveDraft(f.draft(), null));
    const peer = open(f.databasePath);
    const stale = peer.draft(f.review.id, initial.id, f.human.id);
    const next = {
      ...initial,
      draftVersion: 1,
      body: "Updated concern",
      updatedAt: later,
    };
    write(f.store, () => f.store.saveDraft(next, 0));
    expect(() =>
      write(peer, () =>
        peer.saveDraft({ ...stale, draftVersion: 1, body: "Lost edit" }, 0),
      ),
    ).toThrow("Draft changed");
    expect(() =>
      write(peer, () =>
        peer.deleteDraft(f.review.id, initial.id, f.human.id, 0),
      ),
    ).toThrow("Draft changed");
    expect(() =>
      write(peer, () =>
        peer.saveDraft({ ...next, draftVersion: 2, createdAt: later }, 1),
      ),
    ).toThrow("creation time");
    expect(peer.draft(f.review.id, initial.id, f.human.id)).toEqual(next);
    write(peer, () => peer.deleteDraft(f.review.id, initial.id, f.human.id, 1));
    expect(f.store.drafts(f.review.id, f.human.id)).toEqual([]);
  });

  it("keeps a thread's observed target and evidence after document and status changes", () => {
    const f = fixture();
    const original = write(f.store, () => f.store.createThread(f.thread()));
    write(f.store, () =>
      f.store.commitDocument(f.review.id, 0, {
        ...f.prepared,
        document: {
          schemaVersion: 1,
          roots: ["replacement"],
          nodes: {
            replacement: {
              id: "replacement",
              type: "markdown",
              markdown: "Source removed",
            },
          },
          definitions: {},
        },
        evidence: {},
      }),
    );
    const resolved = write(f.store, () =>
      f.store.setThreadStatus(f.review.id, original.id, 0, "resolved"),
    );
    expect(resolved).toMatchObject({
      threadVersion: 1,
      status: "resolved",
      target: original.target,
      evidence: original.evidence,
    });
    expect(() =>
      write(f.store, () =>
        f.store.setThreadStatus(f.review.id, original.id, 0, "open"),
      ),
    ).toThrow("Thread changed");
    expect(
      write(f.store, () =>
        f.store.setThreadStatus(f.review.id, original.id, 1, "resolved"),
      ),
    ).toEqual(resolved);
    f.restart();
    expect(f.store.thread(f.review.id, original.id)).toEqual(resolved);
    expect(f.store.document(f.review.id, 0).evidence.source).toEqual(
      original.evidence,
    );
    expect(f.store.document(f.review.id).reviewVersion).toBe(1);
  });

  it("orders immutable messages and deduplicates retries despite a new generated timestamp", () => {
    const f = fixture();
    const target = write(f.store, () => f.store.createThread(f.thread()));
    const input = f.message(target.id);
    const first = write(f.store, () =>
      f.store.appendMessage(f.review.id, input),
    );
    const second = write(f.store, () =>
      f.store.appendMessage(f.review.id, {
        ...f.message(target.id),
        body: "Follow-up",
        replyToMessageId: first.id,
      }),
    );
    expect(
      write(f.store, () =>
        f.store.appendMessage(f.review.id, { ...input, createdAt: later }),
      ),
    ).toEqual(first);
    for (const change of [
      { body: "Changed" },
      { author: f.other },
      { replyToMessageId: second.id },
    ]) {
      expect(() =>
        write(f.store, () =>
          f.store.appendMessage(f.review.id, { ...input, ...change }),
        ),
      ).toThrow("different content");
    }
    f.restart();
    expect(f.store.messages(f.review.id, target.id)).toEqual([first, second]);
    expect([first.ordinal, second.ordinal]).toEqual([1, 2]);
  });

  it("rejects cross-thread replies and cross-review message access without consuming ordinals", () => {
    const f = fixture();
    const first = write(f.store, () => f.store.createThread(f.thread()));
    const second = write(f.store, () => f.store.createThread(f.thread()));
    const question = write(f.store, () =>
      f.store.appendMessage(f.review.id, f.message(first.id)),
    );
    expect(() =>
      write(f.store, () =>
        f.store.appendMessage(f.review.id, {
          ...f.message(second.id),
          replyToMessageId: question.id,
        }),
      ),
    ).toThrow("same thread");
    expect(
      write(f.store, () =>
        f.store.appendMessage(f.review.id, f.message(second.id)),
      ).ordinal,
    ).toBe(1);
    expect(() => f.store.messages(f.createReview().id, first.id)).toThrow(
      "Thread not found",
    );
  });

  it("rolls draft consumption, threads, messages, submissions, and events back together", () => {
    const f = fixture();
    const draft = write(f.store, () => f.store.saveDraft(f.draft(), null));
    const target = f.thread();
    const message = f.message(target.id);
    const submission: HostFeedbackSubmission = {
      id: randomUUID(),
      reviewId: f.review.id,
      reviewVersion: 0,
      decision: "request_changes",
      createdBy: f.human.id,
      createdAt: at,
      threadIds: [target.id],
      messageIds: [message.id],
    };
    const cursor = f.store.cursor();
    const save = () => {
      f.store.createThread(target);
      f.store.appendMessage(f.review.id, message);
      f.store.deleteDraft(f.review.id, draft.id, f.human.id, 0);
      f.store.putSubmission(submission);
      f.store.appendEvent(f.review.id, "feedback.submitted", {
        submissionId: submission.id,
      });
    };
    expect(() =>
      write(f.store, () => {
        save();
        throw new Error("Injected failure");
      }),
    ).toThrow("Injected failure");
    expect(f.store.draft(f.review.id, draft.id, f.human.id)).toEqual(draft);
    expect(f.store.threads(f.review.id)).toEqual([]);
    expect(f.store.submissions(f.review.id)).toEqual([]);
    expect(f.store.cursor()).toBe(cursor);
    write(f.store, save);
    write(f.store, () => {
      f.store.appendMessage(f.review.id, {
        ...f.message(target.id),
        body: "Later reply",
      });
      f.store.setThreadStatus(f.review.id, target.id, 0, "resolved");
    });
    f.restart();
    expect(f.store.submission(f.review.id, submission.id)).toEqual(submission);
    expect(f.store.drafts(f.review.id, f.human.id)).toEqual([]);
    expect(f.store.messages(f.review.id, target.id)[0]?.ordinal).toBe(1);
  });

  it("rejects submission references to another review or the wrong thread", () => {
    const f = fixture();
    const target = write(f.store, () => f.store.createThread(f.thread()));
    const message = write(f.store, () =>
      f.store.appendMessage(f.review.id, f.message(target.id)),
    );
    const otherReview = f.createReview();
    const input: HostFeedbackSubmission = {
      id: randomUUID(),
      reviewId: f.review.id,
      reviewVersion: 0,
      decision: "comment",
      createdBy: f.human.id,
      createdAt: at,
      threadIds: [randomUUID()],
      messageIds: [message.id],
    };
    expect(() => write(f.store, () => f.store.putSubmission(input))).toThrow(
      "different thread",
    );
    expect(() =>
      write(f.store, () =>
        f.store.putSubmission({
          ...input,
          reviewId: otherReview.id,
          threadIds: [target.id],
        }),
      ),
    ).toThrow("Message not found");
    expect(f.store.submissions(f.review.id)).toEqual([]);
  });
});

describe("question attempts", () => {
  it("retains bounded, immutable, review-scoped context across restart", () => {
    const f = fixture();
    const { context } = f.question();
    expect(() =>
      write(f.store, () =>
        f.store.putQuestionContext({
          ...context,
          question: "Replace frozen question",
        }),
      ),
    ).toThrow("UNIQUE constraint failed");
    expect(() =>
      write(f.store, () =>
        f.store.putQuestionContext({
          ...context,
          id: randomUUID(),
          question: "\u0001".repeat(32 * 1024),
        }),
      ),
    ).toThrow("size limit");
    const otherReview = f.createReview();
    f.restart();
    expect(f.store.questionContext(f.review.id, context.id)).toEqual(context);
    expect(() => f.store.questionContext(otherReview.id, context.id)).toThrow(
      "Question context not found",
    );
  });

  it("allows independent questions but only one active attempt for each question", () => {
    const f = fixture();
    const first = f.question();
    const second = f.question(first.thread);
    expect(f.store.questionRuns(f.review.id)).toHaveLength(2);
    const peer = open(f.databasePath);
    expect(() =>
      write(peer, () =>
        peer.createQuestionRun({ ...first.run, id: randomUUID() }),
      ),
    ).toThrow("active attempt");
    write(f.store, () =>
      f.store.updateQuestionRun(f.review.id, first.run.id, {
        state: "failed",
        error: "Harness unavailable",
        updatedAt: later,
      }),
    );
    const retry = write(peer, () =>
      peer.createQuestionRun({ ...first.run, id: randomUUID() }),
    );
    expect(retry.contextId).toBe(first.context.id);
    expect(f.store.questionRun(f.review.id, second.run.id).state).toBe(
      "pending",
    );
    expect(() =>
      write(f.store, () =>
        f.store.createQuestionRun({ ...first.run, id: randomUUID() }),
      ),
    ).toThrow("active attempt");
  });

  it("rejects mismatched context, human assistants, and mutation of immutable run fields", () => {
    const f = fixture();
    const first = f.question();
    const second = f.question();
    for (const changed of [
      { contextId: second.context.id, questionId: second.asked.id },
      { assistant: f.human },
      { state: "running" as const },
    ]) {
      expect(() =>
        write(f.store, () =>
          f.store.createQuestionRun({
            ...first.run,
            id: randomUUID(),
            ...changed,
          }),
        ),
      ).toThrow("frozen question");
    }
    const hostile = { state: "running" as const, questionId: second.asked.id };
    expect(() =>
      write(f.store, () =>
        f.store.updateQuestionRun(f.review.id, first.run.id, hostile),
      ),
    ).toThrow("Unrecognized key");
    expect(f.store.questionRun(f.review.id, first.run.id)).toEqual(first.run);
  });

  it("validates transitions and the answer's run, author, and reply relationship", () => {
    const f = fixture();
    const { run, asked, thread } = f.question();
    write(f.store, () =>
      f.store.updateQuestionRun(f.review.id, run.id, {
        state: "running",
        sessionId: "host-session",
        updatedAt: later,
      }),
    );
    expect(() =>
      write(f.store, () =>
        f.store.updateQuestionRun(f.review.id, run.id, { state: "pending" }),
      ),
    ).toThrow("transition");
    expect(() =>
      write(f.store, () =>
        f.store.updateQuestionRun(f.review.id, run.id, { state: "completed" }),
      ),
    ).toThrow("transition");
    expect(() =>
      write(f.store, () =>
        f.store.appendMessage(f.review.id, {
          ...f.message(thread.id),
          questionRunId: run.id,
          replyToMessageId: asked.id,
        }),
      ),
    ).toThrow("active question run");
    expect(() =>
      write(f.store, () =>
        f.store.updateQuestionRun(f.review.id, run.id, {
          state: "completed",
          answerMessageId: asked.id,
        }),
      ),
    ).toThrow("does not belong");
    const answer = write(f.store, () =>
      f.store.appendMessage(f.review.id, {
        ...f.message(thread.id),
        author: f.assistant,
        body: "The transaction serializes these writes.",
        replyToMessageId: asked.id,
        questionRunId: run.id,
      }),
    );
    const completed = write(f.store, () =>
      f.store.updateQuestionRun(f.review.id, run.id, {
        state: "completed",
        answerMessageId: answer.id,
        error: null,
        updatedAt: later,
      }),
    );
    expect(
      write(f.store, () =>
        f.store.updateQuestionRun(f.review.id, run.id, {
          state: "completed",
          answerMessageId: answer.id,
        }),
      ),
    ).toEqual(completed);
    expect(() =>
      write(f.store, () =>
        f.store.updateQuestionRun(f.review.id, run.id, { state: "running" }),
      ),
    ).toThrow("terminal");
    expect(() =>
      write(f.store, () =>
        f.store.appendMessage(f.review.id, {
          ...f.message(thread.id),
          author: f.assistant,
          replyToMessageId: asked.id,
          questionRunId: run.id,
        }),
      ),
    ).toThrow("active question run");
  });

  it.each([false, true])(
    "saves accepted answers after a review is unavailable (trashed=%s)",
    (trashed) => {
      const f = fixture();
      const { run, asked, thread } = f.question();
      const draft = write(f.store, () => f.store.saveDraft(f.draft(), null));
      f.closeReview(trashed);
      expect(() =>
        write(f.store, () => f.store.saveDraft(f.draft(), null)),
      ).toThrow("Closed or trashed");
      expect(() =>
        write(f.store, () =>
          f.store.appendMessage(f.review.id, f.message(thread.id)),
        ),
      ).toThrow("Closed or trashed");
      write(f.store, () => {
        const answer = f.store.appendMessage(f.review.id, {
          ...f.message(thread.id),
          author: f.assistant,
          body: "Accepted work finishes safely.",
          replyToMessageId: asked.id,
          questionRunId: run.id,
        });
        f.store.updateQuestionRun(f.review.id, run.id, {
          state: "completed",
          answerMessageId: answer.id,
          updatedAt: later,
        });
      });
      expect(() =>
        write(f.store, () =>
          f.store.deleteDraft(f.review.id, draft.id, f.human.id, 0),
        ),
      ).toThrow("Closed or trashed");
      f.restart();
      expect(f.store.questionRun(f.review.id, run.id).state).toBe("completed");
      expect(f.store.messages(f.review.id, thread.id)).toHaveLength(2);
      expect(f.store.drafts(f.review.id, f.human.id)).toEqual([draft]);
    },
  );

  it("interrupts outstanding attempts explicitly after restart without producing its own events", () => {
    const f = fixture();
    const first = f.question();
    const second = f.question();
    const failed = f.question();
    write(f.store, () => {
      f.store.updateQuestionRun(f.review.id, second.run.id, {
        state: "running",
        sessionId: "retained-session",
      });
      f.store.updateQuestionRun(f.review.id, failed.run.id, {
        state: "failed",
        error: "Unavailable",
      });
    });
    f.restart();
    expect(f.store.questionRun(f.review.id, first.run.id).state).toBe(
      "pending",
    );
    const cursor = f.store.cursor();
    const interrupted = write(f.store, () =>
      f.store.interruptOutstandingQuestionRuns(),
    );
    expect(interrupted.map((run) => run.id)).toEqual([
      first.run.id,
      second.run.id,
    ]);
    expect(interrupted.every((run) => run.state === "interrupted")).toBe(true);
    expect(f.store.questionRun(f.review.id, second.run.id).sessionId).toBe(
      "retained-session",
    );
    expect(f.store.questionRun(f.review.id, failed.run.id).state).toBe(
      "failed",
    );
    expect(f.store.cursor()).toBe(cursor);
    expect(
      write(f.store, () => f.store.interruptOutstandingQuestionRuns()),
    ).toEqual([]);
    expect(
      write(f.store, () =>
        f.store.createQuestionRun({ ...first.run, id: randomUUID() }),
      ).state,
    ).toBe("pending");
  });
});

describe("reader-local state", () => {
  it("keeps attention independent and versioned without changing review or document versions", () => {
    const f = fixture();
    const before = f.store.review(f.review.id);
    const defaultAttention = f.store.attention(f.review.id, f.human.id);
    const next = {
      ...defaultAttention,
      attentionVersion: 1,
      pinned: true,
      lastViewedReviewVersion: 0,
      lastViewedAt: later,
    };
    write(f.store, () => f.store.updateAttention(next, 0));
    const peer = open(f.databasePath);
    expect(() =>
      write(peer, () => peer.updateAttention({ ...next, pinned: false }, 0)),
    ).toThrow("Attention changed");
    expect(f.store.attention(f.review.id, f.other.id).pinned).toBe(false);
    expect(
      f.store.attention(f.createReview().id, f.human.id).lastViewedAt,
    ).toBeNull();
    expect(f.store.review(f.review.id)).toEqual(before);
    f.closeReview();
    write(f.store, () =>
      f.store.updateAttention(
        { ...next, attentionVersion: 2, pinned: false },
        1,
      ),
    );
    f.restart();
    expect(f.store.attention(f.review.id, f.human.id)).toMatchObject({
      attentionVersion: 2,
      pinned: false,
      lastViewedReviewVersion: 0,
    });
  });

  it("rejects feedback writes outside the command transaction", () => {
    const f = fixture();
    const draft = f.draft();
    for (const action of [
      () => f.store.saveDraft(draft, null),
      () => f.store.deleteDraft(f.review.id, draft.id, f.human.id, 0),
      () => f.store.createThread(f.thread()),
      () => f.store.setThreadStatus(f.review.id, randomUUID(), 0, "resolved"),
      () => f.store.appendMessage(f.review.id, f.message(randomUUID())),
      () =>
        f.store.updateAttention(
          {
            ...f.store.attention(f.review.id, f.human.id),
            attentionVersion: 1,
          },
          0,
        ),
      () => f.store.interruptOutstandingQuestionRuns(),
    ])
      expect(action).toThrow("command transaction");
  });
});
