import { existsSync, mkdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { JsonValue } from "@dev.fast/review-protocol";
import { parseJsonText } from "@dev.fast/review-protocol";

import { requireCurrentThreadDbSchema } from "./review-thread-db-schema";

export const REVIEW_STATE_DB_FILENAME = "review.db";
export const REVIEW_STATE_DB_SCHEMA_VERSION = 1;

const REVIEW_STATE_DB_DDL = `
CREATE TABLE IF NOT EXISTS review_state_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS reviews (
  review_id  TEXT PRIMARY KEY,
  review_dir TEXT NOT NULL UNIQUE,
  record_json TEXT CHECK (record_json IS NULL OR json_valid(record_json))
) STRICT;
CREATE TABLE IF NOT EXISTS documents (
  review_id       TEXT NOT NULL REFERENCES reviews(review_id) ON DELETE CASCADE,
  route_path      TEXT NOT NULL,
  mode            TEXT NOT NULL CHECK (mode IN ('compiled', 'incremental')),
  revision        INTEGER NOT NULL CHECK (revision >= 0),
  source_hash     TEXT,
  projection_json TEXT CHECK (projection_json IS NULL OR json_valid(projection_json)),
  PRIMARY KEY (review_id, route_path)
) STRICT;
CREATE TABLE IF NOT EXISTS comments (
  review_id   TEXT NOT NULL REFERENCES reviews(review_id) ON DELETE CASCADE,
  route_path  TEXT NOT NULL,
  thread_id   TEXT NOT NULL,
  record_json TEXT NOT NULL CHECK (json_valid(record_json)),
  status      TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.status')) STORED,
  PRIMARY KEY (review_id, route_path, thread_id)
) STRICT;
CREATE TABLE IF NOT EXISTS comment_drafts (
  review_id   TEXT NOT NULL REFERENCES reviews(review_id) ON DELETE CASCADE,
  route_path  TEXT NOT NULL,
  thread_id   TEXT NOT NULL,
  record_json TEXT NOT NULL CHECK (json_valid(record_json)),
  PRIMARY KEY (review_id, route_path, thread_id)
) STRICT;
CREATE TABLE IF NOT EXISTS mutation_receipts (
  review_id    TEXT NOT NULL REFERENCES reviews(review_id) ON DELETE CASCADE,
  mutation_id  TEXT NOT NULL,
  revision     INTEGER NOT NULL CHECK (revision >= 0),
  response_json TEXT NOT NULL CHECK (json_valid(response_json)),
  created_at   TEXT NOT NULL,
  PRIMARY KEY (review_id, mutation_id)
) STRICT;
CREATE TABLE IF NOT EXISTS legacy_review_imports (
  review_id  TEXT PRIMARY KEY REFERENCES reviews(review_id) ON DELETE CASCADE,
  imported_at TEXT NOT NULL
) STRICT;
`;

const connections = new Map<string, DatabaseSync>();

export class ReviewStateDbVersionError extends Error {
  override readonly name = "ReviewStateDbVersionError";

  constructor(dbPath: string, found: string | null) {
    super(
      `Review state database ${dbPath} has schema version ` +
        `${found ?? "(missing)"}; this version of Review supports ` +
        `${REVIEW_STATE_DB_SCHEMA_VERSION}. Run \`review migrate apply\`.`,
    );
  }
}

export function defaultReviewHome(): string {
  return path.resolve(
    process.env.DEV_REVIEW_HOME ?? path.join(os.homedir(), ".dev"),
  );
}

export function reviewStateDbPath(home = defaultReviewHome()): string {
  return path.join(path.resolve(home), REVIEW_STATE_DB_FILENAME);
}

export function reviewIdForDir(reviewDir: string): string {
  const reviewId = path.basename(path.resolve(reviewDir));
  if (!reviewId)
    throw new Error(`Review directory has no identifier: ${reviewDir}`);
  return reviewId;
}

export function openReviewStateDb(home = defaultReviewHome()): DatabaseSync {
  const dbPath = reviewStateDbPath(home);
  const cached = connections.get(dbPath);
  if (cached) return cached;
  mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
  const existed = existsSync(dbPath);
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(
      "PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; " +
        "PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;",
    );
    if (!existed) {
      db.exec(REVIEW_STATE_DB_DDL);
      db.prepare(
        "INSERT INTO review_state_meta (key, value) VALUES ('schema_version', ?)",
      ).run(String(REVIEW_STATE_DB_SCHEMA_VERSION));
    } else {
      const version = readReviewStateDbSchemaVersion(db);
      if (version !== String(REVIEW_STATE_DB_SCHEMA_VERSION)) {
        throw new ReviewStateDbVersionError(dbPath, version);
      }
      db.exec(REVIEW_STATE_DB_DDL);
    }
  } catch (error) {
    db.close();
    throw error;
  }
  connections.set(dbPath, db);
  return db;
}

export function readReviewStateDbSchemaVersion(
  db: DatabaseSync,
): string | null {
  // SAFETY: sqlite_master projects the integer literal `present`.
  const hasMeta = db
    .prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'review_state_meta'",
    )
    .get() as { present: number } | undefined;
  if (!hasMeta) return null;
  // SAFETY: review_state_meta.value is declared TEXT NOT NULL above.
  return (
    (
      db
        .prepare(
          "SELECT value FROM review_state_meta WHERE key = 'schema_version'",
        )
        .get() as { value: string } | undefined
    )?.value ?? null
  );
}

export function ensureReviewRegistration(
  reviewDir: string,
  home = defaultReviewHome(),
): void {
  const db = openReviewStateDb(home);
  db.prepare(
    `INSERT INTO reviews (review_id, review_dir, record_json) VALUES (?, ?, NULL)
     ON CONFLICT(review_id) DO UPDATE SET review_dir = excluded.review_dir`,
  ).run(reviewIdForDir(reviewDir), path.resolve(reviewDir));
}

export function putReviewRecord(
  reviewDir: string,
  record: JsonValue,
  home = defaultReviewHome(),
): void {
  const db = openReviewStateDb(home);
  const reviewId = reviewIdForDir(reviewDir);
  const recordJson = JSON.stringify(record);
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(
      `INSERT INTO reviews (review_id, review_dir, record_json) VALUES (?, ?, ?)
       ON CONFLICT(review_id) DO UPDATE SET
         review_dir = excluded.review_dir,
         record_json = excluded.record_json`,
    ).run(reviewId, path.resolve(reviewDir), recordJson);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function readReviewRecord(
  reviewDir: string,
  home = defaultReviewHome(),
): JsonValue | null {
  const dbPath = reviewStateDbPath(home);
  const recordPath = path.join(reviewDir, "review.json");
  if (!existsSync(dbPath) && !existsSync(recordPath)) return null;
  // SAFETY: reviews.record_json is a nullable TEXT column in the schema above.
  const row = openReviewStateDb(home)
    .prepare("SELECT record_json FROM reviews WHERE review_id = ?")
    .get(reviewIdForDir(reviewDir)) as
    | { record_json: string | null }
    | undefined;
  if (row?.record_json) return parseJsonText(row.record_json);
  if (!existsSync(recordPath)) return null;
  // Discovery must not import comment records before their schema migration.
  const record = parseJsonText(readFileSync(recordPath, "utf8"));
  putReviewRecord(reviewDir, record, home);
  return record;
}

export function importLegacyReview(
  reviewDir: string,
  home = defaultReviewHome(),
): void {
  const reviewId = reviewIdForDir(reviewDir);
  const recordPath = path.join(reviewDir, "review.json");
  const legacyDbPath = path.join(reviewDir, REVIEW_STATE_DB_FILENAME);
  if (!existsSync(recordPath) && !existsSync(legacyDbPath)) return;
  const db = openReviewStateDb(home);
  if (
    db
      .prepare("SELECT 1 FROM legacy_review_imports WHERE review_id = ?")
      .get(reviewId)
  ) {
    return;
  }
  const recordJson = existsSync(recordPath)
    ? readFileSync(recordPath, "utf8")
    : null;
  if (recordJson !== null) JSON.parse(recordJson);
  const legacy = existsSync(legacyDbPath)
    ? new DatabaseSync(legacyDbPath, { readOnly: true })
    : null;
  try {
    if (legacy) requireCurrentThreadDbSchema(legacy, legacyDbPath);
  } catch (error) {
    legacy?.close();
    throw error;
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(
      `INSERT INTO reviews (review_id, review_dir, record_json) VALUES (?, ?, ?)
       ON CONFLICT(review_id) DO UPDATE SET
         review_dir = excluded.review_dir,
         record_json = COALESCE(reviews.record_json, excluded.record_json)`,
    ).run(reviewId, path.resolve(reviewDir), recordJson);
    if (legacy) importLegacyCommentRows(db, legacy, reviewId);
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

function importLegacyCommentRows(
  target: DatabaseSync,
  legacy: DatabaseSync,
  reviewId: string,
): void {
  // SAFETY: sqlite_master.name is TEXT for every table row.
  const tables = new Set(
    (
      legacy
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as Array<{ name: string }>
    ).map((row) => row.name),
  );
  for (const table of ["comments", "comment_drafts"] as const) {
    if (!tables.has(table)) continue;
    const insert = target.prepare(
      `INSERT OR IGNORE INTO ${table}
       (review_id, route_path, thread_id, record_json) VALUES (?, '/', ?, ?)`,
    );
    // SAFETY: legacy Review v1-v6 tables declare both projected columns TEXT
    // NOT NULL; callers validate the legacy schema version before import.
    for (const row of legacy
      .prepare(`SELECT thread_id, record_json FROM ${table}`)
      .all() as Array<{ thread_id: string; record_json: string }>) {
      insert.run(reviewId, row.thread_id, row.record_json);
    }
  }
}

export function deleteReviewState(
  reviewDir: string,
  home = defaultReviewHome(),
): void {
  const dbPath = reviewStateDbPath(home);
  if (!existsSync(dbPath)) return;
  openReviewStateDb(home)
    .prepare("DELETE FROM reviews WHERE review_id = ?")
    .run(reviewIdForDir(reviewDir));
}

export interface StoredReviewDocumentState {
  mode: "compiled" | "incremental";
  revision: number;
  sourceHash: string | null;
  projection: JsonValue | null;
}

export function readReviewDocumentState(
  reviewDir: string,
  routePath: string,
): StoredReviewDocumentState | null {
  importLegacyReview(reviewDir);
  // SAFETY: the selected columns use the exact TEXT/INTEGER schema declared
  // above; projection_json and source_hash are the only nullable columns.
  const row = openReviewStateDb()
    .prepare(
      `SELECT mode, revision, source_hash, projection_json
       FROM documents WHERE review_id = ? AND route_path = ?`,
    )
    .get(reviewIdForDir(reviewDir), routePath) as
    | {
        mode: "compiled" | "incremental";
        revision: number;
        source_hash: string | null;
        projection_json: string | null;
      }
    | undefined;
  if (!row) return null;
  return {
    mode: row.mode,
    revision: row.revision,
    sourceHash: row.source_hash,
    projection: row.projection_json ? parseJsonText(row.projection_json) : null,
  };
}

export function putReviewDocumentState(
  reviewDir: string,
  routePath: string,
  state: StoredReviewDocumentState,
): void {
  ensureReviewRegistration(reviewDir);
  openReviewStateDb()
    .prepare(
      `INSERT INTO documents
       (review_id, route_path, mode, revision, source_hash, projection_json)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(review_id, route_path) DO UPDATE SET
         mode = excluded.mode,
         revision = excluded.revision,
         source_hash = excluded.source_hash,
         projection_json = excluded.projection_json`,
    )
    .run(
      reviewIdForDir(reviewDir),
      routePath,
      state.mode,
      state.revision,
      state.sourceHash,
      state.projection === null ? null : JSON.stringify(state.projection),
    );
}

export function readReviewMutationReceipt(
  reviewDir: string,
  mutationId: string,
): JsonValue | null {
  importLegacyReview(reviewDir);
  // SAFETY: mutation_receipts.response_json is declared TEXT NOT NULL.
  const row = openReviewStateDb()
    .prepare(
      "SELECT response_json FROM mutation_receipts WHERE review_id = ? AND mutation_id = ?",
    )
    .get(reviewIdForDir(reviewDir), mutationId) as
    | { response_json: string }
    | undefined;
  return row ? parseJsonText(row.response_json) : null;
}

export function commitReviewDocumentMutation(input: {
  reviewDir: string;
  routePath: string;
  mutationId: string;
  state: StoredReviewDocumentState;
  response: JsonValue;
  createdAt: string;
}): void {
  ensureReviewRegistration(input.reviewDir);
  const db = openReviewStateDb();
  const reviewId = reviewIdForDir(input.reviewDir);
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(
      `INSERT INTO documents
       (review_id, route_path, mode, revision, source_hash, projection_json)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(review_id, route_path) DO UPDATE SET
         mode = excluded.mode,
         revision = excluded.revision,
         source_hash = excluded.source_hash,
         projection_json = excluded.projection_json`,
    ).run(
      reviewId,
      input.routePath,
      input.state.mode,
      input.state.revision,
      input.state.sourceHash,
      input.state.projection === null
        ? null
        : JSON.stringify(input.state.projection),
    );
    db.prepare(
      `INSERT INTO mutation_receipts
       (review_id, mutation_id, revision, response_json, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      reviewId,
      input.mutationId,
      input.state.revision,
      JSON.stringify(input.response),
      input.createdAt,
    );
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function closeAllReviewStateDatabases(): void {
  for (const db of connections.values()) {
    try {
      db.close();
    } catch {
      // Already closed.
    }
  }
  connections.clear();
}
