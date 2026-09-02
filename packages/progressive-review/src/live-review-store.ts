import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { z } from "zod";

import type { LiveReviewPage } from "./live-review-types";

const nodeSchema = z.strictObject({
  id: z.string().min(1),
  title: z.string().min(1).optional(),
  source: z.string(),
  children: z.array(z.string().min(1)),
});

const pageSchema = z.strictObject({
  id: z.string().min(1),
  rootNodeId: z.string().min(1),
  nodes: z.record(z.string().min(1), nodeSchema),
  status: z.enum(["awaiting-agent", "awaiting-review", "accepted", "rejected"]),
  presentedVersionId: z.string().nullable(),
  version: z.number().int().nonnegative(),
  updatedAt: z.iso.datetime(),
  projection: z.custom<LiveReviewPage["projection"]>(
    (value) => Boolean(value) && typeof value === "object",
  ),
});

const LIVE_REVIEW_DDL = `
CREATE TABLE IF NOT EXISTS live_review_page (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  page_json TEXT NOT NULL CHECK (json_valid(page_json)),
  version INTEGER NOT NULL CHECK (version >= 0)
) STRICT;
`;

export class LiveReviewVersionConflictError extends Error {
  override readonly name = "LiveReviewVersionConflictError";
}

export function hasLiveReviewPage(reviewDir: string): boolean {
  return readLiveReviewPage(reviewDir) !== null;
}

export function readLiveReviewPage(reviewDir: string): LiveReviewPage | null {
  const db = openLiveReviewDb(reviewDir);
  try {
    const row = db
      .prepare("SELECT page_json FROM live_review_page WHERE singleton = 1")
      .get() as { page_json: string } | undefined;
    return row ? pageSchema.parse(JSON.parse(row.page_json)) : null;
  } finally {
    db.close();
  }
}

export function initializeLiveReviewPage(
  reviewDir: string,
  page: LiveReviewPage,
): void {
  const parsed = pageSchema.parse(page);
  const db = openLiveReviewDb(reviewDir);
  try {
    db.prepare(
      "INSERT INTO live_review_page (singleton, page_json, version) VALUES (1, ?, ?)",
    ).run(JSON.stringify(parsed), parsed.version);
  } finally {
    db.close();
  }
}

export function commitLiveReviewPage(
  reviewDir: string,
  page: LiveReviewPage,
  expectedVersion: number,
): void {
  const parsed = pageSchema.parse(page);
  const db = openLiveReviewDb(reviewDir);
  let inTransaction = false;
  try {
    db.exec("BEGIN IMMEDIATE");
    inTransaction = true;
    const result = db
      .prepare(
        "UPDATE live_review_page SET page_json = ?, version = ? WHERE singleton = 1 AND version = ?",
      )
      .run(JSON.stringify(parsed), parsed.version, expectedVersion);
    if (result.changes !== 1) {
      throw new LiveReviewVersionConflictError(
        "The Review page changed while the mutation was being validated.",
      );
    }
    db.exec("COMMIT");
    inTransaction = false;
  } catch (error) {
    if (inTransaction) db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }
}

function openLiveReviewDb(reviewDir: string): DatabaseSync {
  const db = new DatabaseSync(path.join(reviewDir, "review.db"));
  db.exec(
    "PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;",
  );
  db.exec(LIVE_REVIEW_DDL);
  return db;
}
