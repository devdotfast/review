import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  appendReviewAgentMessage,
  appendReviewComment,
  appendReviewCommentDraft,
  deleteReviewComment,
  deleteReviewCommentMessage,
  readReviewCommentDrafts,
  readReviewComments,
  reviewHistoryDocDir,
  reviewHistorySubmissionsDir,
  reviewStateDir,
  saveReviewDocHistory,
  saveReviewSubmissionAudit,
  submitReviewCommentDrafts,
  updateReviewComment,
} from "./review-state-store";
import {
  closeAllReviewThreadStores,
  reviewThreadDbPath,
} from "./review-thread-store-backend";
import type { ReviewSubmissionEvent, ThreadTarget } from "./types";

const roots: string[] = [];

afterEach(() => {
  closeAllReviewThreadStores();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function tempRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "review-state-store-"));
  roots.push(root);
  return root;
}

const target: ThreadTarget = {
  kind: "text",
  surface: { type: "block", tag: "p", index: 0, blockHash: "abc12345" },
  selection: { start: 0, length: 5, hash: "f55c314b", quote: "Hello" },
};

function makeReviewPath(): string {
  const reviewPath = path.join(tempRoot(), "current", "review.mdx");
  return reviewPath;
}

describe("reviewStateDir", () => {
  it("keeps the default review's state beside review.mdx in reviews/current", () => {
    const mdx = path.join("/repo", "reviews", "current", "review.mdx");
    expect(reviewStateDir(mdx)).toBe(path.join("/repo", "reviews", "current"));
  });

  it("keeps every UUID review's state beside its document", () => {
    const mdx = path.join(
      "/home/.dev/reviews",
      "3b241101-e2bb-4255-8caf-4136c566a962",
      "review.mdx",
    );
    expect(reviewStateDir(mdx)).toBe(path.dirname(mdx));
  });
});
describe("comment persistence", () => {
  it("returns an empty map before anything is written", () => {
    const reviewPath = makeReviewPath();
    expect(readReviewComments(reviewPath)).toEqual({});
  });

  it("keeps two threads on one target separate and replies by thread id", () => {
    const reviewPath = makeReviewPath();

    const created = appendReviewComment(reviewPath, {
      threadId: "thread-a",
      messageId: "message-a1",
      target,
      body: "First note",
      author: "Reviewer",
    });
    expect(created.threadId).toBe("thread-a");
    expect(created.thread.status).toBe("open");
    expect(created.thread.messages).toHaveLength(1);
    expect(created.thread.messages[0]).toMatchObject({
      id: "message-a1",
      by: "Reviewer",
      body: "First note",
    });

    appendReviewComment(reviewPath, {
      threadId: "thread-b",
      messageId: "message-b1",
      target,
      body: "Separate note",
      author: "Reviewer",
    });
    appendReviewComment(reviewPath, {
      threadId: "thread-a",
      messageId: "message-a2",
      target,
      body: "Reply",
      author: "Reviewer",
    });

    const comments = readReviewComments(reviewPath);
    expect(Object.keys(comments)).toEqual(["thread-a", "thread-b"]);
    expect(
      comments["thread-a"].messages.map((message) => message.body),
    ).toEqual(["First note", "Reply"]);
    expect(
      comments["thread-b"].messages.map((message) => message.body),
    ).toEqual(["Separate note"]);

    expect(existsSync(reviewThreadDbPath(reviewPath))).toBe(true);
  });

  it("dedupes retried messages by client-generated id", () => {
    const reviewPath = makeReviewPath();
    appendReviewComment(reviewPath, {
      threadId: "thread-a",
      messageId: "message-a1",
      target,
      body: "First delivery",
      author: "Reviewer",
    });
    const retried = appendReviewComment(reviewPath, {
      threadId: "thread-a",
      messageId: "message-a1",
      target,
      body: "Retry body is ignored",
      author: "Reviewer",
    });
    expect(retried.thread.messages).toHaveLength(1);
    expect(retried.thread.messages[0]?.body).toBe("First delivery");
  });

  it("throws when a thread id is reused with a different target", () => {
    const reviewPath = makeReviewPath();
    appendReviewComment(reviewPath, {
      threadId: "thread-a",
      messageId: "message-a1",
      target,
      body: "First",
      author: "Reviewer",
    });
    expect(() =>
      appendReviewComment(reviewPath, {
        threadId: "thread-a",
        messageId: "message-a2",
        target: {
          ...target,
          selection: { ...target.selection, quote: "Other" },
        },
        body: "Second",
        author: "Reviewer",
      }),
    ).toThrow(/different content/i);
  });

  it("rejects missing ids and targets", () => {
    const reviewPath = makeReviewPath();
    expect(() =>
      appendReviewComment(reviewPath, {
        threadId: "   ",
        messageId: "message-a1",
        target,
        body: "x",
        author: "Reviewer",
      }),
    ).toThrow(/threadId/i);
    expect(() =>
      appendReviewComment(reviewPath, {
        threadId: "thread-a",
        messageId: " ",
        target,
        body: "x",
        author: "Reviewer",
      }),
    ).toThrow(/messageId/i);
  });

  it("updates only the last message body and only when a non-empty body is given", () => {
    const reviewPath = makeReviewPath();
    appendReviewComment(reviewPath, {
      threadId: "thread-a",
      messageId: "message-a1",
      target,
      body: "one",
      author: "Reviewer",
    });
    appendReviewComment(reviewPath, {
      threadId: "thread-a",
      messageId: "message-a2",
      target,
      body: "two",
      author: "Reviewer",
    });

    // Whitespace-only body leaves text untouched but still applies status.
    expect(
      updateReviewComment(reviewPath, "thread-a", {
        status: "resolved",
        body: "   ",
      }),
    ).toBe(true);
    let comments = readReviewComments(reviewPath);
    expect(comments["thread-a"].status).toBe("resolved");
    expect(
      comments["thread-a"].messages.map((message) => message.body),
    ).toEqual(["one", "two"]);

    expect(
      updateReviewComment(reviewPath, "thread-a", { body: "two-edited" }),
    ).toBe(true);
    comments = readReviewComments(reviewPath);
    expect(
      comments["thread-a"].messages.map((message) => message.body),
    ).toEqual(["one", "two-edited"]);

    expect(updateReviewComment(reviewPath, "missing", { body: "x" })).toBe(
      false,
    );
  });

  it("updates an exact message id and errors when it is not in the thread", () => {
    const reviewPath = makeReviewPath();
    appendReviewComment(reviewPath, {
      threadId: "thread-a",
      messageId: "message-a1",
      target,
      body: "one",
      author: "Reviewer",
    });
    appendReviewComment(reviewPath, {
      threadId: "thread-a",
      messageId: "message-a2",
      target,
      body: "two",
      author: "Reviewer",
    });

    expect(
      updateReviewComment(reviewPath, "thread-a", {
        messageId: "message-a1",
        body: "one-edited",
      }),
    ).toBe(true);
    expect(
      readReviewComments(reviewPath)["thread-a"].messages.map(
        (message) => message.body,
      ),
    ).toEqual(["one-edited", "two"]);
    expect(() =>
      updateReviewComment(reviewPath, "thread-a", {
        messageId: "message-missing",
        body: "no fallback",
      }),
    ).toThrow(/message-missing.*thread-a/i);
    expect(
      readReviewComments(reviewPath)["thread-a"].messages.map(
        (message) => message.body,
      ),
    ).toEqual(["one-edited", "two"]);
  });

  it("deletes a comment and reports whether it existed", () => {
    const reviewPath = makeReviewPath();
    appendReviewComment(reviewPath, {
      threadId: "thread-a",
      messageId: "message-a1",
      target,
      body: "one",
      author: "Reviewer",
    });
    expect(deleteReviewComment(reviewPath, "thread-a")).toBe(true);
    expect(readReviewComments(reviewPath)["thread-a"]).toBeUndefined();
    expect(deleteReviewComment(reviewPath, "thread-a")).toBe(false);
  });

  it("deletes exactly one comment message", () => {
    const reviewPath = makeReviewPath();
    appendReviewComment(reviewPath, {
      threadId: "thread-a",
      messageId: "message-a1",
      target,
      body: "one",
      author: "Reviewer",
    });
    appendReviewComment(reviewPath, {
      threadId: "thread-a",
      messageId: "message-a2",
      target,
      body: "two",
      author: "Reviewer",
    });

    expect(
      deleteReviewCommentMessage(reviewPath, "thread-a", "message-a1"),
    ).toBe(true);
    expect(
      readReviewComments(reviewPath)["thread-a"].messages.map(
        (message) => message.id,
      ),
    ).toEqual(["message-a2"]);
  });

  it("deletes the thread when its last message is deleted", () => {
    const reviewPath = makeReviewPath();
    appendReviewComment(reviewPath, {
      threadId: "thread-a",
      messageId: "message-a1",
      target,
      body: "one",
      author: "Reviewer",
    });

    expect(
      deleteReviewCommentMessage(reviewPath, "thread-a", "message-a1"),
    ).toBe(true);
    expect(readReviewComments(reviewPath)["thread-a"]).toBeUndefined();
    expect(
      deleteReviewCommentMessage(reviewPath, "thread-missing", "message-a1"),
    ).toBe(false);
  });

  it("throws when deleting an unknown message from an existing thread", () => {
    const reviewPath = makeReviewPath();
    appendReviewComment(reviewPath, {
      threadId: "thread-a",
      messageId: "message-a1",
      target,
      body: "one",
      author: "Reviewer",
    });

    expect(() =>
      deleteReviewCommentMessage(reviewPath, "thread-a", "message-missing"),
    ).toThrow(/message-missing.*thread-a/i);
    expect(readReviewComments(reviewPath)["thread-a"].messages).toHaveLength(1);
  });
});

describe("agent comment messages", () => {
  it("keeps agent replies out of inputs before and after submission", () => {
    const reviewPath = makeReviewPath();
    const input = {
      threadId: "thread-agent",
      messageId: "message-reviewer",
      target,
      body: "Why does this work?",
    };
    appendReviewCommentDraft(reviewPath, { ...input, author: "Reviewer" });

    expect(
      appendReviewAgentMessage(reviewPath, input.threadId, {
        id: "message-agent-1",
        by: "Codex",
        at: "2026-08-11T00:00:00.000Z",
        body: "It uses the durable draft.",
        role: "agent",
        format: "markdown",
      })?.location,
    ).toBe("draft");
    expect(readReviewCommentDrafts(reviewPath)[input.threadId].inputs).toEqual([
      input,
    ]);

    submitReviewCommentDrafts(reviewPath, [input]);
    expect(
      appendReviewAgentMessage(reviewPath, input.threadId, {
        id: "message-agent-2",
        by: "Codex",
        at: "2026-08-11T00:00:01.000Z",
        body: "The thread remains durable after submission.",
        role: "agent",
        format: "markdown",
      })?.location,
    ).toBe("comment");
    expect(
      readReviewComments(reviewPath)[input.threadId].messages.map((message) =>
        message.role === "agent" ? message.id : "reviewer",
      ),
    ).toEqual(["reviewer", "message-agent-1", "message-agent-2"]);
  });
});

describe("document history + submission audit", () => {
  it("writes numbered, zero-padded doc snapshots and dedups no-op rounds", () => {
    const reviewPath = path.join(tempRoot(), "current", "review.mdx");

    const first = saveReviewDocHistory(reviewPath, "# v1\n");
    expect(first).toMatchObject({ version: 1, isNew: true });
    expect(first.path).toBe(
      path.join(reviewHistoryDocDir(reviewPath), "001.mdx"),
    );

    // Identical content re-run does not create a new version.
    const dup = saveReviewDocHistory(reviewPath, "# v1\n");
    expect(dup).toMatchObject({ version: 1, isNew: false });

    // Changed content bumps to 002.
    const second = saveReviewDocHistory(reviewPath, "# v2\n");
    expect(second).toMatchObject({ version: 2, isNew: true });
    expect(second.path).toBe(
      path.join(reviewHistoryDocDir(reviewPath), "002.mdx"),
    );

    expect(readFileSync(second.path, "utf8")).toBe("# v2\n");
    const entries = readdirSync(reviewHistoryDocDir(reviewPath)).sort();
    expect(entries).toEqual(["001.mdx", "002.mdx"]);
  });

  it("appends a submission event to the audit trail", () => {
    const reviewPath = path.join(tempRoot(), "current", "review.mdx");
    const event: ReviewSubmissionEvent = {
      id: "submission-1",
      decision: "request-changes",
      createdAt: "2026-01-02T03:04:05.678Z",
      rootPath: "/repo",
      reviewPath,
      documentRoute: "/",
      comments: [],
      prompt: "address the comments",
    };

    const filePath = saveReviewSubmissionAudit(reviewPath, event);
    expect(path.dirname(filePath)).toBe(
      reviewHistorySubmissionsDir(reviewPath),
    );
    // Filename is derived from the timestamp + id (no ":" or "." from the ISO).
    expect(path.basename(filePath)).toBe(
      "2026-01-02T03-04-05-678Z-submission-1.json",
    );
    expect(
      JSON.parse(readFileSync(filePath, "utf8")) as ReviewSubmissionEvent,
    ).toMatchObject({ id: "submission-1", prompt: "address the comments" });
  });
});
