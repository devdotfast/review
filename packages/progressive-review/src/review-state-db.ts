import { existsSync, mkdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const SCHEMA_VERSION = 1;
const connections = new Map<string, DatabaseSync>();

const DDL = `
CREATE TABLE IF NOT EXISTS review_state_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS reviews (
  review_id TEXT PRIMARY KEY,
  review_dir TEXT NOT NULL UNIQUE,
  record_json TEXT NOT NULL CHECK (json_valid(record_json))
) STRICT;
CREATE TABLE IF NOT EXISTS live_review_pages (
  review_id TEXT PRIMARY KEY,
  page_json TEXT NOT NULL CHECK (json_valid(page_json)),
  version INTEGER NOT NULL CHECK (version >= 0)
) STRICT;
CREATE TABLE IF NOT EXISTS comments (
  review_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  record_json TEXT NOT NULL CHECK (json_valid(record_json)),
  status TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.status')) STORED,
  PRIMARY KEY (review_id, thread_id)
) STRICT;
CREATE TABLE IF NOT EXISTS comment_drafts (
  review_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  record_json TEXT NOT NULL CHECK (json_valid(record_json)),
  PRIMARY KEY (review_id, thread_id)
) STRICT;
CREATE TABLE IF NOT EXISTS legacy_review_imports (
  review_id TEXT PRIMARY KEY,
  imported_at TEXT NOT NULL
) STRICT;
`;

export function reviewStateDbPath(home = defaultReviewHome()): string {
  return path.join(home, "review.db");
}

export function reviewHomeForDir(reviewDir: string): string {
  const parent = path.dirname(path.resolve(reviewDir));
  return path.basename(parent) === "reviews"
    ? path.dirname(parent)
    : path.resolve(reviewDir);
}

export function reviewIdForDir(reviewDir: string): string {
  return path.basename(path.resolve(reviewDir));
}

export function openReviewStateDbForDir(reviewDir: string): DatabaseSync {
  return openReviewStateDb(reviewHomeForDir(reviewDir));
}

export function reviewStateDbPathForDir(reviewDir: string): string {
  return reviewStateDbPath(reviewHomeForDir(reviewDir));
}

export function openReviewStateDb(home = defaultReviewHome()): DatabaseSync {
  const dbPath = reviewStateDbPath(home);
  const cached = connections.get(dbPath);
  if (cached) return cached;
  mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(
      "PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;",
    );
    db.exec(DDL);
    const version = db
      .prepare(
        "SELECT value FROM review_state_meta WHERE key = 'schema_version'",
      )
      .get() as { value: string } | undefined;
    if (!version) {
      db.prepare(
        "INSERT INTO review_state_meta (key, value) VALUES ('schema_version', ?)",
      ).run(String(SCHEMA_VERSION));
    } else if (version.value !== String(SCHEMA_VERSION)) {
      throw new Error(
        `Review state database ${dbPath} has schema version ${version.value}; expected ${SCHEMA_VERSION}.`,
      );
    }
  } catch (error) {
    db.close();
    throw error;
  }
  connections.set(dbPath, db);
  return db;
}

function defaultReviewHome(): string {
  return path.resolve(
    process.env.DEV_REVIEW_HOME ?? path.join(os.homedir(), ".dev"),
  );
}

/** Import one legacy Review exactly once. The old files remain recoverable but
 * are never read again after the marker commits. */
export function importLegacyReview(reviewDir: string): void {
  const reviewId = reviewIdForDir(reviewDir);
  const db = openReviewStateDbForDir(reviewDir);
  if (
    db
      .prepare("SELECT 1 FROM legacy_review_imports WHERE review_id = ?")
      .get(reviewId)
  ) {
    return;
  }

  const recordPath = path.join(reviewDir, "review.json");
  if (!existsSync(recordPath)) return;
  const recordJson = readFileSync(recordPath, "utf8");
  JSON.parse(recordJson);
  const legacyDbPath = path.join(reviewDir, "review.db");
  const legacy = existsSync(legacyDbPath)
    ? new DatabaseSync(legacyDbPath, { readOnly: true })
    : null;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(
      "INSERT OR IGNORE INTO reviews (review_id, review_dir, record_json) VALUES (?, ?, ?)",
    ).run(reviewId, path.resolve(reviewDir), recordJson);
    if (legacy) importLegacySqliteRows(db, legacy, reviewId);
    db.prepare(
      "INSERT INTO legacy_review_imports (review_id, imported_at) VALUES (?, ?)",
    ).run(reviewId, new Date().toISOString());
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    legacy?.close();
  }
}

export function putReviewRecord(reviewDir: string, record: unknown): void {
  const reviewId = reviewIdForDir(reviewDir);
  const db = openReviewStateDbForDir(reviewDir);
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(
      `INSERT INTO reviews (review_id, review_dir, record_json) VALUES (?, ?, ?)
       ON CONFLICT(review_id) DO UPDATE SET review_dir = excluded.review_dir, record_json = excluded.record_json`,
    ).run(reviewId, path.resolve(reviewDir), JSON.stringify(record));
    db.prepare(
      "INSERT OR IGNORE INTO legacy_review_imports (review_id, imported_at) VALUES (?, ?)",
    ).run(reviewId, new Date().toISOString());
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function deleteReviewState(reviewDir: string): void {
  const db = openReviewStateDbForDir(reviewDir);
  const reviewId = reviewIdForDir(reviewDir);
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const table of [
      "live_review_pages",
      "comments",
      "comment_drafts",
      "legacy_review_imports",
      "reviews",
    ]) {
      db.prepare(`DELETE FROM ${table} WHERE review_id = ?`).run(reviewId);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function closeAllReviewStateDatabases(): void {
  for (const db of connections.values()) db.close();
  connections.clear();
}

function importLegacySqliteRows(
  target: DatabaseSync,
  legacy: DatabaseSync,
  reviewId: string,
): void {
  const tables = new Set(
    (
      legacy
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as Array<{ name: string }>
    ).map((row) => row.name),
  );
  if (tables.has("comments")) {
    const insert = target.prepare(
      "INSERT OR IGNORE INTO comments (review_id, thread_id, record_json) VALUES (?, ?, ?)",
    );
    for (const row of legacy
      .prepare("SELECT thread_id, record_json FROM comments")
      .all() as Array<{ thread_id: string; record_json: string }>) {
      insert.run(reviewId, row.thread_id, row.record_json);
    }
  }
  if (tables.has("comment_drafts")) {
    const insert = target.prepare(
      "INSERT OR IGNORE INTO comment_drafts (review_id, thread_id, record_json) VALUES (?, ?, ?)",
    );
    for (const row of legacy
      .prepare("SELECT thread_id, record_json FROM comment_drafts")
      .all() as Array<{ thread_id: string; record_json: string }>) {
      insert.run(reviewId, row.thread_id, row.record_json);
    }
  }
  if (tables.has("live_review_page")) {
    const row = legacy
      .prepare(
        "SELECT page_json, version FROM live_review_page WHERE singleton = 1",
      )
      .get() as { page_json: string; version: number } | undefined;
    if (row) {
      target
        .prepare(
          "INSERT OR IGNORE INTO live_review_pages (review_id, page_json, version) VALUES (?, ?, ?)",
        )
        .run(reviewId, row.page_json, row.version);
    }
  }
}
