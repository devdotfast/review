import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  closeAllReviewStateDatabases,
  importLegacyReview,
  openReviewStateDb,
  reviewStateDbPath,
} from "./review-state-db";

const roots: string[] = [];

afterEach(() => {
  closeAllReviewStateDatabases();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});

describe("global Review state database", () => {
  it("imports each legacy Review atomically and only once", () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "review-state-db-"));
    roots.push(home);
    const reviewId = "11111111-1111-4111-8111-111111111111";
    const reviewDir = path.join(home, "reviews", reviewId);
    mkdirSync(reviewDir, { recursive: true });
    writeFileSync(
      path.join(reviewDir, "review.json"),
      JSON.stringify({ uuid: reviewId, title: "Legacy title" }),
    );
    const legacy = new DatabaseSync(path.join(reviewDir, "review.db"));
    legacy.exec(`
      CREATE TABLE comments (thread_id TEXT PRIMARY KEY, record_json TEXT NOT NULL);
      CREATE TABLE comment_drafts (thread_id TEXT PRIMARY KEY, record_json TEXT NOT NULL);
    `);
    legacy
      .prepare("INSERT INTO comments VALUES (?, ?)")
      .run(
        "thread-1",
        JSON.stringify({ threadId: "thread-1", status: "open" }),
      );
    legacy.close();

    importLegacyReview(reviewDir);
    const db = openReviewStateDb(home);
    expect(reviewStateDbPath(home)).toBe(path.join(home, "review.db"));
    expect(
      db
        .prepare(
          "SELECT json_extract(record_json, '$.title') AS title FROM reviews WHERE review_id = ?",
        )
        .get(reviewId),
    ).toEqual({ title: "Legacy title" });
    expect(
      db
        .prepare("SELECT thread_id FROM comments WHERE review_id = ?")
        .all(reviewId),
    ).toEqual([{ thread_id: "thread-1" }]);

    writeFileSync(
      path.join(reviewDir, "review.json"),
      JSON.stringify({ uuid: reviewId, title: "Ignored stale file" }),
    );
    importLegacyReview(reviewDir);
    expect(
      db
        .prepare(
          "SELECT json_extract(record_json, '$.title') AS title FROM reviews WHERE review_id = ?",
        )
        .get(reviewId),
    ).toEqual({ title: "Legacy title" });
  });
});
