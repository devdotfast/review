import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it, vi } from "vitest";

import { reviewCommentPromptPrefix } from "./review-comment-agent";
import {
  appendReviewComment,
  readReviewCommentDrafts,
  readReviewComments,
} from "./review-state-store";
import {
  REVIEW_THREAD_DB_SCHEMA_VERSION,
  ReviewThreadDbVersionError,
  closeAllReviewThreadStores,
  createReviewThreadDb,
  migrateReviewThreadDb,
  reviewThreadDbPath,
} from "./review-thread-store-backend";

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  closeAllReviewThreadStores();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeReviewPath(): string {
  const root = mkdtempSync(path.join(tmpdir(), "review-thread-backend-"));
  roots.push(root);
  const dir = path.join(root, "review");
  mkdirSync(dir, { recursive: true });
  return path.join(dir, "review.mdx");
}

function seedComment(reviewPath: string): void {
  appendReviewComment(reviewPath, {
    threadId: "thread-1",
    messageId: "message-1",
    target: { kind: "document" },
    body: "note",
    author: "Reviewer",
  });
}

describe("sqlite thread store", () => {
  it("reads empty maps without creating the database", () => {
    const reviewPath = makeReviewPath();
    expect(readReviewComments(reviewPath)).toEqual({});
    expect(existsSync(reviewThreadDbPath(reviewPath))).toBe(false);
  });

  it("creates the database on first write", () => {
    const reviewPath = makeReviewPath();
    seedComment(reviewPath);
    expect(existsSync(reviewThreadDbPath(reviewPath))).toBe(true);
    expect(readReviewComments(reviewPath)["thread-1"]?.messages).toHaveLength(
      1,
    );
  });

  it("persists across a fresh connection", () => {
    const reviewPath = makeReviewPath();
    seedComment(reviewPath);
    closeAllReviewThreadStores();
    expect(Object.keys(readReviewComments(reviewPath))).toEqual(["thread-1"]);
  });

  it("round-trips records byte-identically through JSON columns", () => {
    const reviewPath = makeReviewPath();
    appendReviewComment(reviewPath, {
      threadId: "thread-unicode",
      messageId: "message-1",
      target: {
        kind: "text",
        surface: { type: "block", tag: "p", index: 3, blockHash: "abc12345" },
        selection: { start: 0, length: 5, hash: "f55c314b", quote: "héllo" },
      },
      body: 'Quotes "and" \\backslashes\\ and\nnewlines',
      author: "Reviewer",
    });
    closeAllReviewThreadStores();
    expect(readReviewComments(reviewPath)["thread-unicode"]).toMatchObject({
      target: { selection: { quote: "héllo" } },
      messages: [{ body: 'Quotes "and" \\backslashes\\ and\nnewlines' }],
    });
  });

  it("rejects a database with an unsupported schema version", () => {
    const reviewPath = makeReviewPath();
    const dbPath = reviewThreadDbPath(reviewPath);
    createReviewThreadDb(path.dirname(reviewPath));
    const db = new DatabaseSync(dbPath);
    db.prepare(
      "UPDATE meta SET value = '999' WHERE key = 'schema_version'",
    ).run();
    db.close();
    expect(() => readReviewComments(reviewPath)).toThrow(
      ReviewThreadDbVersionError,
    );
  });

  it("drops the question table through the managed v2 upgrade", async () => {
    const reviewPath = makeReviewPath();
    const dbPath = reviewThreadDbPath(reviewPath);
    createReviewThreadDb(path.dirname(reviewPath));
    closeAllReviewThreadStores();
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE questions (
        question_id TEXT PRIMARY KEY,
        record_json TEXT NOT NULL
      );
      INSERT INTO questions VALUES ('question-1', '{}');
      UPDATE meta SET value = '2' WHERE key = 'schema_version';
    `);
    db.close();

    await expect(migrateReviewThreadDb(reviewPath)).resolves.toBe("upgraded");
    const migrated = new DatabaseSync(dbPath);
    expect(
      migrated
        .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
        .get(),
    ).toEqual({ value: String(REVIEW_THREAD_DB_SCHEMA_VERSION) });
    expect(
      migrated
        .prepare(
          "SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'questions'",
        )
        .get(),
    ).toEqual({ count: 0 });
    migrated.close();
  });

  it("recovers v6 bindings and message identities without changing comment text or draft inputs", async () => {
    const reviewPath = makeReviewPath();
    createReviewThreadDb(path.dirname(reviewPath));
    closeAllReviewThreadStores();
    const db = new DatabaseSync(reviewThreadDbPath(reviewPath));
    const input = {
      threadId: "question",
      messageId: "ask",
      target: { kind: "document" },
      body: "Question",
    };
    const thread = {
      threadId: input.threadId,
      target: input.target,
      status: "open",
      agentSession: { harness: "codex", sessionId: "old-fork" },
      messages: [
        {
          id: "ask",
          by: "Reviewer",
          at: "2026-09-07T00:00:00Z",
          body: "Question",
          agentInput: true,
        },
      ],
    };
    db.prepare(
      "INSERT INTO comments (thread_id, record_json) VALUES (?, ?)",
    ).run(input.threadId, JSON.stringify(thread));
    db.prepare(
      "INSERT INTO comment_drafts (thread_id, record_json) VALUES (?, ?)",
    ).run(input.threadId, JSON.stringify({ thread, inputs: [input] }));
    db.prepare(
      "UPDATE meta SET value = '6' WHERE key = 'schema_version'",
    ).run();
    db.close();
    await expect(
      migrateReviewThreadDb(reviewPath, {
        readLegacyConversation: async () => [
          {
            id: "native-ask",
            role: "user",
            body: reviewCommentPromptPrefix("question") + "Question",
            createdAt: "2026-09-07T00:00:00Z",
          },
        ],
      }),
    ).resolves.toBe("upgraded");
    const expected = {
      ...thread,
      agentSession: { ...thread.agentSession, firstMessageId: "native-ask" },
      messages: thread.messages.map((message) => ({
        ...message,
        agentMessage: { sessionId: "old-fork", messageId: "native-ask" },
      })),
    };
    expect(readReviewComments(reviewPath).question).toEqual(expected);
    expect(readReviewCommentDrafts(reviewPath).question).toEqual({
      thread: expected,
      inputs: [input],
    });
    await expect(migrateReviewThreadDb(reviewPath)).resolves.toBe("current");
  });

  it("preserves accepted v7 boundaries while removing an unaccepted fork binding", async () => {
    const reviewPath = makeReviewPath();
    seedComment(reviewPath);
    closeAllReviewThreadStores();
    const db = new DatabaseSync(reviewThreadDbPath(reviewPath));
    const original = db.prepare("SELECT record_json FROM comments").get() as {
      record_json: string;
    };
    for (const [id, binding] of Object.entries({
      ready: { state: "ready", firstMessageId: "first" },
      followup: { state: "pending", firstMessageId: "first" },
      unaccepted: { state: "pending", firstMessageId: null },
    })) {
      db.prepare(
        "INSERT INTO comments (thread_id, record_json) VALUES (?, json_set(?, '$.threadId', ?, '$.agentSession', json(?)))",
      ).run(
        id,
        original.record_json,
        id,
        JSON.stringify({ harness: "codex", sessionId: "fork", ...binding }),
      );
    }
    db.prepare(
      "UPDATE meta SET value = '7' WHERE key = 'schema_version'",
    ).run();
    db.close();
    await migrateReviewThreadDb(reviewPath, {
      readLegacyConversation: async () => [],
    });
    const comments = readReviewComments(reviewPath);
    const accepted = {
      harness: "codex",
      sessionId: "fork",
      firstMessageId: "first",
    };
    expect(comments.ready?.agentSession).toEqual(accepted);
    expect(comments.followup?.agentSession).toEqual(accepted);
    expect(comments.unaccepted?.agentSession).toBeUndefined();
    expect(comments.unaccepted).toBeUndefined();
    expect(comments.followup?.messages).toEqual(comments.ready?.messages);
  });

  it("rolls back when the native transcript cannot be read", async () => {
    const reviewPath = makeReviewPath();
    seedComment(reviewPath);
    closeAllReviewThreadStores();
    const db = new DatabaseSync(reviewThreadDbPath(reviewPath));
    db.prepare(
      "UPDATE comments SET record_json = json_set(record_json, '$.agentSession', json(?))",
    ).run(JSON.stringify({ harness: "codex", sessionId: "unavailable" }));
    db.prepare(
      "UPDATE meta SET value = '6' WHERE key = 'schema_version'",
    ).run();
    const before = db.prepare("SELECT record_json FROM comments").all();
    db.close();
    await expect(
      migrateReviewThreadDb(reviewPath, {
        readLegacyConversation: async () => {
          throw new Error("transcript unavailable");
        },
      }),
    ).rejects.toThrow("transcript unavailable");
    const unchanged = new DatabaseSync(reviewThreadDbPath(reviewPath));
    expect(unchanged.prepare("SELECT record_json FROM comments").all()).toEqual(
      before,
    );
    expect(
      unchanged
        .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
        .get(),
    ).toEqual({ value: "6" });
    unchanged.close();
  });

  it("aborts migration instead of dropping a malformed agent binding", async () => {
    const reviewPath = makeReviewPath();
    seedComment(reviewPath);
    closeAllReviewThreadStores();
    const db = new DatabaseSync(reviewThreadDbPath(reviewPath));
    db.prepare(
      "UPDATE comments SET record_json = json_set(record_json, '$.agentSession', json(?))",
    ).run(JSON.stringify({ harness: "codex", sessionId: "" }));
    db.prepare(
      "UPDATE meta SET value = '6' WHERE key = 'schema_version'",
    ).run();
    const before = db.prepare("SELECT record_json FROM comments").all();
    db.close();
    await expect(migrateReviewThreadDb(reviewPath)).rejects.toThrow(
      /sessionId/,
    );
    const unchanged = new DatabaseSync(reviewThreadDbPath(reviewPath));
    expect(unchanged.prepare("SELECT record_json FROM comments").all()).toEqual(
      before,
    );
    expect(
      unchanged
        .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
        .get(),
    ).toEqual({ value: "6" });
    unchanged.close();
  });

  it("does not select legacy JSON files at runtime", () => {
    const reviewPath = makeReviewPath();
    writeFileSync(
      path.join(path.dirname(reviewPath), "comments.json"),
      "{}\n",
      "utf8",
    );
    seedComment(reviewPath);
    expect(existsSync(reviewThreadDbPath(reviewPath))).toBe(true);
    expect(Object.keys(readReviewComments(reviewPath))).toEqual(["thread-1"]);
  });

  it("drops a malformed database record and emits a diagnostic", () => {
    const reviewPath = makeReviewPath();
    const dbPath = reviewThreadDbPath(reviewPath);
    createReviewThreadDb(path.dirname(reviewPath));
    const db = new DatabaseSync(dbPath);
    db.prepare(
      "INSERT INTO comments (thread_id, record_json) VALUES (?, ?)",
    ).run("malformed-thread", JSON.stringify({ threadId: "wrong-thread" }));
    db.close();
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(readReviewComments(reviewPath)).toEqual({});
    expect(diagnostic).toHaveBeenCalledWith(
      expect.stringContaining("Dropped 1 malformed comment record"),
    );

    closeAllReviewThreadStores();
    const reopened = new DatabaseSync(dbPath);
    expect(
      reopened.prepare("SELECT count(*) AS count FROM comments").get(),
    ).toEqual({ count: 0 });
    reopened.close();
  });
});
