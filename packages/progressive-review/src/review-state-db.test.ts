import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  REVIEW_STATE_DB_V1_DDL,
  ReviewPublicationConflictError,
  ReviewStateDbVersionError,
  closeAllReviewStateDatabases,
  deleteReviewState,
  importLegacyReview,
  insertPublicationInTransaction,
  listPublications,
  openReviewStateDb,
  putReviewRecord,
  putReviewRecordInTransaction,
  readPublication,
  readReviewRecord,
  readReviewStateDbSchemaVersion,
  reviewStateDbPath,
  upsertLegacyArtifactImportInTransaction,
  withReviewStateTransaction,
} from "./review-state-db";
import {
  appendReviewComment,
  readReviewCommentDrafts,
  readReviewComments,
} from "./review-state-store";
import {
  ReviewThreadDbVersionError,
  closeAllReviewThreadStores,
  copyReviewThreadDatabaseSnapshot,
  createLegacyReviewThreadDb,
  legacyReviewThreadDbPath,
  migrateReviewThreadDb,
  readReviewThreadsReadOnly,
} from "./review-thread-store-backend";

const roots: string[] = [];

afterEach(() => {
  closeAllReviewThreadStores();
  closeAllReviewStateDatabases();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function setupHome(): string {
  const home = mkdtempSync(path.join(tmpdir(), "review-state-db-"));
  roots.push(home);
  vi.stubEnv("DEV_REVIEW_HOME", home);
  return home;
}

function reviewPath(home: string, reviewId: string): string {
  const dir = path.join(home, "reviews", reviewId);
  mkdirSync(dir, { recursive: true });
  return path.join(dir, "review.mdx");
}

describe("global review state database", () => {
  it("rejects unsupported shared schemas during read-only recovery", () => {
    const home = setupHome();
    const document = reviewPath(home, "review-a");
    putReviewRecord(path.dirname(document), { title: "A" });
    closeAllReviewStateDatabases();
    const db = new DatabaseSync(reviewStateDbPath(home));
    db.exec(
      "UPDATE review_state_meta SET value = '999' WHERE key = 'schema_version'",
    );
    db.close();
    expect(() => readReviewThreadsReadOnly(document)).toThrow(
      ReviewStateDbVersionError,
    );
  });
  it("exports only the requested Review's threads into a repair candidate", () => {
    const home = setupHome();
    const first = reviewPath(home, "review-a");
    const second = reviewPath(home, "review-b");
    for (const document of [first, second]) {
      appendReviewComment(document, {
        threadId: "shared-id",
        messageId: "message",
        target: { kind: "document" },
        body: document,
        author: "Reviewer",
      });
    }
    const candidate = path.join(home, "candidate");
    mkdirSync(candidate);
    const candidateDocument = path.join(candidate, "review.mdx");
    copyReviewThreadDatabaseSnapshot(first, candidateDocument);
    expect(
      readReviewThreadsReadOnly(candidateDocument).comments["shared-id"]
        ?.messages[0]?.body,
    ).toBe(first);
    expect(
      readReviewThreadsReadOnly(second).comments["shared-id"]?.messages[0]
        ?.body,
    ).toBe(second);
    appendReviewComment(second, {
      threadId: "new",
      messageId: "new-message",
      target: { kind: "document" },
      body: "Still writable",
      author: "Reviewer",
    });
    expect(Object.keys(readReviewComments(first))).toEqual(["shared-id"]);
    expect(Object.keys(readReviewComments(second)).sort()).toEqual([
      "new",
      "shared-id",
    ]);
  });
  it("defers legacy comment and draft import until after migration, even after metadata reads and writes", async () => {
    const home = setupHome();
    const document = reviewPath(home, "review-a");
    const dir = path.dirname(document);
    writeFileSync(
      path.join(dir, "review.json"),
      JSON.stringify({ uuid: "review-a", title: "Legacy" }),
    );
    createLegacyReviewThreadDb(dir);
    const legacy = new DatabaseSync(legacyReviewThreadDbPath(document));
    const thread = {
      threadId: "thread-a",
      target: { kind: "document" },
      status: "open",
      agentSession: {
        harness: "codex",
        sessionId: "child",
        sourceSessionId: "obsolete",
      },
      messages: [
        {
          id: "message-a",
          by: "Reviewer",
          at: "2026-01-01T00:00:00.000Z",
          body: "Preserve me",
        },
      ],
    };
    legacy
      .prepare("INSERT INTO comments(thread_id, record_json) VALUES (?, ?)")
      .run("thread-a", JSON.stringify(thread));
    legacy
      .prepare(
        "INSERT INTO comment_drafts(thread_id, record_json) VALUES (?, ?)",
      )
      .run(
        "thread-a",
        JSON.stringify({
          thread,
          inputs: [
            {
              threadId: "thread-a",
              messageId: "message-a",
              target: { kind: "document" },
              body: "Preserve me",
            },
          ],
        }),
      );
    legacy
      .prepare("UPDATE meta SET value = '4' WHERE key = 'schema_version'")
      .run();
    legacy.close();
    expect(readReviewRecord(dir)).toMatchObject({ title: "Legacy" });
    putReviewRecord(dir, { uuid: "review-a", title: "Updated metadata" });
    expect(() => importLegacyReview(dir)).toThrow(ReviewThreadDbVersionError);
    expect(
      openReviewStateDb()
        .prepare("SELECT count(*) AS count FROM legacy_review_imports")
        .get(),
    ).toEqual({ count: 0 });
    expect(
      openReviewStateDb()
        .prepare("SELECT count(*) AS count FROM comments")
        .get(),
    ).toEqual({ count: 0 });
    expect(await migrateReviewThreadDb(document)).toBe("upgraded");
    expect(readReviewComments(document)["thread-a"]).toMatchObject({
      agentSession: { harness: "codex", sessionId: "child" },
      messages: [{ body: "Preserve me" }],
    });
    expect(
      readReviewCommentDrafts(document)["thread-a"].thread.messages[0].body,
    ).toBe("Preserve me");
    expect(readReviewRecord(dir)).toMatchObject({ title: "Updated metadata" });
    expect(
      openReviewStateDb()
        .prepare("SELECT count(*) AS count FROM legacy_review_imports")
        .get(),
    ).toEqual({ count: 1 });
  });
  it("isolates comment rows for multiple reviews in one database", () => {
    const home = setupHome();
    const first = reviewPath(home, "review-a");
    const second = reviewPath(home, "review-b");

    appendReviewComment(first, {
      threadId: "thread-a",
      messageId: "message-a",
      target: { kind: "document" },
      body: "First review",
      author: "Reviewer",
    });
    appendReviewComment(second, {
      threadId: "thread-b",
      messageId: "message-b",
      target: { kind: "document" },
      body: "Second review",
      author: "Reviewer",
    });

    expect(Object.keys(readReviewComments(first))).toEqual(["thread-a"]);
    expect(Object.keys(readReviewComments(second))).toEqual(["thread-b"]);
    const db = new DatabaseSync(reviewStateDbPath(home), { readOnly: true });
    expect(
      db
        .prepare("SELECT count(DISTINCT review_id) AS count FROM comments")
        .get(),
    ).toEqual({ count: 2 });
    db.close();
  });

  it("treats the database record as authoritative over its JSON mirror", () => {
    const home = setupHome();
    const document = reviewPath(home, "review-a");
    const dir = path.dirname(document);
    putReviewRecord(dir, { uuid: "review-a", title: "Database" });
    writeFileSync(
      path.join(dir, "review.json"),
      JSON.stringify({ uuid: "review-a", title: "Stale mirror" }),
    );

    expect(readReviewRecord(dir)).toEqual({
      uuid: "review-a",
      title: "Database",
    });
  });

  it("imports legacy metadata and comments once without deleting the source", () => {
    const home = setupHome();
    const document = reviewPath(home, "review-a");
    const dir = path.dirname(document);
    writeFileSync(
      path.join(dir, "review.json"),
      JSON.stringify({ uuid: "review-a", title: "Legacy" }),
    );
    createLegacyReviewThreadDb(dir);
    const legacy = new DatabaseSync(legacyReviewThreadDbPath(document));
    legacy
      .prepare("INSERT INTO comments (thread_id, record_json) VALUES (?, ?)")
      .run(
        "thread-a",
        JSON.stringify({
          threadId: "thread-a",
          target: { kind: "document" },
          status: "open",
          messages: [
            {
              id: "message-a",
              by: "Reviewer",
              at: "2026-01-01T00:00:00.000Z",
              body: "Imported",
            },
          ],
        }),
      );
    legacy.close();

    expect(readReviewRecord(dir)).toEqual({
      uuid: "review-a",
      title: "Legacy",
    });
    expect(Object.keys(readReviewComments(document))).toEqual(["thread-a"]);
    expect(legacyReviewThreadDbPath(document)).not.toBe(
      reviewStateDbPath(home),
    );
  });

  it("cascades all review-owned state when a review is deleted", () => {
    const home = setupHome();
    const document = reviewPath(home, "review-a");
    appendReviewComment(document, {
      threadId: "thread-a",
      messageId: "message-a",
      target: { kind: "document" },
      body: "Delete me",
      author: "Reviewer",
    });

    deleteReviewState(path.dirname(document));
    const db = openReviewStateDb(home);
    expect(db.prepare("SELECT count(*) AS count FROM comments").get()).toEqual({
      count: 0,
    });
    expect(db.prepare("SELECT count(*) AS count FROM reviews").get()).toEqual({
      count: 0,
    });
  });

  it("rejects an unsupported global schema version", () => {
    const home = setupHome();
    const db = openReviewStateDb(home);
    db.prepare(
      "UPDATE review_state_meta SET value = '999' WHERE key = 'schema_version'",
    ).run();
    closeAllReviewStateDatabases();
    expect(() => openReviewStateDb(home)).toThrow(ReviewStateDbVersionError);
  });

  it("upgrades a v1 database to v2 on open, adding the publication tables", () => {
    const home = setupHome();
    const dbPath = reviewStateDbPath(home);
    mkdirSync(path.dirname(dbPath), { recursive: true });
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(REVIEW_STATE_DB_V1_DDL);
    legacy
      .prepare(
        "INSERT INTO review_state_meta (key, value) VALUES ('schema_version', '1')",
      )
      .run();
    legacy.close();

    const db = openReviewStateDb(home);

    expect(readReviewStateDbSchemaVersion(db)).toBe("2");
    expect(
      db
        .prepare(
          "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'publications'",
        )
        .get(),
    ).toBeTruthy();
    expect(
      db
        .prepare(
          "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'legacy_artifact_imports'",
        )
        .get(),
    ).toBeTruthy();
  });

  it("rejects a database written by a newer Review with a message naming it", () => {
    const home = setupHome();
    openReviewStateDb(home);
    closeAllReviewStateDatabases();
    const db = new DatabaseSync(reviewStateDbPath(home));
    db.exec(
      "UPDATE review_state_meta SET value = '3' WHERE key = 'schema_version'",
    );
    db.close();
    expect(() => openReviewStateDb(home)).toThrow(/newer/);
  });

  it("throws on nested reentry and rolls back the outer transaction", () => {
    const home = setupHome();
    const document = reviewPath(home, "review-a");
    const dir = path.dirname(document);
    expect(() =>
      withReviewStateTransaction(home, (tx) => {
        putReviewRecordInTransaction(tx, dir, { uuid: "review-a" });
        withReviewStateTransaction(home, (innerTx) => {
          putReviewRecordInTransaction(innerTx, dir, {
            uuid: "review-a-2",
          });
        });
      }),
    ).toThrow(/nested/);
    expect(readReviewRecord(dir, home, { importMirror: false })).toBeNull();
  });

  it("rejects a callback that returns a thenable and rolls back", () => {
    const home = setupHome();
    const document = reviewPath(home, "review-a");
    const dir = path.dirname(document);
    expect(() =>
      withReviewStateTransaction(home, (tx) => {
        putReviewRecordInTransaction(tx, dir, { uuid: "review-a" });
        return Promise.resolve("nope");
      }),
    ).toThrow(TypeError);
    expect(readReviewRecord(dir, home, { importMirror: false })).toBeNull();
  });

  it("rolls back the transaction when beforeCommit throws", () => {
    const home = setupHome();
    const document = reviewPath(home, "review-a");
    const dir = path.dirname(document);
    expect(() =>
      withReviewStateTransaction(
        home,
        (tx) => {
          putReviewRecordInTransaction(tx, dir, { uuid: "review-a" });
        },
        {
          beforeCommit: () => {
            throw new Error("fault injection");
          },
        },
      ),
    ).toThrow("fault injection");
    expect(readReviewRecord(dir, home, { importMirror: false })).toBeNull();
  });

  it("does not back-fill the reviews table when importMirror is false", () => {
    const home = setupHome();
    const document = reviewPath(home, "review-a");
    const dir = path.dirname(document);
    writeFileSync(
      path.join(dir, "review.json"),
      JSON.stringify({ uuid: "review-a", title: "Legacy" }),
    );

    expect(readReviewRecord(dir, home, { importMirror: false })).toEqual({
      uuid: "review-a",
      title: "Legacy",
    });
    expect(
      openReviewStateDb(home)
        .prepare("SELECT count(*) AS count FROM reviews")
        .get(),
    ).toEqual({ count: 0 });
  });

  it("returns existing:true for a byte-identical publication insert and throws on a conflicting record", () => {
    const home = setupHome();
    const document = reviewPath(home, "review-a");
    const dir = path.dirname(document);
    putReviewRecord(dir, { uuid: "review-a" });
    const publicationId = createHash("sha1").update("pub-1").digest("hex");

    const first = withReviewStateTransaction(home, (tx) =>
      insertPublicationInTransaction(tx, dir, {
        publicationId,
        kind: "document",
        record: { title: "v1" },
        createdAt: "2026-01-01T00:00:00.000Z",
        operation: "publish",
        artifactHash: null,
        previousPublicationId: null,
      }),
    );
    expect(first).toEqual({ seq: 1, existing: false });

    const second = withReviewStateTransaction(home, (tx) =>
      insertPublicationInTransaction(tx, dir, {
        publicationId,
        kind: "document",
        record: { title: "v1" },
        createdAt: "2026-01-02T00:00:00.000Z",
        operation: "publish",
        artifactHash: null,
        previousPublicationId: null,
      }),
    );
    expect(second).toEqual({ seq: 1, existing: true });

    expect(() =>
      withReviewStateTransaction(home, (tx) =>
        insertPublicationInTransaction(tx, dir, {
          publicationId,
          kind: "document",
          record: { title: "v2" },
          createdAt: "2026-01-03T00:00:00.000Z",
          operation: "publish",
          artifactHash: null,
          previousPublicationId: null,
        }),
      ),
    ).toThrow(ReviewPublicationConflictError);
  });

  it("auto-increments seq per review and lists publications by seq descending", () => {
    const home = setupHome();
    const document = reviewPath(home, "review-a");
    const dir = path.dirname(document);
    putReviewRecord(dir, { uuid: "review-a" });
    const createdAt = "2026-01-01T00:00:00.000Z";
    const ids = [1, 2, 3].map((n) =>
      createHash("sha1").update(`pub-${n}`).digest("hex"),
    );
    for (const publicationId of ids) {
      withReviewStateTransaction(home, (tx) =>
        insertPublicationInTransaction(tx, dir, {
          publicationId,
          kind: "document",
          record: { publicationId },
          createdAt,
          operation: "publish",
          artifactHash: null,
          previousPublicationId: null,
        }),
      );
    }

    const rows = listPublications(dir, "document", home);
    expect(rows.map((row) => row.seq)).toEqual([3, 2, 1]);
    expect(rows.map((row) => row.publicationId)).toEqual([...ids].reverse());
  });

  it("returns null from readPublication when the kind does not match", () => {
    const home = setupHome();
    const document = reviewPath(home, "review-a");
    const dir = path.dirname(document);
    putReviewRecord(dir, { uuid: "review-a" });
    const publicationId = createHash("sha1").update("pub-map").digest("hex");
    withReviewStateTransaction(home, (tx) =>
      insertPublicationInTransaction(tx, dir, {
        publicationId,
        kind: "map",
        record: { ok: true },
        createdAt: "2026-01-01T00:00:00.000Z",
        operation: "publish",
        artifactHash: null,
        previousPublicationId: null,
      }),
    );

    expect(readPublication(dir, publicationId, "document", home)).toBeNull();
    expect(readPublication(dir, publicationId, "map", home)?.record).toEqual({
      ok: true,
    });
  });

  it("cascades publications and the legacy artifact import marker when a review is deleted", () => {
    const home = setupHome();
    const document = reviewPath(home, "review-a");
    const dir = path.dirname(document);
    putReviewRecord(dir, { uuid: "review-a" });
    const publicationId = createHash("sha1")
      .update("pub-cascade")
      .digest("hex");
    withReviewStateTransaction(home, (tx) => {
      insertPublicationInTransaction(tx, dir, {
        publicationId,
        kind: "document",
        record: { ok: true },
        createdAt: "2026-01-01T00:00:00.000Z",
        operation: "publish",
        artifactHash: null,
        previousPublicationId: null,
      });
      upsertLegacyArtifactImportInTransaction(tx, dir, {
        importedAt: "2026-01-01T00:00:00.000Z",
        sourceHead: "main",
        versions: 3,
        unavailable: 0,
      });
    });

    deleteReviewState(dir);

    const db = openReviewStateDb(home);
    expect(
      db.prepare("SELECT count(*) AS count FROM publications").get(),
    ).toEqual({ count: 0 });
    expect(
      db.prepare("SELECT count(*) AS count FROM legacy_artifact_imports").get(),
    ).toEqual({ count: 0 });
  });
});
