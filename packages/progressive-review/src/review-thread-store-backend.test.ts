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

import { appendReviewComment, readReviewComments } from "./review-state-store";
import {
  REVIEW_THREAD_DB_SCHEMA_VERSION,
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
  const dir = path.join(
    root,
    "reviews",
    "11111111-1111-4111-8111-111111111111",
  );
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
    seedComment(reviewPath);
    closeAllReviewThreadStores();
    const db = new DatabaseSync(dbPath);
    db.prepare(
      "UPDATE review_state_meta SET value = '999' WHERE key = 'schema_version'",
    ).run();
    db.close();
    expect(() => readReviewComments(reviewPath)).toThrow(
      /schema version 999; expected 1/,
    );
  });

  it("drops the question table through the managed v2 upgrade", async () => {
    const reviewPath = makeReviewPath();
    const dbPath = path.join(path.dirname(reviewPath), "review.db");
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO meta VALUES ('schema_version', '2');
      CREATE TABLE comments (thread_id TEXT PRIMARY KEY, record_json TEXT NOT NULL);
      CREATE TABLE comment_drafts (thread_id TEXT PRIMARY KEY, record_json TEXT NOT NULL);
      CREATE TABLE questions (
        question_id TEXT PRIMARY KEY,
        record_json TEXT NOT NULL
      );
      INSERT INTO questions VALUES ('question-1', '{}');
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

  it("normalizes message markers and removes native provenance", async () => {
    const reviewPath = makeReviewPath();
    const dbPath = path.join(path.dirname(reviewPath), "review.db");
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO meta VALUES ('schema_version', '4');
      CREATE TABLE comments (thread_id TEXT PRIMARY KEY, record_json TEXT NOT NULL);
      CREATE TABLE comment_drafts (thread_id TEXT PRIMARY KEY, record_json TEXT NOT NULL);
    `);
    db.prepare(
      "INSERT INTO comments (thread_id, record_json) VALUES (?, ?)",
    ).run(
      "thread-1",
      JSON.stringify({
        threadId: "thread-1",
        target: { kind: "document" },
        status: "open",
        agentSession: {
          harness: "codex",
          sessionId: "child-session",
          sourceSessionId: "source-session",
          cursor: 12,
          turns: [{ operationId: "operation-1" }],
        },
        messages: [
          {
            id: "message-1",
            by: "Reviewer",
            at: "2026-08-16T00:00:00.000Z",
            body: "Keep this message.",
            native: {
              sessionId: "child-session",
              entryIds: ["provider-message-1"],
            },
          },
        ],
      }),
    );
    db.prepare(
      "INSERT INTO comments (thread_id, record_json) VALUES (?, ?)",
    ).run(
      "thread-without-source",
      JSON.stringify({
        threadId: "thread-without-source",
        target: { kind: "document" },
        status: "open",
        agentSession: {
          harness: "codex",
          sessionId: "ambiguous-child",
          cursor: 2,
          turns: [],
        },
        messages: [
          {
            id: "preserved-message",
            by: "Reviewer",
            at: "2026-08-16T00:00:00.000Z",
            body: "Preserve this too.",
          },
        ],
      }),
    );
    db.close();

    await expect(migrateReviewThreadDb(reviewPath)).resolves.toBe("upgraded");
    const migrated = new DatabaseSync(dbPath, { readOnly: true });
    const comments = Object.fromEntries(
      (
        migrated
          .prepare("SELECT thread_id, record_json FROM comments")
          .all() as Array<{
          thread_id: string;
          record_json: string;
        }>
      ).map((row) => [row.thread_id, JSON.parse(row.record_json)]),
    );
    migrated.close();
    expect(comments["thread-1"]).toMatchObject({
      agentSession: {
        harness: "codex",
        sessionId: "child-session",
      },
      messages: [{ body: "Keep this message." }],
    });
    expect(comments["thread-without-source"]).toEqual({
      threadId: "thread-without-source",
      target: { kind: "document" },
      status: "open",
      agentSession: {
        harness: "codex",
        sessionId: "ambiguous-child",
      },
      messages: [
        {
          id: "preserved-message",
          by: "Reviewer",
          at: "2026-08-16T00:00:00.000Z",
          body: "Preserve this too.",
          agentInput: false,
        },
      ],
    });
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
      "INSERT INTO comments (review_id, thread_id, record_json) VALUES (?, ?, ?)",
    ).run(
      path.basename(path.dirname(reviewPath)),
      "malformed-thread",
      JSON.stringify({ threadId: "wrong-thread" }),
    );
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
