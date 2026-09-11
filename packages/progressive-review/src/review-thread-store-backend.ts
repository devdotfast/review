import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  type JsonObject,
  type JsonValue,
  isJsonObject,
  parseJsonText,
} from "@dev.fast/review-protocol";
import {
  ReviewCommentAgentSessionSchema,
  ReviewCommentDraftThreadMapSchema,
  parseReviewCommentThreadMap,
  parseStoredReviewCommentThreadMap,
} from "@dev.fast/review-protocol";
import { z } from "zod";

import {
  REVIEW_THREAD_DB_SCHEMA_VERSION,
  ReviewThreadDbVersionError,
  readThreadDbSchemaVersion,
  requireCurrentThreadDbSchema,
} from "./review-thread-db-schema";

export {
  REVIEW_THREAD_DB_SCHEMA_VERSION,
  ReviewThreadDbVersionError,
} from "./review-thread-db-schema";

import {
  REVIEW_STATE_DB_SCHEMA_VERSION,
  ReviewStateDbVersionError,
  closeAllReviewStateDatabases,
  ensureReviewRegistration,
  importLegacyReview,
  openReviewStateDb,
  readReviewStateDbSchemaVersion,
  reviewHomeForDir,
  reviewIdForDir,
  reviewStateDbPath,
} from "./review-state-db";
import type {
  ReviewCommentDraftThreadMap,
  ReviewCommentThreadMap,
} from "./types";

// Comments for every review share the Review home database. All queries are
// scoped by review_id and route_path; the per-review review.db name is retained
// only as a legacy migration input.

export const REVIEW_THREAD_DB_FILENAME = "review.db";

const LEGACY_THREAD_DB_SCHEMA_VERSIONS = new Set([
  "1",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
]);

function isSupportedThreadDbVersion(version: string | null): version is string {
  return (
    version === String(REVIEW_THREAD_DB_SCHEMA_VERSION) ||
    (version !== null && LEGACY_THREAD_DB_SCHEMA_VERSIONS.has(version))
  );
}

export function reviewStateDir(reviewMdxPath: string): string {
  return path.dirname(path.resolve(reviewMdxPath));
}

export function reviewThreadDbPath(reviewMdxPath: string): string {
  const shared = reviewStateDbPath(
    reviewHomeForDir(reviewStateDir(reviewMdxPath)),
  );

  const legacy = legacyReviewThreadDbPath(reviewMdxPath);

  if (!existsSync(legacy)) return shared;

  if (!existsSync(shared)) return legacy;

  const imported = withDatabaseSnapshot(shared, (snapshotPath) => {
    const db = new DatabaseSync(snapshotPath, { readOnly: true });

    try {
      return Boolean(
        db
          .prepare("SELECT 1 FROM legacy_review_imports WHERE review_id = ?")
          .get(reviewIdForDir(reviewStateDir(reviewMdxPath))),
      );
    } finally {
      db.close();
    }
  });

  return imported ? shared : legacy;
}

export function legacyReviewThreadDbPath(reviewMdxPath: string): string {
  return path.join(reviewStateDir(reviewMdxPath), REVIEW_THREAD_DB_FILENAME);
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

const StoredThreadRowSchema = z.object({
  thread_id: z.string(),
  record_json: z.string(),
});

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

    if (!existed) {
      db.exec(REVIEW_THREAD_DB_DDL);
      db.prepare(
        "INSERT INTO meta (key, value) VALUES ('schema_version', ?)",
      ).run(String(REVIEW_THREAD_DB_SCHEMA_VERSION));
    } else {
      const version = readThreadDbSchemaVersion(db);

      if (version !== String(REVIEW_THREAD_DB_SCHEMA_VERSION)) {
        throw new ReviewThreadDbVersionError(dbPath, version);
      }
    }
  } catch (error) {
    db.close();
    throw error;
  }

  openDatabases.set(dbPath, db);

  return db;
}

export function checkReviewThreadDbVersion(reviewMdxPath: string): void {
  const dbPath = legacyReviewThreadDbPath(reviewMdxPath);

  if (!existsSync(dbPath)) return;
  const db = new DatabaseSync(dbPath, { readOnly: true });

  try {
    requireCurrentThreadDbSchema(db, dbPath);
  } finally {
    db.close();
  }
}

/** A snapshot taken from a verified copy. `revision` is always 0 because a copy
 * cannot participate in the writer's revision sequence. `readOnly` tells a
 * reader this is not a writable store at revision 0. */
export interface ReviewThreadsReadOnlySnapshot {
  readonly readOnly: true;
  readonly revision: 0;
  readonly comments: ReviewCommentThreadMap;
  readonly drafts: ReviewCommentDraftThreadMap;
}

/** Cheap change detector for a cached read-only snapshot: every thread write
 * changes the database file or its write-ahead log. */
export function reviewThreadDbSnapshotToken(reviewMdxPath: string): string {
  const dbPath = reviewThreadDbPath(reviewMdxPath);

  const stamp = (filePath: string): string => {
    try {
      const stats = statSync(filePath);

      return `${stats.ino}:${stats.size}:${stats.mtimeMs}`;
    } catch {
      return "absent";
    }
  };

  return `${stamp(dbPath)}|${stamp(`${dbPath}-wal`)}`;
}

/** SQLite readOnly still changes WAL reader marks in SHM. Recovery therefore
 * reads a verified DB+WAL copy and never opens SQLite on the original files. */
export function readReviewThreadsReadOnly(
  reviewMdxPath: string,
): ReviewThreadsReadOnlySnapshot {
  return withThreadDatabaseSnapshot(reviewMdxPath, (snapshotPath, dbPath) =>
    readThreadDatabaseSnapshot(
      snapshotPath,
      dbPath,
      reviewIdForDir(reviewStateDir(reviewMdxPath)),
    ),
  );
}

function withThreadDatabaseSnapshot<T>(
  reviewMdxPath: string,
  read: (snapshotPath: string, dbPath: string) => T,
): T {
  const dbPath = reviewThreadDbPath(reviewMdxPath);

  return withDatabaseSnapshot(dbPath, read);
}

function withDatabaseSnapshot<T>(
  dbPath: string,
  read: (snapshotPath: string, dbPath: string) => T,
): T {
  if (!existsSync(dbPath))
    throw new Error("The review thread database is unavailable.");
  const snapshot = stableThreadDatabaseSnapshot(dbPath);
  const snapshotDir = mkdtempSync(path.join(tmpdir(), "review-threads-read-"));

  try {
    const snapshotPath = path.join(snapshotDir, REVIEW_THREAD_DB_FILENAME);
    writeFileSync(snapshotPath, snapshot.database);

    if (snapshot.wal) writeFileSync(`${snapshotPath}-wal`, snapshot.wal);

    return read(snapshotPath, dbPath);
  } finally {
    rmSync(snapshotDir, { recursive: true, force: true });
  }
}

function threadDatabaseFingerprint(
  snapshot: ReturnType<typeof stableThreadDatabaseSnapshot>,
): string {
  return createHash("sha256")
    .update(createHash("sha256").update(snapshot.database).digest())
    .update(
      snapshot.wal === null
        ? "absent"
        : createHash("sha256").update(snapshot.wal).digest(),
    )
    .digest("hex");
}

export function readReviewThreadDatabaseFingerprint(
  reviewMdxPath: string,
): string {
  return threadDatabaseFingerprint(
    stableThreadDatabaseSnapshot(reviewThreadDbPath(reviewMdxPath)),
  );
}

/** Copy committed database state without opening the live database in SQLite. */
export function copyReviewThreadDatabaseSnapshot(
  reviewMdxPath: string,
  destinationReviewMdxPath: string,
): string {
  const snapshot = stableThreadDatabaseSnapshot(
    reviewThreadDbPath(reviewMdxPath),
  );

  const destination = legacyReviewThreadDbPath(destinationReviewMdxPath);

  if (
    reviewThreadDbPath(reviewMdxPath) !==
    legacyReviewThreadDbPath(reviewMdxPath)
  ) {
    const threads = readReviewThreadsReadOnly(reviewMdxPath);
    createLegacyReviewThreadDb(reviewStateDir(destinationReviewMdxPath));
    const db = new DatabaseSync(destination);

    try {
      for (const [table, records] of [
        ["comments", threads.comments],
        ["comment_drafts", threads.drafts],
      ] as const) {
        const insert = db.prepare(
          `INSERT INTO ${table} (thread_id, record_json) VALUES (?, ?)`,
        );

        for (const [id, record] of Object.entries(records))
          insert.run(id, JSON.stringify(record));
      }

      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } finally {
      db.close();
    }
  } else {
    writeFileSync(destination, snapshot.database);

    if (snapshot.wal) writeFileSync(`${destination}-wal`, snapshot.wal);
  }

  return threadDatabaseFingerprint(snapshot);
}

const PendingAgentThreadSchema = z.object({
  messages: z.array(
    z.object({
      role: z.enum(["reviewer", "agent"]).optional(),
      agentInput: z.boolean().default(false),
    }),
  ),
});

function isSharedThreadDatabase(db: DatabaseSync, dbPath: string): boolean {
  const version = readReviewStateDbSchemaVersion(db);

  if (version === null) return false;

  if (version !== String(REVIEW_STATE_DB_SCHEMA_VERSION))
    throw new ReviewStateDbVersionError(dbPath, version);

  return true;
}

/** Inspect only message ordering, so legacy targets and provider metadata do
 * not require a live database migration before artifacts can be repaired. */
export function hasPendingReviewAgentWrites(reviewMdxPath: string): boolean {
  return withThreadDatabaseSnapshot(reviewMdxPath, (snapshotPath, dbPath) => {
    const db = new DatabaseSync(snapshotPath, { readOnly: true });

    try {
      const version = readThreadDbSchemaVersion(db);
      const shared = isSharedThreadDatabase(db, dbPath);

      if (!shared && !isSupportedThreadDbVersion(version))
        throw new ReviewThreadDbVersionError(dbPath, version);

      const tables =
        version === "1"
          ? (["comments"] as const)
          : (["comments", "comment_drafts"] as const);

      for (const table of tables) {
        for (const raw of db
          .prepare(
            `SELECT thread_id, record_json FROM ${table}${shared ? " WHERE review_id = ? AND route_path = '/'" : ""}`,
          )
          .all(
            ...(shared ? [reviewIdForDir(reviewStateDir(reviewMdxPath))] : []),
          )) {
          const row = StoredThreadRowSchema.parse(raw);
          const value = parseJsonText(row.record_json);

          const thread = PendingAgentThreadSchema.parse(
            table === "comment_drafts" && isJsonObject(value)
              ? value.thread
              : value,
          );

          const lastInput = thread.messages.reduce(
            (last, message, index) =>
              message.agentInput && message.role !== "agent" ? index : last,
            -1,
          );

          if (
            lastInput >= 0 &&
            !thread.messages
              .slice(lastInput + 1)
              .some((message) => message.role === "agent")
          )
            return true;
        }
      }

      return false;
    } finally {
      db.close();
    }
  });
}

function stableThreadDatabaseSnapshot(dbPath: string) {
  const read = () => ({
    database: readFileSync(dbPath),
    wal: readThreadWal(`${dbPath}-wal`),
  });

  for (let attempt = 0; attempt < 3; attempt++) {
    const first = read();
    const second = read();

    if (
      first.database.equals(second.database) &&
      (first.wal === null
        ? second.wal === null
        : second.wal !== null && first.wal.equals(second.wal))
    )
      return second;
  }

  throw new Error(
    "The review thread database changed while taking a read-only snapshot; retry.",
  );
}

function readThreadWal(walPath: string): Buffer | null {
  try {
    return readFileSync(walPath);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return null;
    throw error;
  }
}

function readThreadDatabaseSnapshot(
  snapshotPath: string,
  dbPath: string,
  reviewId: string,
): ReviewThreadsReadOnlySnapshot {
  const db = new DatabaseSync(snapshotPath, { readOnly: true });

  try {
    const version = readThreadDbSchemaVersion(db);
    const shared = isSharedThreadDatabase(db, dbPath);

    if (!shared && version !== String(REVIEW_THREAD_DB_SCHEMA_VERSION))
      throw new ReviewThreadDbVersionError(dbPath, version);

    if (
      shared &&
      !db.prepare("SELECT 1 FROM reviews WHERE review_id = ?").get(reviewId)
    ) {
      throw new Error("The review thread database is unavailable.");
    }

    const read = (table: "comments" | "comment_drafts"): JsonObject => {
      const result: JsonObject = {};

      for (const raw of db
        .prepare(
          `SELECT thread_id, record_json FROM ${table}${shared ? " WHERE review_id = ? AND route_path = '/'" : ""}`,
        )
        .all(...(shared ? [reviewId] : []))) {
        const row = StoredThreadRowSchema.parse(raw);
        result[row.thread_id] = parseJsonText(row.record_json);
      }

      return result;
    };

    return {
      readOnly: true,
      revision: 0,
      comments: parseStoredReviewCommentThreadMap(read("comments")),
      drafts: ReviewCommentDraftThreadMapSchema.parse(read("comment_drafts")),
    };
  } finally {
    db.close();
  }
}

export type ReviewThreadDbMigrationResult = "missing" | "current" | "upgraded";

export interface ReviewThreadDbMigrationOptions {
  /** Artifact migration retains historical questions even though current UI no longer reads them. */
  preserveLegacyQuestions?: boolean;
  force?: boolean;
  migrateLegacyCodeRecord?: (
    record: JsonValue,
    kind: "comment" | "comment-draft",
  ) => Promise<JsonValue>;
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
  const dbPath = legacyReviewThreadDbPath(reviewMdxPath);

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

    if (!isSupportedThreadDbVersion(version)) {
      throw new ReviewThreadDbVersionError(dbPath, version);
    }

    if (version === "1") db.exec(REVIEW_THREAD_DB_V1_TO_V2_DDL);

    if (
      (version === "1" || version === "2") &&
      !options.preserveLegacyQuestions
    ) {
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

    migrateNativeAgentSessionRecords(db, version);

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
function migrateNativeAgentSessionRecords(
  db: DatabaseSync,
  version: string,
): void {
  for (const table of ["comments", "comment_drafts"] as const) {
    // SAFETY: both tables declare thread_id TEXT PRIMARY KEY and record_json
    // TEXT NOT NULL, and every insert binds strings for them.
    const rows = db
      .prepare(`SELECT thread_id, record_json FROM ${table}`)
      .all() as Array<{ thread_id: string; record_json: string }>;

    const update = db.prepare(
      `UPDATE ${table} SET record_json = ? WHERE thread_id = ?`,
    );

    for (const row of rows) {
      const value = parseJsonText(row.record_json);
      const migrated = migrateNativeAgentSessionRecord(value, table, version);

      // Validate before committing: invalid records block migration, never disappear.
      if (table === "comments") {
        parseStoredReviewCommentThreadMap({ [row.thread_id]: migrated });
      } else {
        ReviewCommentDraftThreadMapSchema.parse({ [row.thread_id]: migrated });
      }

      if (migrated !== value) {
        update.run(JSON.stringify(migrated), row.thread_id);
      }
    }
  }
}

function migrateNativeAgentSessionRecord(
  value: JsonValue,
  table: "comments" | "comment_drafts",
  version: string,
): JsonValue {
  if (!isJsonObject(value)) return value;

  if (table === "comment_drafts") {
    if (!isJsonObject(value.thread)) return value;
    const thread = migrateNativeAgentSessionThread(value.thread, version);

    return thread === value.thread ? value : { ...value, thread };
  }

  return migrateNativeAgentSessionThread(value, version);
}

/** Pre-v6 records may carry extra agent-session keys; keep only the current ones. */
const LegacyCommentAgentSessionSchema = z.object(
  ReviewCommentAgentSessionSchema.shape,
);

const V7CommentAgentSessionSchema = z.discriminatedUnion("state", [
  ReviewCommentAgentSessionSchema.extend({
    state: z.literal("ready"),
    firstMessageId: z.string().min(1),
  }),
  ReviewCommentAgentSessionSchema.extend({
    state: z.literal("pending"),
    firstMessageId: z.string().min(1).nullable(),
  }),
  ReviewCommentAgentSessionSchema.extend({
    state: z.literal("repair-required"),
  }),
]);

const V8CommentAgentSessionSchema = ReviewCommentAgentSessionSchema.extend({
  firstMessageId: z.string().min(1),
});

function migrateNativeAgentSessionThread(
  thread: JsonObject,
  version: string,
): JsonObject {
  const originalMessages = Array.isArray(thread.messages)
    ? thread.messages
    : undefined;

  const migratedMessages = originalMessages
    ? originalMessages.map((message) => {
        if (!isJsonObject(message)) return message;
        const agentInput = message.agentInput === true;

        if (
          !("native" in message) &&
          !("agentMessage" in message) &&
          message.agentInput === agentInput
        ) {
          return message;
        }

        const {
          native: _native,
          agentMessage: _agentMessage,
          ...preserved
        } = message;

        return { ...preserved, agentInput };
      })
    : undefined;

  const messagesChanged =
    originalMessages !== undefined &&
    migratedMessages !== undefined &&
    migratedMessages.some(
      (message, index) => message !== originalMessages[index],
    );

  const migratedThread = messagesChanged
    ? { ...thread, messages: migratedMessages }
    : thread;

  if (!("agentSession" in migratedThread)) return migratedThread;
  const { agentSession, ...preserved } = migratedThread;

  const sourceSchema =
    version === "8"
      ? V8CommentAgentSessionSchema
      : version === "7"
        ? V7CommentAgentSessionSchema
        : version === "6"
          ? ReviewCommentAgentSessionSchema
          : LegacyCommentAgentSessionSchema;

  const session = sourceSchema.parse(agentSession);

  return {
    ...preserved,
    agentSession: {
      harness: session.harness,
      sessionId: session.sessionId,
    },
  };
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
    // SAFETY: both tables declare thread_id TEXT PRIMARY KEY and record_json
    // TEXT NOT NULL, and every insert binds strings for them.
    const rows = db
      .prepare(`SELECT thread_id, record_json FROM ${table.name}`)
      .all() as Array<{ thread_id: string; record_json: string }>;

    for (const row of rows) {
      const current = parseJsonText(row.record_json);
      let migrated: JsonValue;

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

function readThreadTable(
  reviewDir: string,
  table: "comments" | "comment_drafts",
  keyColumn: "thread_id",
): JsonObject {
  const dbPath = reviewStateDbPath(reviewHomeForDir(reviewDir));
  const legacyDbPath = path.join(reviewDir, REVIEW_THREAD_DB_FILENAME);

  if (!existsSync(dbPath) && !existsSync(legacyDbPath)) return {};
  checkReviewThreadDbVersion(path.join(reviewDir, "review.mdx"));
  importLegacyReview(reviewDir);
  const db = openReviewStateDb(reviewHomeForDir(reviewDir));
  const reviewId = reviewIdForDir(reviewDir);

  // SAFETY: the key column is the TEXT PRIMARY KEY and record_json is TEXT NOT
  // NULL in both tables, and every insert binds strings for them.
  const rows = db
    .prepare(
      `SELECT ${keyColumn} AS key, record_json FROM ${table}
       WHERE review_id = ? AND route_path = '/'`,
    )
    .all(reviewId) as Array<{ key: string; record_json: string }>;

  const result: JsonObject = {};

  for (const row of rows) {
    result[row.key] = parseJsonText(row.record_json);
  }

  return result;
}

function writeThreadTable(
  reviewDir: string,
  table: "comments" | "comment_drafts",
  keyColumn: "thread_id",
  value: ReviewCommentThreadMap | ReviewCommentDraftThreadMap,
): void {
  checkReviewThreadDbVersion(path.join(reviewDir, "review.mdx"));
  importLegacyReview(reviewDir);
  ensureReviewRegistration(reviewDir);
  const db = openReviewStateDb(reviewHomeForDir(reviewDir));
  const reviewId = reviewIdForDir(reviewDir);

  const insert = db.prepare(
    `INSERT INTO ${table}
     (review_id, route_path, ${keyColumn}, record_json) VALUES (?, '/', ?, ?)`,
  );

  db.exec("BEGIN IMMEDIATE");

  try {
    db.prepare(
      `DELETE FROM ${table} WHERE review_id = ? AND route_path = '/'`,
    ).run(reviewId);

    for (const [key, record] of Object.entries(value)) {
      insert.run(reviewId, key, JSON.stringify(record));
    }

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function writeCommentState(
  reviewDir: string,
  comments: ReviewCommentThreadMap,
  drafts: ReviewCommentDraftThreadMap,
): void {
  checkReviewThreadDbVersion(path.join(reviewDir, "review.mdx"));
  importLegacyReview(reviewDir);
  ensureReviewRegistration(reviewDir);
  const db = openReviewStateDb(reviewHomeForDir(reviewDir));
  const reviewId = reviewIdForDir(reviewDir);

  const insertComment = db.prepare(
    "INSERT INTO comments (review_id, route_path, thread_id, record_json) VALUES (?, '/', ?, ?)",
  );

  const insertDraft = db.prepare(
    "INSERT INTO comment_drafts (review_id, route_path, thread_id, record_json) VALUES (?, '/', ?, ?)",
  );

  db.exec("BEGIN IMMEDIATE");

  try {
    db.prepare(
      "DELETE FROM comments WHERE review_id = ? AND route_path = '/'",
    ).run(reviewId);
    db.prepare(
      "DELETE FROM comment_drafts WHERE review_id = ? AND route_path = '/'",
    ).run(reviewId);

    for (const [threadId, record] of Object.entries(
      parseStoredReviewCommentThreadMap(comments),
    )) {
      insertComment.run(reviewId, threadId, JSON.stringify(record));
    }

    for (const [threadId, record] of Object.entries(
      ReviewCommentDraftThreadMapSchema.parse(drafts),
    )) {
      insertDraft.run(reviewId, threadId, JSON.stringify(record));
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
  const reviewDir = reviewStateDir(reviewMdxPath);

  return {
    readComments: () => readValidComments(reviewDir),
    writeComments: (comments) =>
      writeThreadTable(
        reviewDir,
        "comments",
        "thread_id",
        parseStoredReviewCommentThreadMap(comments),
      ),
    readCommentDrafts: () =>
      ReviewCommentDraftThreadMapSchema.parse(
        readThreadTable(reviewDir, "comment_drafts", "thread_id"),
      ),
    writeCommentDrafts: (drafts) =>
      writeThreadTable(
        reviewDir,
        "comment_drafts",
        "thread_id",
        ReviewCommentDraftThreadMapSchema.parse(drafts),
      ),
    writeCommentState: (comments, drafts) =>
      writeCommentState(reviewDir, comments, drafts),
  };
}

function readValidComments(reviewDir: string): ReviewCommentThreadMap {
  const stored = readThreadTable(reviewDir, "comments", "thread_id");
  const comments = parseReviewCommentThreadMap(stored);
  const dropped = Object.keys(stored).filter((key) => !(key in comments));

  if (dropped.length === 0) return comments;
  console.error(
    `[Review] Dropped ${dropped.length} malformed comment record${dropped.length === 1 ? "" : "s"} from ${reviewStateDbPath()}: ${dropped.join(", ")}`,
  );
  writeThreadTable(reviewDir, "comments", "thread_id", comments);

  return comments;
}

/** Register a new Review in the shared database without a per-Review file. */
export function createReviewThreadDb(
  reviewDir: string,
  reviewHome?: string,
): void {
  ensureReviewRegistration(reviewDir, reviewHome);
}

/** Create the old per-review database shape for migration tests and tools. */
export function createLegacyReviewThreadDb(reviewDir: string): void {
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
  closeAllReviewStateDatabases();
}
