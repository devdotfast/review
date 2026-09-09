import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";

import type { JsonValue } from "@dev.fast/review-protocol";
import {
  isCallableValue,
  isObjectValue,
  parseJsonText,
} from "@dev.fast/review-protocol";

import { devReviewHome } from "./review-storage";
import { requireCurrentThreadDbSchema } from "./review-thread-db-schema";

export const REVIEW_STATE_DB_FILENAME = "review.db";
export const REVIEW_STATE_DB_SCHEMA_VERSION = 2;

export const REVIEW_STATE_DB_V1_DDL = `
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

export const REVIEW_STATE_DB_V2_DDL = `
CREATE TABLE IF NOT EXISTS publications (
  review_id TEXT NOT NULL REFERENCES reviews(review_id) ON DELETE CASCADE,
  publication_id TEXT NOT NULL CHECK (length(publication_id) = 40),
  kind TEXT NOT NULL CHECK (kind IN ('document','map')),
  seq INTEGER NOT NULL CHECK (seq > 0),
  created_at TEXT NOT NULL,
  operation TEXT NOT NULL,
  artifact_hash TEXT CHECK (artifact_hash IS NULL OR length(artifact_hash) = 64),
  previous_publication_id TEXT,
  legacy_commit TEXT,
  record_json TEXT NOT NULL CHECK (json_valid(record_json)),
  PRIMARY KEY (review_id, publication_id)
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS publications_by_seq ON publications(review_id, seq);
CREATE INDEX IF NOT EXISTS publications_by_kind ON publications(review_id, kind, seq);
CREATE INDEX IF NOT EXISTS publications_by_legacy_commit ON publications(review_id, kind, legacy_commit);
CREATE TABLE IF NOT EXISTS legacy_artifact_imports (
  review_id TEXT PRIMARY KEY REFERENCES reviews(review_id) ON DELETE CASCADE,
  imported_at TEXT NOT NULL,
  source_head TEXT,
  versions INTEGER NOT NULL CHECK (versions >= 0),
  unavailable INTEGER NOT NULL CHECK (unavailable >= 0),
  legacy_removed_at TEXT
) STRICT;
`;

const MIGRATIONS: ReadonlyArray<{
  from: number;
  apply: (db: DatabaseSync) => void;
}> = [{ from: 1, apply: (db) => db.exec(REVIEW_STATE_DB_V2_DDL) }];

const connections = new Map<string, DatabaseSync>();

export class ReviewStateDbVersionError extends Error {
  override readonly name = "ReviewStateDbVersionError";

  constructor(dbPath: string, found: string | null) {
    const numeric = found === null ? Number.NaN : Number(found);
    const isNewer =
      Number.isFinite(numeric) && numeric > REVIEW_STATE_DB_SCHEMA_VERSION;
    super(
      isNewer
        ? `Review state database ${dbPath} has schema version ${found}; ` +
            `this version of Review supports ${REVIEW_STATE_DB_SCHEMA_VERSION}. ` +
            `The database was written by a newer Review; upgrade Review.`
        : `Review state database ${dbPath} has schema version ` +
            `${found ?? "(missing)"}; this version of Review supports ` +
            `${REVIEW_STATE_DB_SCHEMA_VERSION}. Run \`review migrate apply\`.`,
    );
  }
}

export class ReviewPublicationConflictError extends Error {
  override readonly name = "ReviewPublicationConflictError";

  constructor(reviewDir: string, publicationId: string) {
    super(
      `Publication ${publicationId} for review ${reviewDir} already exists ` +
        `with a different record.`,
    );
  }
}

export function reviewHomeForDir(reviewDir: string): string {
  const parent = path.dirname(path.resolve(reviewDir));
  return path.basename(parent) === "reviews"
    ? path.dirname(parent)
    : devReviewHome();
}

export function reviewStateDbPath(home = devReviewHome()): string {
  return path.join(path.resolve(home), REVIEW_STATE_DB_FILENAME);
}

export function reviewIdForDir(reviewDir: string): string {
  const reviewId = path.basename(path.resolve(reviewDir));
  if (!reviewId)
    throw new Error(`Review directory has no identifier: ${reviewDir}`);
  return reviewId;
}

export function openReviewStateDb(home = devReviewHome()): DatabaseSync {
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
      db.exec(REVIEW_STATE_DB_V1_DDL);
      db.exec(REVIEW_STATE_DB_V2_DDL);
      db.prepare(
        "INSERT INTO review_state_meta (key, value) VALUES ('schema_version', ?)",
      ).run(String(REVIEW_STATE_DB_SCHEMA_VERSION));
    } else {
      const version = readReviewStateDbSchemaVersion(db);
      const versionNumber = version === null ? Number.NaN : Number(version);
      if (
        !Number.isFinite(versionNumber) ||
        versionNumber > REVIEW_STATE_DB_SCHEMA_VERSION
      ) {
        throw new ReviewStateDbVersionError(dbPath, version);
      } else if (versionNumber === REVIEW_STATE_DB_SCHEMA_VERSION) {
        db.exec(REVIEW_STATE_DB_V1_DDL);
        db.exec(REVIEW_STATE_DB_V2_DDL);
      } else {
        db.exec("BEGIN IMMEDIATE");
        try {
          for (const step of MIGRATIONS) {
            if (step.from >= versionNumber) step.apply(db);
          }
          db.prepare(
            "UPDATE review_state_meta SET value = ? WHERE key = 'schema_version'",
          ).run(String(REVIEW_STATE_DB_SCHEMA_VERSION));
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      }
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
  home = reviewHomeForDir(reviewDir),
): void {
  const db = openReviewStateDb(home);
  db.prepare(
    `INSERT INTO reviews (review_id, review_dir, record_json) VALUES (?, ?, NULL)
     ON CONFLICT(review_id) DO UPDATE SET review_dir = excluded.review_dir`,
  ).run(reviewIdForDir(reviewDir), path.resolve(reviewDir));
}

/**
 * A synchronous BEGIN IMMEDIATE/COMMIT scope on one review state connection.
 * `fn` must not hold the transaction across an `await`; it must return
 * synchronously, never a thenable.
 */
export interface ReviewStateTransaction {
  readonly db: DatabaseSync;
  readonly home: string;
}

const openTransactionConnections = new WeakSet<DatabaseSync>();

function isThenable(value: unknown): value is PromiseLike<unknown> {
  if (!isObjectValue(value)) return false;
  // SAFETY: only probing for an optional `then` method to detect a thenable;
  // isCallableValue rejects anything that is not actually a function.
  return isCallableValue((value as { then?: unknown }).then);
}

export function withReviewStateTransaction<T>(
  home: string,
  fn: (tx: ReviewStateTransaction) => T,
  hooks?: { beforeCommit?: () => void },
): T {
  const db = openReviewStateDb(home);
  if (openTransactionConnections.has(db)) {
    throw new Error(
      "withReviewStateTransaction cannot be nested on the same review " +
        "state connection",
    );
  }
  openTransactionConnections.add(db);
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn({ db, home });
    if (isThenable(result)) {
      throw new TypeError(
        "withReviewStateTransaction's callback must be synchronous; it " +
          "returned a thenable",
      );
    }
    hooks?.beforeCommit?.();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    openTransactionConnections.delete(db);
  }
}

export function putReviewRecordInTransaction(
  tx: ReviewStateTransaction,
  reviewDir: string,
  record: JsonValue,
): void {
  tx.db
    .prepare(
      `INSERT INTO reviews (review_id, review_dir, record_json) VALUES (?, ?, ?)
       ON CONFLICT(review_id) DO UPDATE SET
         review_dir = excluded.review_dir,
         record_json = excluded.record_json`,
    )
    .run(
      reviewIdForDir(reviewDir),
      path.resolve(reviewDir),
      JSON.stringify(record),
    );
}

export function readReviewRecordInTransaction(
  tx: ReviewStateTransaction,
  reviewDir: string,
): JsonValue | null {
  // SAFETY: reviews.record_json is a nullable TEXT column in the schema above.
  const row = tx.db
    .prepare("SELECT record_json FROM reviews WHERE review_id = ?")
    .get(reviewIdForDir(reviewDir)) as
    | { record_json: string | null }
    | undefined;
  return row?.record_json ? parseJsonText(row.record_json) : null;
}

export function putReviewRecord(
  reviewDir: string,
  record: JsonValue,
  home = reviewHomeForDir(reviewDir),
): void {
  withReviewStateTransaction(home, (tx) =>
    putReviewRecordInTransaction(tx, reviewDir, record),
  );
}

export function readReviewRecord(
  reviewDir: string,
  home = reviewHomeForDir(reviewDir),
  options?: { importMirror?: boolean },
): JsonValue | null {
  const importMirror = options?.importMirror ?? true;
  const dbPath = reviewStateDbPath(home);
  const recordPath = path.join(reviewDir, "review.json");
  if (!existsSync(dbPath) && !existsSync(recordPath)) return null;
  const row = readReviewRecordInTransaction(
    { db: openReviewStateDb(home), home },
    reviewDir,
  );
  if (row !== null) return row;
  if (!existsSync(recordPath)) return null;
  // Discovery must not import comment records before their schema migration.
  const record = parseJsonText(readFileSync(recordPath, "utf8"));
  if (importMirror) putReviewRecord(reviewDir, record, home);
  return record;
}

export function importLegacyReview(
  reviewDir: string,
  home = reviewHomeForDir(reviewDir),
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
  try {
    withReviewStateTransaction(home, (tx) => {
      tx.db
        .prepare(
          `INSERT INTO reviews (review_id, review_dir, record_json) VALUES (?, ?, ?)
           ON CONFLICT(review_id) DO UPDATE SET
             review_dir = excluded.review_dir,
             record_json = COALESCE(reviews.record_json, excluded.record_json)`,
        )
        .run(reviewId, path.resolve(reviewDir), recordJson);
      if (legacy) importLegacyCommentRows(tx.db, legacy, reviewId);
      tx.db
        .prepare(
          "INSERT INTO legacy_review_imports (review_id, imported_at) VALUES (?, ?)",
        )
        .run(reviewId, new Date().toISOString());
    });
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

export type ReviewPublicationKind = "document" | "map";

export interface ReviewPublicationRow {
  publicationId: string;
  kind: ReviewPublicationKind;
  seq: number;
  createdAt: string;
  operation: string;
  artifactHash: string | null;
  previousPublicationId: string | null;
  legacyCommit: string | null;
  record: JsonValue;
}

function mapPublicationRow(
  row: Record<string, SQLOutputValue>,
): ReviewPublicationRow {
  // SAFETY: the projected columns match REVIEW_STATE_DB_V2_DDL's publications
  // table: every column is NOT NULL except artifact_hash,
  // previous_publication_id and legacy_commit, and kind is CHECK-constrained
  // to 'document' | 'map'.
  return {
    publicationId: row.publication_id as string,
    kind: row.kind as ReviewPublicationKind,
    seq: row.seq as number,
    createdAt: row.created_at as string,
    operation: row.operation as string,
    artifactHash: row.artifact_hash as string | null,
    previousPublicationId: row.previous_publication_id as string | null,
    legacyCommit: row.legacy_commit as string | null,
    record: parseJsonText(row.record_json as string),
  };
}

const PUBLICATION_COLUMNS =
  "publication_id, kind, seq, created_at, operation, artifact_hash, " +
  "previous_publication_id, legacy_commit, record_json";

export interface ReviewPublicationInsertOutcome {
  seq: number;
  existing: boolean;
}

export function insertPublicationInTransaction(
  tx: ReviewStateTransaction,
  reviewDir: string,
  input: {
    publicationId: string;
    kind: ReviewPublicationKind;
    record: JsonValue;
    createdAt: string;
    operation: string;
    artifactHash: string | null;
    previousPublicationId: string | null;
    legacyCommit?: string | null;
    seq?: number;
  },
): ReviewPublicationInsertOutcome {
  const reviewId = reviewIdForDir(reviewDir);
  const recordJson = JSON.stringify(input.record);
  const existingRow = tx.db
    .prepare(
      "SELECT seq, record_json FROM publications WHERE review_id = ? AND publication_id = ?",
    )
    .get(reviewId, input.publicationId);
  if (existingRow) {
    // SAFETY: publications.record_json is TEXT NOT NULL by
    // REVIEW_STATE_DB_V2_DDL.
    if ((existingRow.record_json as string) === recordJson) {
      // SAFETY: publications.seq is INTEGER NOT NULL by REVIEW_STATE_DB_V2_DDL.
      return { seq: existingRow.seq as number, existing: true };
    }
    throw new ReviewPublicationConflictError(reviewDir, input.publicationId);
  }
  const nextSeqRow = tx.db
    .prepare(
      "SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM publications WHERE review_id = ?",
    )
    .get(reviewId);
  // SAFETY: COALESCE(MAX(seq), 0) + 1 always projects one INTEGER `next`.
  const seq = input.seq ?? (nextSeqRow?.next as number);
  tx.db
    .prepare(
      `INSERT INTO publications
       (review_id, publication_id, kind, seq, created_at, operation, artifact_hash, previous_publication_id, legacy_commit, record_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      reviewId,
      input.publicationId,
      input.kind,
      seq,
      input.createdAt,
      input.operation,
      input.artifactHash,
      input.previousPublicationId,
      input.legacyCommit ?? null,
      recordJson,
    );
  return { seq, existing: false };
}

export function readPublicationInTransaction(
  tx: ReviewStateTransaction,
  reviewDir: string,
  publicationId: string,
  kind: ReviewPublicationKind,
): ReviewPublicationRow | null {
  const row = tx.db
    .prepare(
      `SELECT ${PUBLICATION_COLUMNS} FROM publications
       WHERE review_id = ? AND publication_id = ?`,
    )
    .get(reviewIdForDir(reviewDir), publicationId);
  if (!row || row.kind !== kind) return null;
  return mapPublicationRow(row);
}

export function readPublication(
  reviewDir: string,
  publicationId: string,
  kind: ReviewPublicationKind,
  home = reviewHomeForDir(reviewDir),
): ReviewPublicationRow | null {
  return readPublicationInTransaction(
    { db: openReviewStateDb(home), home },
    reviewDir,
    publicationId,
    kind,
  );
}

export function listPublications(
  reviewDir: string,
  kind: ReviewPublicationKind,
  home = reviewHomeForDir(reviewDir),
): ReviewPublicationRow[] {
  const rows = openReviewStateDb(home)
    .prepare(
      `SELECT ${PUBLICATION_COLUMNS} FROM publications
       WHERE review_id = ? AND kind = ? ORDER BY seq DESC`,
    )
    .all(reviewIdForDir(reviewDir), kind);
  return rows.map(mapPublicationRow);
}

export function resolveLegacyMapPublicationId(
  reviewDir: string,
  commit: string,
  home = reviewHomeForDir(reviewDir),
): string | null {
  // SAFETY: publications.publication_id is TEXT NOT NULL by
  // REVIEW_STATE_DB_V2_DDL.
  const row = openReviewStateDb(home)
    .prepare(
      `SELECT publication_id FROM publications
       WHERE review_id = ? AND kind = 'map' AND legacy_commit = ?`,
    )
    .get(reviewIdForDir(reviewDir), commit) as
    | { publication_id: string }
    | undefined;
  return row?.publication_id ?? null;
}

export interface ReviewLegacyArtifactImportRow {
  importedAt: string;
  sourceHead: string | null;
  versions: number;
  unavailable: number;
  legacyRemovedAt: string | null;
}

export function insertLegacyArtifactImportInTransaction(
  tx: ReviewStateTransaction,
  reviewDir: string,
  input: {
    importedAt: string;
    sourceHead: string | null;
    versions: number;
    unavailable: number;
  },
): void {
  tx.db
    .prepare(
      `INSERT INTO legacy_artifact_imports
       (review_id, imported_at, source_head, versions, unavailable, legacy_removed_at)
       VALUES (?, ?, ?, ?, ?, NULL)`,
    )
    .run(
      reviewIdForDir(reviewDir),
      input.importedAt,
      input.sourceHead,
      input.versions,
      input.unavailable,
    );
}

export function readLegacyArtifactImport(
  reviewDir: string,
  home = reviewHomeForDir(reviewDir),
): ReviewLegacyArtifactImportRow | null {
  // SAFETY: the projected columns match REVIEW_STATE_DB_V2_DDL's
  // legacy_artifact_imports table; only legacy_removed_at is nullable there.
  const row = openReviewStateDb(home)
    .prepare(
      `SELECT imported_at, source_head, versions, unavailable, legacy_removed_at
       FROM legacy_artifact_imports WHERE review_id = ?`,
    )
    .get(reviewIdForDir(reviewDir)) as
    | {
        imported_at: string;
        source_head: string | null;
        versions: number;
        unavailable: number;
        legacy_removed_at: string | null;
      }
    | undefined;
  if (!row) return null;
  return {
    importedAt: row.imported_at,
    sourceHead: row.source_head,
    versions: row.versions,
    unavailable: row.unavailable,
    legacyRemovedAt: row.legacy_removed_at,
  };
}

export function deleteReviewState(
  reviewDir: string,
  home = reviewHomeForDir(reviewDir),
): void {
  const dbPath = reviewStateDbPath(home);
  if (!existsSync(dbPath)) return;
  openReviewStateDb(home)
    .prepare("DELETE FROM reviews WHERE review_id = ?")
    .run(reviewIdForDir(reviewDir));
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
