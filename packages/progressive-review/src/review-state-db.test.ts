import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ReviewStateDbVersionError,
  closeAllReviewStateDatabases,
  deleteReviewState,
  importLegacyReview,
  openReviewStateDb,
  putReviewRecord,
  readReviewRecord,
  reviewStateDbPath,
} from "./review-state-db";
import {
  appendReviewComment,
  readReviewCommentDrafts,
  readReviewComments,
} from "./review-state-store";
import {
  ReviewThreadDbVersionError,
  closeAllReviewThreadStores,
  createLegacyReviewThreadDb,
  legacyReviewThreadDbPath,
  migrateReviewThreadDb,
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
});
