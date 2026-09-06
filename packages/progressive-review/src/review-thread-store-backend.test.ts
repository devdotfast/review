import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
  ReviewThreadDbVersionError,
  closeAllReviewThreadStores,
  createReviewThreadDb,
  hasPendingReviewAgentWrites,
  migrateReviewThreadDb,
  readReviewThreadsReadOnly,
  reviewThreadDbPath,
  reviewThreadDbSnapshotToken,
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
  it("marks a read-only snapshot and moves its token only when threads change", () => {
    const reviewPath = makeReviewPath();
    seedComment(reviewPath);
    const snapshot = readReviewThreadsReadOnly(reviewPath);
    expect(snapshot.readOnly).toBe(true);
    expect(snapshot.revision).toBe(0);
    const token = reviewThreadDbSnapshotToken(reviewPath);
    expect(reviewThreadDbSnapshotToken(reviewPath)).toBe(token);
    appendReviewComment(reviewPath, {
      threadId: "thread-2",
      messageId: "message-2",
      target: { kind: "document" },
      body: "second",
      author: "Reviewer",
    });
    expect(reviewThreadDbSnapshotToken(reviewPath)).not.toBe(token);
    expect(
      Object.keys(readReviewThreadsReadOnly(reviewPath).comments).sort(),
    ).toEqual(["thread-1", "thread-2"]);
  });

  it("reads committed WAL threads without changing original DB, WAL or SHM bytes", () => {
    const source = makeReviewPath();
    seedComment(source);
    const target = makeReviewPath();
    const sourceDb = reviewThreadDbPath(source);
    const targetDb = reviewThreadDbPath(target);
    const suffixes = ["", "-wal", "-shm"];
    for (const suffix of suffixes)
      copyFileSync(`${sourceDb}${suffix}`, `${targetDb}${suffix}`);
    const before = suffixes.map((suffix) =>
      readFileSync(`${targetDb}${suffix}`),
    );
    expect(
      readReviewThreadsReadOnly(target).comments["thread-1"]?.messages,
    ).toHaveLength(1);
    expect(
      suffixes.map((suffix) => readFileSync(`${targetDb}${suffix}`)),
    ).toEqual(before);
  });
  it("reads recovery threads without changing bytes or pruning malformed rows", () => {
    const reviewPath = makeReviewPath();
    expect(() => readReviewThreadsReadOnly(reviewPath)).toThrow(
      "thread database is unavailable",
    );
    expect(existsSync(reviewThreadDbPath(reviewPath))).toBe(false);
    seedComment(reviewPath);
    closeAllReviewThreadStores();
    const dbPath = reviewThreadDbPath(reviewPath);
    const before = readFileSync(dbPath);
    expect(
      readReviewThreadsReadOnly(reviewPath).comments["thread-1"]?.messages,
    ).toHaveLength(1);
    expect(readFileSync(dbPath)).toEqual(before);
    const db = new DatabaseSync(dbPath);
    db.prepare(
      "INSERT INTO comments(thread_id, record_json) VALUES (?, ?)",
    ).run("broken", "{}");
    db.close();
    const malformed = readFileSync(dbPath);
    expect(() => readReviewThreadsReadOnly(reviewPath)).toThrow(
      /thread|invalid|required|expected/i,
    );
    expect(readFileSync(dbPath)).toEqual(malformed);
  });
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

  it("normalizes message markers and removes native provenance", async () => {
    const reviewPath = makeReviewPath();
    const dbPath = reviewThreadDbPath(reviewPath);
    createReviewThreadDb(path.dirname(reviewPath));
    closeAllReviewThreadStores();
    const db = new DatabaseSync(dbPath);
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
    db.prepare(
      "UPDATE meta SET value = '4' WHERE key = 'schema_version'",
    ).run();
    db.close();

    await expect(migrateReviewThreadDb(reviewPath)).resolves.toBe("upgraded");
    expect(readReviewComments(reviewPath)["thread-1"]).toMatchObject({
      agentSession: {
        harness: "codex",
        sessionId: "child-session",
      },
      messages: [{ body: "Keep this message." }],
    });
    expect(readReviewComments(reviewPath)["thread-without-source"]).toEqual({
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

  it.each([
    { version: "6", boundary: {} },
    { version: "7", boundary: { state: "ready", firstMessageId: "ask" } },
    { version: "7", boundary: { state: "pending", firstMessageId: null } },
    { version: "7", boundary: { state: "repair-required" } },
    { version: "8", boundary: { firstMessageId: "ask" } },
  ])(
    "preserves saved and draft conversations upgrading $version $boundary",
    async ({ version, boundary }) => {
      const reviewPath = makeReviewPath();
      createReviewThreadDb(path.dirname(reviewPath));
      closeAllReviewThreadStores();
      const db = new DatabaseSync(reviewThreadDbPath(reviewPath));
      const records = ["codex", "claude-code", "pi", "opencode"].map(
        (harness) => ({
          threadId: harness,
          target: { kind: "document" },
          status: "resolved",
          agentSession: {
            harness,
            sessionId: `session-${harness}`,
            ...boundary,
          },
          messages: [
            {
              id: "ask",
              by: "Reviewer",
              at: "2026-09-08T00:00:00Z",
              body: "Keep my question",
              agentInput: true,
            },
            {
              id: "reply",
              by: "Agent",
              at: "2026-09-08T00:00:01Z",
              body: "Keep the answer\nwith formatting",
              role: "agent",
              format: "markdown",
              agentInput: false,
              agentMessage:
                version === "6"
                  ? undefined
                  : {
                      sessionId: `session-${harness}`,
                      messageId: "native-reply",
                    },
            },
          ],
        }),
      );
      const drafts = records.map((thread) => ({
        thread,
        inputs: [
          {
            threadId: thread.threadId,
            messageId: "next",
            target: thread.target,
            body: "Unsent follow-up",
            agentInput: true,
          },
        ],
      }));
      for (const record of records)
        db.prepare(
          "INSERT INTO comments (thread_id, record_json) VALUES (?, ?)",
        ).run(record.threadId, JSON.stringify(record));
      for (const draft of drafts)
        db.prepare(
          "INSERT INTO comment_drafts (thread_id, record_json) VALUES (?, ?)",
        ).run(draft.thread.threadId, JSON.stringify(draft));
      db.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(
        version,
      );
      db.close();

      await migrateReviewThreadDb(reviewPath);
      const comments = readReviewComments(reviewPath);
      const upgraded = new DatabaseSync(reviewThreadDbPath(reviewPath));
      for (const original of records) {
        const comment = comments[original.threadId];
        expect(comment).toEqual({
          ...original,
          agentSession: {
            harness: original.agentSession.harness,
            sessionId: original.agentSession.sessionId,
          },
          messages: original.messages.map(
            ({ agentMessage: _obsolete, ...message }) => message,
          ),
        });
        const row = upgraded
          .prepare("SELECT record_json FROM comment_drafts WHERE thread_id = ?")
          .get(original.threadId) as { record_json: string };
        expect(JSON.parse(row.record_json)).toEqual({
          thread: comment,
          inputs: drafts.find(
            (draft) => draft.thread.threadId === original.threadId,
          )!.inputs,
        });
      }
      upgraded.close();
      await expect(migrateReviewThreadDb(reviewPath)).resolves.toBe("current");
    },
  );

  it("leaves every record and version unchanged if a binding is invalid", async () => {
    const reviewPath = makeReviewPath();
    seedComment(reviewPath);
    closeAllReviewThreadStores();
    const db = new DatabaseSync(reviewThreadDbPath(reviewPath));
    const original = db
      .prepare("SELECT record_json FROM comments WHERE thread_id = 'thread-1'")
      .get() as { record_json: string };
    const broken = {
      ...JSON.parse(original.record_json),
      threadId: "broken",
      agentSession: { harness: "pi", sessionId: "", firstMessageId: "ask" },
    };
    db.prepare(
      "INSERT INTO comments (thread_id, record_json) VALUES (?, ?)",
    ).run("broken", JSON.stringify(broken));
    db.prepare(
      "UPDATE meta SET value = '8' WHERE key = 'schema_version'",
    ).run();
    db.close();
    await expect(migrateReviewThreadDb(reviewPath)).rejects.toThrow(
      "sessionId",
    );
    const unchanged = new DatabaseSync(reviewThreadDbPath(reviewPath));
    expect(
      unchanged
        .prepare(
          "SELECT record_json FROM comments WHERE thread_id = 'thread-1'",
        )
        .get(),
    ).toEqual(original);
    expect(
      unchanged
        .prepare("SELECT record_json FROM comments WHERE thread_id = 'broken'")
        .get(),
    ).toEqual({ record_json: JSON.stringify(broken) });
    expect(
      unchanged
        .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
        .get(),
    ).toEqual({ value: "8" });
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

it.each(["1", "2", "3", "4", "5", "6"])(
  "inspects pending messages in DB schema %s without converting targets or changing files",
  (version) => {
    const reviewPath = makeReviewPath();
    seedComment(reviewPath);
    closeAllReviewThreadStores();
    const dbPath = reviewThreadDbPath(reviewPath);
    const db = new DatabaseSync(dbPath);
    db.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(
      version,
    );
    db.prepare(
      "UPDATE comments SET record_json = ? WHERE thread_id = 'thread-1'",
    ).run(
      JSON.stringify({
        target: { kind: "code", file: "old.ts" },
        messages: [{ role: "reviewer", agentInput: true }],
      }),
    );
    if (version === "1") db.exec("DROP TABLE comment_drafts");
    db.close();
    const before = readFileSync(dbPath);
    expect(hasPendingReviewAgentWrites(reviewPath)).toBe(true);
    expect(readFileSync(dbPath)).toEqual(before);
    const answered = new DatabaseSync(dbPath);
    answered
      .prepare(
        "UPDATE comments SET record_json = ? WHERE thread_id = 'thread-1'",
      )
      .run(
        JSON.stringify({
          messages: [{ role: "reviewer", agentInput: true }, { role: "agent" }],
        }),
      );
    answered.close();
    expect(hasPendingReviewAgentWrites(reviewPath)).toBe(false);
  },
);

it("rejects unknown database versions and malformed message arrays during pending-write inspection", () => {
  const reviewPath = makeReviewPath();
  seedComment(reviewPath);
  closeAllReviewThreadStores();
  const db = new DatabaseSync(reviewThreadDbPath(reviewPath));
  db.exec("UPDATE meta SET value = '999' WHERE key = 'schema_version'");
  db.close();
  expect(() => hasPendingReviewAgentWrites(reviewPath)).toThrow(
    ReviewThreadDbVersionError,
  );
  const malformed = new DatabaseSync(reviewThreadDbPath(reviewPath));
  malformed.exec(
    "UPDATE meta SET value = '5' WHERE key = 'schema_version'; UPDATE comments SET record_json = '{}'",
  );
  malformed.close();
  expect(() => hasPendingReviewAgentWrites(reviewPath)).toThrow(
    /messages|array/i,
  );
});
