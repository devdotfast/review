import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  ReviewCommentDraftThreadMapSchema,
  parseReviewCommentThreadMap,
  parseStoredReviewCommentThreadMap,
} from "./review-comment-schema";
import type {
  ReviewCommentDraftThreadMap,
  ReviewCommentThreadMap,
} from "./types";

// The review thread store persists comments in a per-review SQLite database.
// Its synchronous mutators rely on read-modify-write with no interleaving
// await. See review-state-store.ts.

export const REVIEW_THREAD_DB_FILENAME = "review.db";
export const REVIEW_THREAD_DB_SCHEMA_VERSION = 6;

export function reviewStateDir(reviewMdxPath: string): string {
  return path.dirname(path.resolve(reviewMdxPath));
}

export function reviewThreadDbPath(reviewMdxPath: string): string {
  return path.join(reviewStateDir(reviewMdxPath), REVIEW_THREAD_DB_FILENAME);
}

export class ReviewThreadDbVersionError extends Error {
  override readonly name = "ReviewThreadDbVersionError";

  constructor(dbPath: string, found: string | null) {
    super(
      `Review thread database ${dbPath} has schema version ` +
        `${found ?? "(missing)"}; this version of Review supports ` +
        `${REVIEW_THREAD_DB_SCHEMA_VERSION}. Run \`review migrate apply\`.`,
    );
  }
}

export interface ReviewThreadStoreBackend {
  readComments(): ReviewCommentThreadMap;
  writeComments(comments: ReviewCommentThreadMap): void;
  readCommentDrafts(): ReviewCommentDraftThreadMap;
  writeCommentDrafts(drafts: ReviewCommentDraftThreadMap): void;
  writeCommentState(
    comments: ReviewCommentThreadMap,
    drafts: ReviewCommentDraftThreadMap,
  ): void;
}

export function reviewThreadStoreBackend(
  reviewMdxPath: string,
): ReviewThreadStoreBackend {
  return sqliteThreadStoreBackend(reviewMdxPath);
}

// --- SQLite backend ----------------------------------------------------------

// The store keeps one keyed JSON record per thread. The polymorphic target
// stays in JSON. The generated status column supports ad-hoc sqlite3 triage.
const REVIEW_THREAD_DB_DDL = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS comments (
  thread_id   TEXT PRIMARY KEY,
  record_json TEXT NOT NULL CHECK (json_valid(record_json)),
  status      TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.status')) STORED
);
CREATE TABLE IF NOT EXISTS comment_drafts (
  thread_id   TEXT PRIMARY KEY,
  record_json TEXT NOT NULL CHECK (json_valid(record_json))
);
`;

const REVIEW_THREAD_DB_V1_TO_V2_DDL = `
CREATE TABLE IF NOT EXISTS comment_drafts (
  thread_id   TEXT PRIMARY KEY,
  record_json TEXT NOT NULL CHECK (json_valid(record_json))
);
`;

const REVIEW_THREAD_DB_V2_TO_V3_DDL = "DROP TABLE IF EXISTS questions;";

const openDatabases = new Map<string, DatabaseSync>();

function openThreadDb(
  dbPath: string,
  options: { create: boolean },
): DatabaseSync | null {
  const cached = openDatabases.get(dbPath);
  if (cached) return cached;
  const existed = existsSync(dbPath);
  if (!options.create && !existed) return null;
  if (options.create) {
    mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(
      "PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;",
    );
    const version = existed ? readThreadDbSchemaVersion(db) : null;
    const hasThreadTables =
      existed &&
      Boolean(
        db
          .prepare(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name IN ('comments', 'comment_drafts') LIMIT 1",
          )
          .get(),
      );
    if (!existed || (version === null && !hasThreadTables)) {
      db.exec(REVIEW_THREAD_DB_DDL);
      db.prepare(
        "INSERT INTO meta (key, value) VALUES ('schema_version', ?)",
      ).run(String(REVIEW_THREAD_DB_SCHEMA_VERSION));
    } else if (version !== String(REVIEW_THREAD_DB_SCHEMA_VERSION)) {
      throw new ReviewThreadDbVersionError(dbPath, version);
    }
  } catch (error) {
    db.close();
    throw error;
  }
  openDatabases.set(dbPath, db);
  return db;
}

function readThreadDbSchemaVersion(db: DatabaseSync): string | null {
  const hasMeta = db
    .prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'meta'",
    )
    .get() as { present: number } | undefined;
  if (!hasMeta) return null;
  return (
    (
      db
        .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
        .get() as { value: string } | undefined
    )?.value ?? null
  );
}

export type ReviewThreadDbMigrationResult = "missing" | "current" | "upgraded";

export interface ReviewThreadDbMigrationOptions {
  force?: boolean;
  migrateLegacyCodeRecord?: (
    record: unknown,
    kind: "comment" | "comment-draft",
  ) => Promise<unknown>;
  onDropLegacyCodeRecord?: (input: {
    threadId: string;
    kind: "comment" | "comment-draft";
    error: unknown;
  }) => void;
}

/** Upgrade an existing thread database. Runtime database access never calls this. */
export async function migrateReviewThreadDb(
  reviewMdxPath: string,
  options: ReviewThreadDbMigrationOptions = {},
): Promise<ReviewThreadDbMigrationResult> {
  const dbPath = reviewThreadDbPath(reviewMdxPath);
  if (!existsSync(dbPath)) return "missing";
  const cached = openDatabases.get(dbPath);
  if (cached) {
    cached.close();
    openDatabases.delete(dbPath);
  }
  const db = new DatabaseSync(dbPath);
  let inTransaction = false;
  try {
    db.exec("PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE;");
    inTransaction = true;
    const version = readThreadDbSchemaVersion(db);
    if (version === String(REVIEW_THREAD_DB_SCHEMA_VERSION)) {
      db.exec("COMMIT");
      inTransaction = false;
      return "current";
    }
    if (
      version !== "1" &&
      version !== "2" &&
      version !== "3" &&
      version !== "4" &&
      version !== "5"
    ) {
      throw new ReviewThreadDbVersionError(dbPath, version);
    }
    if (version === "1") db.exec(REVIEW_THREAD_DB_V1_TO_V2_DDL);
    if (version === "1" || version === "2") {
      db.exec(REVIEW_THREAD_DB_V2_TO_V3_DDL);
    }
    if (hasLegacyCodeTargets(db)) {
      if (!options.migrateLegacyCodeRecord) {
        throw new Error(
          `Review thread database ${dbPath} contains code comments that need ` +
            "the diff-aware position migration.",
        );
      }
      await migrateLegacyCodeRecords(db, options.migrateLegacyCodeRecord, {
        force: options.force ?? false,
        onDrop: options.onDropLegacyCodeRecord,
      });
      if (hasLegacyCodeTargets(db)) {
        throw new Error(
          `Review thread database ${dbPath} still contains legacy code comments.`,
        );
      }
    }
    migrateNativeAgentSessionRecords(db);
    const updated = db
      .prepare(
        "UPDATE meta SET value = ? WHERE key = 'schema_version' AND value = ?",
      )
      .run(String(REVIEW_THREAD_DB_SCHEMA_VERSION), version);
    if (updated.changes !== 1) {
      throw new Error(`Could not update the schema version in ${dbPath}.`);
    }
    db.exec("COMMIT");
    inTransaction = false;
    return "upgraded";
  } catch (error) {
    if (inTransaction) db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }
}

/** Normalize message markers and remove provider provenance before validation. */
function migrateNativeAgentSessionRecords(db: DatabaseSync): void {
  for (const table of ["comments", "comment_drafts"] as const) {
    const rows = db
      .prepare(`SELECT thread_id, record_json FROM ${table}`)
      .all() as Array<{ thread_id: string; record_json: string }>;
    const update = db.prepare(
      `UPDATE ${table} SET record_json = ? WHERE thread_id = ?`,
    );
    for (const row of rows) {
      const value: unknown = JSON.parse(row.record_json);
      const migrated = migrateNativeAgentSessionRecord(value, table);
      if (migrated !== value) {
        update.run(JSON.stringify(migrated), row.thread_id);
      }
    }
  }
}

function migrateNativeAgentSessionRecord(
  value: unknown,
  table: "comments" | "comment_drafts",
): unknown {
  if (!isRecord(value)) return value;
  if (table === "comment_drafts") {
    if (!isRecord(value.thread)) return value;
    const thread = migrateNativeAgentSessionThread(value.thread);
    return thread === value.thread ? value : { ...value, thread };
  }
  return migrateNativeAgentSessionThread(value);
}

function migrateNativeAgentSessionThread(
  thread: Record<string, unknown>,
): Record<string, unknown> {
  const originalMessages = Array.isArray(thread.messages)
    ? thread.messages
    : undefined;
  const migratedMessages = originalMessages
    ? originalMessages.map((message) => {
        if (!isRecord(message)) return message;
        const agentInput = message.agentInput === true;
        if (!("native" in message) && message.agentInput === agentInput) {
          return message;
        }
        const preserved: Record<string, unknown> = { ...message, agentInput };
        delete preserved.native;
        return preserved;
      })
    : undefined;
  const messagesChanged =
    originalMessages !== undefined &&
    migratedMessages!.some(
      (message, index) => message !== originalMessages[index],
    );
  const migratedThread = messagesChanged
    ? { ...thread, messages: migratedMessages }
    : thread;
  if (!("agentSession" in migratedThread)) return migratedThread;
  const session = migratedThread.agentSession;
  const preserved = { ...migratedThread };
  delete preserved.agentSession;
  if (
    !isRecord(session) ||
    (session.harness !== "claude-code" &&
      session.harness !== "codex" &&
      session.harness !== "pi") ||
    typeof session.sessionId !== "string" ||
    !session.sessionId
  ) {
    return preserved;
  }
  return {
    ...preserved,
    agentSession: {
      harness: session.harness,
      sessionId: session.sessionId,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function migrateLegacyCodeRecords(
  db: DatabaseSync,
  migrate: NonNullable<
    ReviewThreadDbMigrationOptions["migrateLegacyCodeRecord"]
  >,
  options: {
    force: boolean;
    onDrop?: ReviewThreadDbMigrationOptions["onDropLegacyCodeRecord"];
  },
): Promise<void> {
  const tables = [
    { name: "comments", kind: "comment" },
    { name: "comment_drafts", kind: "comment-draft" },
  ] as const;
  for (const table of tables) {
    const rows = db
      .prepare(`SELECT thread_id, record_json FROM ${table.name}`)
      .all() as Array<{ thread_id: string; record_json: string }>;
    for (const row of rows) {
      const current = JSON.parse(row.record_json) as unknown;
      let migrated: unknown;
      try {
        migrated = await migrate(current, table.kind);
      } catch (error) {
        if (!options.force) throw error;
        db.prepare(`DELETE FROM ${table.name} WHERE thread_id = ?`).run(
          row.thread_id,
        );
        options.onDrop?.({
          threadId: row.thread_id,
          kind: table.kind,
          error,
        });
        continue;
      }
      if (migrated === current) continue;
      db.prepare(
        `UPDATE ${table.name} SET record_json = ? WHERE thread_id = ?`,
      ).run(JSON.stringify(migrated), row.thread_id);
    }
  }
}

function hasLegacyCodeTargets(db: DatabaseSync): boolean {
  const comment = db
    .prepare(
      "SELECT 1 FROM comments " +
        "WHERE json_extract(record_json, '$.target.kind') = 'code' " +
        "AND json_type(record_json, '$.target.position') IS NULL LIMIT 1",
    )
    .get();
  if (comment) return true;
  const draft = db
    .prepare(
      "SELECT 1 FROM comment_drafts " +
        "WHERE json_extract(record_json, '$.thread.target.kind') = 'code' " +
        "AND json_type(record_json, '$.thread.target.position') IS NULL " +
        "LIMIT 1",
    )
    .get();
  return Boolean(draft);
}

function readThreadTable<T>(
  dbPath: string,
  table: "comments" | "comment_drafts",
  keyColumn: "thread_id",
): Record<string, T> {
  const db = openThreadDb(dbPath, { create: false });
  if (!db) return {};
  const rows = db
    .prepare(`SELECT ${keyColumn} AS key, record_json FROM ${table}`)
    .all() as Array<{ key: string; record_json: string }>;
  const result: Record<string, T> = {};
  for (const row of rows) {
    result[row.key] = JSON.parse(row.record_json) as T;
  }
  return result;
}

function writeThreadTable(
  dbPath: string,
  table: "comments" | "comment_drafts",
  keyColumn: "thread_id",
  value: Record<string, unknown>,
): void {
  const db = openThreadDb(dbPath, { create: true });
  if (!db) throw new Error(`Could not open ${dbPath}.`);
  const insert = db.prepare(
    `INSERT INTO ${table} (${keyColumn}, record_json) VALUES (?, ?)`,
  );
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`DELETE FROM ${table}`);
    for (const [key, record] of Object.entries(value)) {
      insert.run(key, JSON.stringify(record));
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function writeCommentState(
  dbPath: string,
  comments: ReviewCommentThreadMap,
  drafts: ReviewCommentDraftThreadMap,
): void {
  const db = openThreadDb(dbPath, { create: true });
  if (!db) throw new Error(`Could not open ${dbPath}.`);
  const insertComment = db.prepare(
    "INSERT INTO comments (thread_id, record_json) VALUES (?, ?)",
  );
  const insertDraft = db.prepare(
    "INSERT INTO comment_drafts (thread_id, record_json) VALUES (?, ?)",
  );
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec("DELETE FROM comments; DELETE FROM comment_drafts;");
    for (const [threadId, record] of Object.entries(
      parseStoredReviewCommentThreadMap(comments),
    )) {
      insertComment.run(threadId, JSON.stringify(record));
    }
    for (const [threadId, record] of Object.entries(
      ReviewCommentDraftThreadMapSchema.parse(drafts),
    )) {
      insertDraft.run(threadId, JSON.stringify(record));
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function sqliteThreadStoreBackend(
  reviewMdxPath: string,
): ReviewThreadStoreBackend {
  const dbPath = reviewThreadDbPath(reviewMdxPath);
  return {
    readComments: () => readValidComments(dbPath),
    writeComments: (comments) =>
      writeThreadTable(
        dbPath,
        "comments",
        "thread_id",
        parseStoredReviewCommentThreadMap(comments),
      ),
    readCommentDrafts: () =>
      ReviewCommentDraftThreadMapSchema.parse(
        readThreadTable<unknown>(dbPath, "comment_drafts", "thread_id"),
      ),
    writeCommentDrafts: (drafts) =>
      writeThreadTable(
        dbPath,
        "comment_drafts",
        "thread_id",
        ReviewCommentDraftThreadMapSchema.parse(drafts),
      ),
    writeCommentState: (comments, drafts) =>
      writeCommentState(dbPath, comments, drafts),
  };
}

function readValidComments(dbPath: string): ReviewCommentThreadMap {
  const stored = readThreadTable<unknown>(dbPath, "comments", "thread_id");
  const comments = parseReviewCommentThreadMap(stored);
  const dropped = Object.keys(stored).filter((key) => !(key in comments));
  if (dropped.length === 0) return comments;
  console.error(
    `[Review] Dropped ${dropped.length} malformed comment record${dropped.length === 1 ? "" : "s"} from ${dbPath}: ${dropped.join(", ")}`,
  );
  writeThreadTable(dbPath, "comments", "thread_id", comments);
  return comments;
}

/**
 * Create an empty thread database. Called while scaffolding a fresh review dir
 * so the database's presence marks the review sqlite-first from birth. Not
 * cached: the scaffold may be rolled back (rm -rf) on a later failure.
 */
export function createReviewThreadDb(reviewDir: string): void {
  const dbPath = path.join(reviewDir, REVIEW_THREAD_DB_FILENAME);
  const cached = openDatabases.get(dbPath);
  if (cached) {
    cached.close();
    openDatabases.delete(dbPath);
  }
  const db = openThreadDb(dbPath, { create: true });
  if (db) {
    db.close();
    openDatabases.delete(dbPath);
  }
}

/** Close every cached connection (test cleanup). */
export function closeAllReviewThreadStores(): void {
  for (const db of openDatabases.values()) {
    try {
      db.close();
    } catch {
      // Already closed — nothing to release.
    }
  }
  openDatabases.clear();
}
