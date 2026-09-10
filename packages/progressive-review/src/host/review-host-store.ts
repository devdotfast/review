import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";

import {
  type HostAsset,
  HostAssetSchema,
  type HostAttention,
  HostAttentionSchema,
  type HostBinding,
  HostBindingSchema,
  type HostCanvasReport,
  HostCanvasReportSchema,
  type HostCheckpoint,
  HostCheckpointSchema,
  HostDefinitionSchema,
  type HostDocument,
  type HostDocumentManifest,
  HostDocumentManifestSchema,
  type HostDocumentState,
  HostDocumentStateSchema,
  type HostDraft,
  HostDraftSchema,
  type HostFeedbackSubmission,
  HostFeedbackSubmissionSchema,
  HostHashSchema,
  type HostMap,
  HostMapSummarySchema,
  type HostMapVersion,
  HostMapVersionSchema,
  type HostMessage,
  HostMessageSchema,
  HostNodeSchema,
  type HostPrincipal,
  HostPrincipalSchema,
  type HostQuestionContext,
  HostQuestionContextSchema,
  type HostQuestionRun,
  HostQuestionRunSchema,
  type HostRepinPlan,
  HostRepinPlanSchema,
  type HostRetainedTrace,
  HostRetainedTraceSchema,
  type HostReview,
  HostReviewSchema,
  type HostSourceQuote,
  HostSourceQuoteSchema,
  type HostThread,
  HostThreadSchema,
  type JsonValue,
  canonicalHostJson,
  parseJsonText,
} from "@dev.fast/review-protocol";
import { z } from "zod";

// This store is internal to the authoritative host. Transports receive no SQL
// connection or filesystem paths, and every mutation requires a command txn.
export type HostStoredReview = HostReview;

export class HostStoreError extends Error {
  constructor(
    readonly code:
      | "NOT_FOUND"
      | "VERSION_CONFLICT"
      | "IDEMPOTENCY_CONFLICT"
      | "INVALID_STATE"
      | "CURSOR_EXPIRED"
      | "INTEGRITY_ERROR",
    message: string,
  ) {
    super(message);
    this.name = "HostStoreError";
  }
}

export interface HostStoredResponse {
  result: JsonValue;
  eventCursor: string;
}
export interface HostCommandIdentity {
  clientId: string;
  commandId: string;
  request: JsonValue;
}
export interface HostPreparedDocument {
  document: HostDocument;
  binding: HostBinding;
  evidence: Record<string, HostSourceQuote>;
}
export interface HostPreparedMap {
  repositoryId: string;
  commit: string;
  map: HostMap;
  evidence: Record<string, HostSourceQuote>;
}
export interface HostStoredEvent {
  cursor: string;
  reviewId: string | null;
  type: string;
  payload: JsonValue;
}

export interface HostRetiredIds {
  nodeIds: Set<string>;
  definitionIds: Set<string>;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS host_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS host_principals (
  id TEXT PRIMARY KEY, identity_key TEXT NOT NULL UNIQUE,
  record_json TEXT NOT NULL CHECK(json_valid(record_json))
) STRICT;
CREATE TABLE IF NOT EXISTS host_repositories (
  id TEXT PRIMARY KEY, display_name TEXT NOT NULL, vcs TEXT NOT NULL CHECK (vcs IN ('git','jj')),
  local_path TEXT NOT NULL UNIQUE
) STRICT;
CREATE TABLE IF NOT EXISTS host_reviews (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL REFERENCES host_repositories(id),
  document_version INTEGER NOT NULL CHECK(document_version >= 0),
  record_json TEXT NOT NULL CHECK(json_valid(record_json)),
  FOREIGN KEY(id, document_version) REFERENCES host_document_versions(review_id,version) DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE TABLE IF NOT EXISTS host_content_objects (
  hash TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('node','definition','evidence')),
  value_json TEXT NOT NULL CHECK(json_valid(value_json))
) STRICT;
CREATE TABLE IF NOT EXISTS host_document_versions (
  review_id TEXT NOT NULL REFERENCES host_reviews(id), version INTEGER NOT NULL CHECK(version >= 0),
  binding_json TEXT NOT NULL CHECK(json_valid(binding_json)),
  manifest_json TEXT NOT NULL CHECK(json_valid(manifest_json)), content_hash TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY(review_id,version)
) STRICT;
CREATE TABLE IF NOT EXISTS host_document_object_refs (
  review_id TEXT NOT NULL, version INTEGER NOT NULL, hash TEXT NOT NULL REFERENCES host_content_objects(hash),
  PRIMARY KEY(review_id,version,hash),
  FOREIGN KEY(review_id,version) REFERENCES host_document_versions(review_id,version)
) STRICT;
CREATE TABLE IF NOT EXISTS host_document_ids (
  review_id TEXT NOT NULL REFERENCES host_reviews(id), namespace TEXT NOT NULL CHECK(namespace IN ('node','definition')),
  local_id TEXT NOT NULL, PRIMARY KEY(review_id,namespace,local_id)
) STRICT;
CREATE TABLE IF NOT EXISTS host_checkpoints (
  id TEXT PRIMARY KEY, review_id TEXT NOT NULL REFERENCES host_reviews(id),
  ordinal INTEGER NOT NULL CHECK(ordinal > 0), document_version INTEGER NOT NULL,
  record_json TEXT NOT NULL CHECK(json_valid(record_json)), UNIQUE(review_id,ordinal),
  FOREIGN KEY(review_id,document_version) REFERENCES host_document_versions(review_id,version)
) STRICT;
CREATE TABLE IF NOT EXISTS host_repin_plans (
  id TEXT PRIMARY KEY, review_id TEXT NOT NULL REFERENCES host_reviews(id),
  document_version INTEGER NOT NULL, record_json TEXT NOT NULL CHECK(json_valid(record_json)),
  FOREIGN KEY(review_id,document_version) REFERENCES host_document_versions(review_id,version)
) STRICT;
CREATE TABLE IF NOT EXISTS host_maps (
  id TEXT PRIMARY KEY, review_id TEXT NOT NULL REFERENCES host_reviews(id),
  repository_id TEXT NOT NULL REFERENCES host_repositories(id), commit_oid TEXT NOT NULL,
  current_revision INTEGER NOT NULL CHECK(current_revision >= 0),
  FOREIGN KEY(id,current_revision) REFERENCES host_map_versions(map_id,revision) DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE TABLE IF NOT EXISTS host_map_versions (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
  map_id TEXT NOT NULL REFERENCES host_maps(id), revision INTEGER NOT NULL CHECK(revision >= 0),
  content_hash TEXT NOT NULL, created_at TEXT NOT NULL,
  record_json TEXT NOT NULL CHECK(json_valid(record_json)),
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)), UNIQUE(map_id,revision)
) STRICT;
CREATE TABLE IF NOT EXISTS host_traces (
  id TEXT PRIMARY KEY, review_id TEXT NOT NULL REFERENCES host_reviews(id),
  content_hash TEXT NOT NULL, record_json TEXT NOT NULL CHECK(json_valid(record_json))
) STRICT;
CREATE TABLE IF NOT EXISTS host_asset_blobs (
  hash TEXT PRIMARY KEY, bytes BLOB NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS host_assets (
  id TEXT PRIMARY KEY, review_id TEXT NOT NULL REFERENCES host_reviews(id),
  blob_hash TEXT NOT NULL REFERENCES host_asset_blobs(hash),
  content_hash TEXT NOT NULL, record_json TEXT NOT NULL CHECK(json_valid(record_json))
) STRICT;
CREATE TABLE IF NOT EXISTS host_drafts (
  id TEXT PRIMARY KEY, review_id TEXT NOT NULL REFERENCES host_reviews(id), principal_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version>=0), document_version INTEGER NOT NULL,
  record_json TEXT NOT NULL CHECK(json_valid(record_json)),
  FOREIGN KEY(review_id,document_version) REFERENCES host_document_versions(review_id,version)
) STRICT;
CREATE TABLE IF NOT EXISTS host_threads (
  id TEXT PRIMARY KEY, review_id TEXT NOT NULL REFERENCES host_reviews(id),
  document_version INTEGER NOT NULL, record_json TEXT NOT NULL CHECK(json_valid(record_json)),
  FOREIGN KEY(review_id,document_version) REFERENCES host_document_versions(review_id,version)
) STRICT;
CREATE TABLE IF NOT EXISTS host_messages (
  id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES host_threads(id),
  ordinal INTEGER NOT NULL CHECK(ordinal>0), reply_to_message_id TEXT REFERENCES host_messages(id),
  question_run_id TEXT REFERENCES host_question_runs(id), record_json TEXT NOT NULL CHECK(json_valid(record_json)),
  UNIQUE(thread_id,ordinal)
) STRICT;
CREATE TABLE IF NOT EXISTS host_feedback_submissions (
  id TEXT PRIMARY KEY, review_id TEXT NOT NULL REFERENCES host_reviews(id),
  checkpoint_id TEXT NOT NULL REFERENCES host_checkpoints(id), record_json TEXT NOT NULL CHECK(json_valid(record_json))
) STRICT;
CREATE TABLE IF NOT EXISTS host_question_contexts (
  id TEXT PRIMARY KEY, review_id TEXT NOT NULL REFERENCES host_reviews(id), document_version INTEGER NOT NULL,
  record_json TEXT NOT NULL CHECK(json_valid(record_json)),
  FOREIGN KEY(review_id,document_version) REFERENCES host_document_versions(review_id,version)
) STRICT;
CREATE TABLE IF NOT EXISTS host_question_runs (
  id TEXT PRIMARY KEY, review_id TEXT NOT NULL REFERENCES host_reviews(id), thread_id TEXT NOT NULL REFERENCES host_threads(id),
  question_id TEXT NOT NULL REFERENCES host_messages(id), context_id TEXT NOT NULL REFERENCES host_question_contexts(id),
  state TEXT NOT NULL CHECK(state IN ('pending','running','completed','failed','interrupted')),
  answer_message_id TEXT REFERENCES host_messages(id), record_json TEXT NOT NULL CHECK(json_valid(record_json))
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS host_question_active_attempt ON host_question_runs(question_id) WHERE state IN ('pending','running');
CREATE TABLE IF NOT EXISTS host_attention (
  review_id TEXT NOT NULL REFERENCES host_reviews(id), principal_id TEXT NOT NULL,
  record_json TEXT NOT NULL CHECK(json_valid(record_json)), PRIMARY KEY(review_id,principal_id)
) STRICT;
CREATE TABLE IF NOT EXISTS host_canvas_reports (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  review_id TEXT NOT NULL REFERENCES host_reviews(id), canvas_session_id TEXT NOT NULL,
  principal_id TEXT NOT NULL, received_at TEXT NOT NULL,
  report_json TEXT NOT NULL CHECK(json_valid(report_json)), UNIQUE(review_id,canvas_session_id)
) STRICT;
CREATE TABLE IF NOT EXISTS host_command_receipts (
  client_id TEXT NOT NULL, command_id TEXT NOT NULL, request_hash TEXT NOT NULL,
  response_json TEXT NOT NULL CHECK(json_valid(response_json)), created_at TEXT NOT NULL,
  PRIMARY KEY(client_id,command_id)
) STRICT;
CREATE TABLE IF NOT EXISTS host_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  review_id TEXT REFERENCES host_reviews(id), private_principal_id TEXT,
  type TEXT NOT NULL, payload_json TEXT NOT NULL CHECK(json_valid(payload_json)), created_at TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS host_events_by_review ON host_events(review_id,sequence);
`;

function contentHash(value: JsonValue): string {
  return createHash("sha256").update(canonicalHostJson(value)).digest("hex");
}

function messageIdentity(message: Omit<HostMessage, "ordinal">) {
  return {
    id: message.id,
    threadId: message.threadId,
    author: message.author,
    body: message.body,
    replyToMessageId: message.replyToMessageId,
    questionRunId: message.questionRunId,
  };
}

const rowText = (
  row: Record<string, SQLOutputValue>,
  column: string,
): string => {
  const value = z.string().safeParse(row[column]);
  if (!value.success)
    throw new HostStoreError(
      "INTEGRITY_ERROR",
      "Stored review data is invalid.",
    );
  return value.data;
};

function preflightDatabase(databasePath: string): void {
  if (!existsSync(databasePath)) return;
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const metadata = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='host_meta'",
      )
      .get();
    if (!metadata) {
      const foreignTable = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' LIMIT 1",
        )
        .get();
      if (foreignTable)
        throw new HostStoreError(
          "INVALID_STATE",
          "This file is not a JSON Review host database. Choose a separate review home; the existing data has not been changed.",
        );
      return;
    }
    const version = db
      .prepare("SELECT value FROM host_meta WHERE key='schema_version'")
      .get();
    if (version?.value !== "1")
      throw new HostStoreError(
        "INVALID_STATE",
        "This review database requires a different application version.",
      );
  } finally {
    db.close();
  }
}

/** One shared DB, immutable content objects, short synchronous transactions. */
export class ReviewHostStore {
  private readonly db: DatabaseSync;
  private writing = false;
  readonly hostId: string;
  readonly workspaceId: string;

  constructor(databasePath: string) {
    // Unknown future data must remain untouched, including its journal mode and
    // permissions. Preflight read-only before opening a writable connection.
    preflightDatabase(databasePath);
    mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(databasePath);
    chmodSync(databasePath, 0o600);
    try {
      this.db.exec(
        "PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;",
      );
      this.db.exec("BEGIN IMMEDIATE");
      this.db.exec(SCHEMA);
      const version = this.db
        .prepare("SELECT value FROM host_meta WHERE key='schema_version'")
        .get();
      if (version && version.value !== "1")
        throw new HostStoreError(
          "INVALID_STATE",
          "This review database requires a different application version.",
        );
      const put = this.db.prepare(
        "INSERT OR IGNORE INTO host_meta(key,value) VALUES (?,?)",
      );
      put.run("schema_version", "1");
      put.run("host_id", randomUUID());
      put.run("workspace_id", randomUUID());
      this.hostId = rowText(
        this.db
          .prepare("SELECT value FROM host_meta WHERE key='host_id'")
          .get()!,
        "value",
      );
      this.workspaceId = rowText(
        this.db
          .prepare("SELECT value FROM host_meta WHERE key='workspace_id'")
          .get()!,
        "value",
      );
      this.db.exec("COMMIT");
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* transaction may not have started */
      }
      this.db.close();
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  /** Receipt lookup is deliberately available before any version/evidence work. */
  receipt(identity: HostCommandIdentity): HostStoredResponse | null {
    const row = this.db
      .prepare(
        "SELECT request_hash,response_json FROM host_command_receipts WHERE client_id=? AND command_id=?",
      )
      .get(identity.clientId, identity.commandId);
    if (!row) return null;
    if (row.request_hash !== contentHash(identity.request))
      throw new HostStoreError(
        "IDEMPOTENCY_CONFLICT",
        "Command ID was already used with different arguments.",
      );
    return this.parseResponse(rowText(row, "response_json"));
  }

  command(
    identity: HostCommandIdentity,
    mutate: () => JsonValue,
  ): HostStoredResponse {
    if (this.writing)
      throw new Error("Nested host transactions are not supported.");
    this.db.exec("BEGIN IMMEDIATE");
    this.writing = true;
    try {
      // Recheck after acquiring the write lock: another host connection could
      // have committed this command while source validation was running.
      const replay = this.receipt(identity);
      if (replay) {
        this.db.exec("COMMIT");
        return replay;
      }
      const result = mutate();
      const response = { result, eventCursor: this.cursor() };
      this.db
        .prepare(
          "INSERT INTO host_command_receipts(client_id,command_id,request_hash,response_json,created_at) VALUES (?,?,?,?,?)",
        )
        .run(
          identity.clientId,
          identity.commandId,
          contentHash(identity.request),
          canonicalHostJson(response),
          new Date().toISOString(),
        );
      this.db.exec("COMMIT");
      return response;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    } finally {
      this.writing = false;
    }
  }

  snapshot(read: () => JsonValue): HostStoredResponse {
    if (this.writing)
      throw new Error("Snapshot cannot run inside a write transaction.");
    this.db.exec("BEGIN");
    try {
      const result = read();
      const response = { result, eventCursor: this.cursor() };
      this.db.exec("COMMIT");
      return response;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  registerRepository(input: {
    id: string;
    displayName: string;
    vcs: "git" | "jj";
    localPath: string;
  }): void {
    this.requireWrite();
    this.db
      .prepare(
        "INSERT INTO host_repositories(id,display_name,vcs,local_path) VALUES (?,?,?,?)",
      )
      .run(input.id, input.displayName, input.vcs, input.localPath);
  }

  /** Identity keys are host-private, never supplied in portable review data. */
  principal(identityKey: string): HostPrincipal | null {
    const row = this.db
      .prepare("SELECT record_json FROM host_principals WHERE identity_key=?")
      .get(identityKey);
    return row
      ? HostPrincipalSchema.parse(parseJsonText(rowText(row, "record_json")))
      : null;
  }

  putPrincipal(identityKey: string, principal: HostPrincipal): void {
    this.requireWrite();
    this.db
      .prepare(
        "INSERT INTO host_principals(id,identity_key,record_json) VALUES (?,?,?)",
      )
      .run(
        principal.id,
        identityKey,
        canonicalHostJson(HostPrincipalSchema.parse(principal)),
      );
  }

  repositoryForPath(localPath: string): string | null {
    const row = this.db
      .prepare("SELECT id FROM host_repositories WHERE local_path=?")
      .get(localPath);
    return row ? rowText(row, "id") : null;
  }

  repositories(): { id: string; displayName: string; vcs: "git" | "jj" }[] {
    return this.db
      .prepare("SELECT id,display_name,vcs FROM host_repositories ORDER BY id")
      .all()
      .map((row) => ({
        id: rowText(row, "id"),
        displayName: rowText(row, "display_name"),
        vcs: z.enum(["git", "jj"]).parse(row.vcs),
      }));
  }

  repositoryPath(repositoryId: string): string {
    const row = this.db
      .prepare("SELECT local_path FROM host_repositories WHERE id=?")
      .get(repositoryId);
    if (!row) throw new HostStoreError("NOT_FOUND", "Repository not found.");
    return rowText(row, "local_path");
  }

  createReview(
    review: HostStoredReview,
    prepared: HostPreparedDocument,
  ): HostDocumentState {
    this.requireWrite();
    if (
      review.documentVersion !== 0 ||
      review.version !== 0 ||
      review.repositoryId !== prepared.binding.repositoryId
    )
      throw new HostStoreError(
        "INVALID_STATE",
        "New reviews require version zero and their registered repository.",
      );
    this.db
      .prepare(
        "INSERT INTO host_reviews(id,repository_id,document_version,record_json) VALUES (?,?,0,?)",
      )
      .run(
        review.id,
        review.repositoryId,
        canonicalHostJson(HostReviewSchema.parse(review)),
      );
    return this.writeDocumentVersion(review, prepared, 0, review.createdAt);
  }

  review(reviewId: string): HostStoredReview {
    const row = this.db
      .prepare("SELECT record_json FROM host_reviews WHERE id=?")
      .get(reviewId);
    if (!row) throw new HostStoreError("NOT_FOUND", "Review not found.");
    return HostReviewSchema.parse(parseJsonText(rowText(row, "record_json")));
  }

  reviews(includeTrashed = false): HostStoredReview[] {
    return this.db
      .prepare("SELECT record_json FROM host_reviews ORDER BY id")
      .all()
      .map((row) =>
        HostReviewSchema.parse(parseJsonText(rowText(row, "record_json"))),
      )
      .filter((review) => includeTrashed || review.deletedAt === null);
  }

  updateReview(
    reviewId: string,
    expectedVersion: number,
    update: (review: HostStoredReview) => HostStoredReview,
  ): HostStoredReview {
    this.requireWrite();
    const before = this.review(reviewId);
    if (before.version !== expectedVersion)
      throw new HostStoreError(
        "VERSION_CONFLICT",
        "Review metadata changed. Read the current version and retry.",
      );
    const after = HostReviewSchema.parse(update(before));
    if (
      after.id !== before.id ||
      after.repositoryId !== before.repositoryId ||
      after.documentId !== before.documentId ||
      after.documentVersion !== before.documentVersion ||
      after.createdAt !== before.createdAt ||
      after.createdBy !== before.createdBy ||
      after.version !== before.version + 1
    )
      throw new HostStoreError(
        "INVALID_STATE",
        "Metadata changes cannot alter review identity or document state.",
      );
    this.db
      .prepare("UPDATE host_reviews SET record_json=? WHERE id=?")
      .run(canonicalHostJson(after), reviewId);
    return after;
  }

  document(reviewId: string, version?: number): HostDocumentState {
    const review = this.review(reviewId);
    const row = this.db
      .prepare(
        "SELECT * FROM host_document_versions WHERE review_id=? AND version=?",
      )
      .get(reviewId, version ?? review.documentVersion);
    if (!row)
      throw new HostStoreError("NOT_FOUND", "Document version not found.");
    const manifest = HostDocumentManifestSchema.parse(
      parseJsonText(rowText(row, "manifest_json")),
    );
    const binding = HostBindingSchema.parse(
      parseJsonText(rowText(row, "binding_json")),
    );
    const hashes = new Map(
      this.db
        .prepare(
          "SELECT object.hash,object.kind,object.value_json FROM host_document_object_refs ref JOIN host_content_objects object ON object.hash=ref.hash WHERE ref.review_id=? AND ref.version=?",
        )
        .all(reviewId, version ?? review.documentVersion)
        .map((item) => [rowText(item, "hash"), item]),
    );
    const readObject = (hash: string, kind: string): JsonValue => {
      const object = hashes.get(hash);
      if (!object || object.kind !== kind)
        throw new HostStoreError(
          "INTEGRITY_ERROR",
          "Document content is missing or has the wrong kind.",
        );
      const value = parseJsonText(rowText(object, "value_json"));
      if (contentHash({ kind, schemaVersion: 1, value }) !== hash)
        throw new HostStoreError(
          "INTEGRITY_ERROR",
          "Document content failed its integrity check.",
        );
      return value;
    };
    const state = HostDocumentStateSchema.parse({
      schemaVersion: 1,
      documentId: review.documentId,
      reviewId,
      version: row.version,
      binding,
      roots: manifest.roots,
      nodes: Object.fromEntries(
        Object.entries(manifest.nodes).map(([id, hash]) => [
          id,
          HostNodeSchema.parse(readObject(hash, "node")),
        ]),
      ),
      definitions: Object.fromEntries(
        Object.entries(manifest.definitions).map(([id, hash]) => [
          id,
          HostDefinitionSchema.parse(readObject(hash, "definition")),
        ]),
      ),
      evidence: Object.fromEntries(
        Object.entries(manifest.evidence).map(([id, hash]) => [
          id,
          HostSourceQuoteSchema.parse(readObject(hash, "evidence")),
        ]),
      ),
      contentHash: row.content_hash,
      createdAt: row.created_at,
    });
    if (
      state.contentHash !== contentHash({ schemaVersion: 1, binding, manifest })
    )
      throw new HostStoreError(
        "INTEGRITY_ERROR",
        "Document manifest failed its integrity check.",
      );
    return state;
  }

  commitDocument(
    reviewId: string,
    expectedVersion: number,
    prepared: HostPreparedDocument,
  ): HostDocumentState {
    this.requireWrite();
    const review = this.review(reviewId);
    if (review.documentVersion !== expectedVersion)
      throw new HostStoreError(
        "VERSION_CONFLICT",
        "Document changed. Read the current version and retry.",
      );
    if (review.deletedAt !== null || review.workflow === "closed")
      throw new HostStoreError(
        "INVALID_STATE",
        "Closed or trashed reviews cannot be authored.",
      );
    if (review.repositoryId !== prepared.binding.repositoryId)
      throw new HostStoreError(
        "INVALID_STATE",
        "A document cannot change repositories.",
      );
    const previous = this.document(reviewId);
    const sameDocument =
      canonicalHostJson({
        schemaVersion: previous.schemaVersion,
        roots: previous.roots,
        nodes: previous.nodes,
        definitions: previous.definitions,
      }) === canonicalHostJson(prepared.document);
    if (
      sameDocument &&
      canonicalHostJson(previous.binding) ===
        canonicalHostJson(prepared.binding) &&
      canonicalHostJson(previous.evidence) ===
        canonicalHostJson(prepared.evidence)
    )
      return previous;
    const now = new Date().toISOString();
    const result = this.writeDocumentVersion(
      review,
      prepared,
      expectedVersion + 1,
      now,
    );
    this.db
      .prepare(
        "UPDATE host_reviews SET document_version=?,record_json=? WHERE id=?",
      )
      .run(
        result.version,
        canonicalHostJson({ ...review, documentVersion: result.version }),
        reviewId,
      );
    return result;
  }

  documentHistory(
    reviewId: string,
  ): { version: number; contentHash: string; createdAt: string }[] {
    this.review(reviewId);
    return this.db
      .prepare(
        "SELECT version,content_hash,created_at FROM host_document_versions WHERE review_id=? ORDER BY version DESC",
      )
      .all(reviewId)
      .map((row) => ({
        version: z.number().int().parse(row.version),
        contentHash: rowText(row, "content_hash"),
        createdAt: rowText(row, "created_at"),
      }));
  }

  publish(input: {
    reviewId: string;
    expectedDocumentVersion: number;
    expectedReviewVersion: number;
    mapVersions: HostCheckpoint["mapVersions"];
    principalId: string;
  }): HostCheckpoint {
    this.requireWrite();
    const review = this.review(input.reviewId);
    if (
      review.documentVersion !== input.expectedDocumentVersion ||
      review.version !== input.expectedReviewVersion
    )
      throw new HostStoreError(
        "VERSION_CONFLICT",
        "Review or document changed. Read the current versions and retry.",
      );
    if (review.deletedAt !== null || review.workflow === "closed")
      throw new HostStoreError(
        "INVALID_STATE",
        "Closed or trashed reviews cannot be published.",
      );
    const document = this.document(review.id);
    const latest = this.db
      .prepare(
        "SELECT COALESCE(MAX(ordinal),0) AS ordinal FROM host_checkpoints WHERE review_id=?",
      )
      .get(review.id)!;
    const checkpoint = HostCheckpointSchema.parse({
      id: randomUUID(),
      reviewId: review.id,
      ordinal: z.number().int().parse(latest.ordinal) + 1,
      documentVersion: document.version,
      bindingId: document.binding.id,
      title: review.title,
      description: review.description,
      mapVersions: input.mapVersions,
      authorSessionId: review.authorSessionId,
      createdBy: input.principalId,
      createdAt: new Date().toISOString(),
    });
    this.db
      .prepare(
        "INSERT INTO host_checkpoints(id,review_id,ordinal,document_version,record_json) VALUES (?,?,?,?,?)",
      )
      .run(
        checkpoint.id,
        review.id,
        checkpoint.ordinal,
        checkpoint.documentVersion,
        canonicalHostJson(checkpoint),
      );
    this.updateReview(review.id, review.version, (before) => ({
      ...before,
      version: before.version + 1,
      workflow: "in_review",
      publishedCheckpointId: checkpoint.id,
      updatedAt: checkpoint.createdAt,
    }));
    return checkpoint;
  }

  checkpoints(reviewId: string): HostCheckpoint[] {
    this.review(reviewId);
    return this.db
      .prepare(
        "SELECT record_json FROM host_checkpoints WHERE review_id=? ORDER BY ordinal DESC",
      )
      .all(reviewId)
      .map((row) =>
        HostCheckpointSchema.parse(parseJsonText(rowText(row, "record_json"))),
      );
  }

  saveRepinPlan(plan: HostRepinPlan): void {
    this.requireWrite();
    const review = this.review(plan.reviewId);
    if (review.documentVersion !== plan.basedOnDocumentVersion)
      throw new HostStoreError(
        "VERSION_CONFLICT",
        "Document changed while planning the repin. Make a new plan.",
      );
    if (review.deletedAt !== null || review.workflow === "closed")
      throw new HostStoreError(
        "INVALID_STATE",
        "Closed or trashed reviews cannot be repinned.",
      );
    this.db
      .prepare(
        "INSERT INTO host_repin_plans(id,review_id,document_version,record_json) VALUES (?,?,?,?)",
      )
      .run(
        plan.id,
        plan.reviewId,
        plan.basedOnDocumentVersion,
        canonicalHostJson(HostRepinPlanSchema.parse(plan)),
      );
  }

  repinPlan(reviewId: string, planId: string): HostRepinPlan {
    const row = this.db
      .prepare(
        "SELECT record_json FROM host_repin_plans WHERE id=? AND review_id=?",
      )
      .get(planId, reviewId);
    if (!row) throw new HostStoreError("NOT_FOUND", "Repin plan not found.");
    return HostRepinPlanSchema.parse(
      parseJsonText(rowText(row, "record_json")),
    );
  }

  checkpoint(reviewId: string, checkpointId: string): HostCheckpoint {
    const row = this.db
      .prepare(
        "SELECT record_json FROM host_checkpoints WHERE review_id=? AND id=?",
      )
      .get(reviewId, checkpointId);
    if (!row) throw new HostStoreError("NOT_FOUND", "Checkpoint not found.");
    return HostCheckpointSchema.parse(
      parseJsonText(rowText(row, "record_json")),
    );
  }

  createMap(reviewId: string, prepared: HostPreparedMap): HostMapVersion {
    this.requireWrite();
    const review = this.mutableResourceReview(reviewId);
    if (review.repositoryId !== prepared.repositoryId)
      throw new HostStoreError(
        "INVALID_STATE",
        "Map repository does not belong to this review.",
      );
    const mapId = randomUUID();
    this.db
      .prepare(
        "INSERT INTO host_maps(id,review_id,repository_id,commit_oid,current_revision) VALUES (?,?,?,?,0)",
      )
      .run(mapId, reviewId, prepared.repositoryId, prepared.commit);
    return this.writeMapVersion(mapId, 0, prepared);
  }

  commitMap(
    reviewId: string,
    mapId: string,
    expectedVersion: number,
    prepared: HostPreparedMap,
  ): HostMapVersion {
    this.requireWrite();
    this.mutableResourceReview(reviewId);
    const before = this.currentMap(reviewId, mapId);
    if (before.revision !== expectedVersion)
      throw new HostStoreError(
        "VERSION_CONFLICT",
        "Map changed. Read its current revision and retry.",
      );
    if (
      before.repositoryId !== prepared.repositoryId ||
      before.commit !== prepared.commit
    )
      throw new HostStoreError(
        "INVALID_STATE",
        "A map's pinned repository and commit cannot change.",
      );
    if (before.contentHash === contentHash({ ...prepared })) return before;
    const after = this.writeMapVersion(mapId, expectedVersion + 1, prepared);
    this.db
      .prepare("UPDATE host_maps SET current_revision=? WHERE id=?")
      .run(after.revision, mapId);
    return after;
  }

  currentMap(reviewId: string, mapId: string): HostMapVersion {
    const row = this.db
      .prepare(
        "SELECT v.id FROM host_maps m JOIN host_map_versions v ON v.map_id=m.id AND v.revision=m.current_revision WHERE m.review_id=? AND m.id=?",
      )
      .get(reviewId, mapId);
    if (!row) throw new HostStoreError("NOT_FOUND", "Map not found.");
    return this.mapVersion(reviewId, rowText(row, "id"));
  }

  mapVersion(reviewId: string, mapVersionId: string): HostMapVersion {
    return this.readMapVersion(reviewId, mapVersionId).version;
  }

  mapEvidence(
    reviewId: string,
    mapVersionId: string,
  ): Record<string, HostSourceQuote> {
    return this.readMapVersion(reviewId, mapVersionId).evidence;
  }

  maps(
    reviewId: string,
    input: { mapId?: string; cursor?: string; limit?: number },
  ) {
    this.review(reviewId);
    const mapId = input.mapId ?? null;
    const limit = Math.max(1, Math.min(input.limit ?? 100, 200));
    let upper = z
      .number()
      .int()
      .parse(
        this.db
          .prepare(
            "SELECT COALESCE(MAX(v.sequence),0) AS sequence FROM host_map_versions v JOIN host_maps m ON v.map_id=m.id WHERE m.review_id=? AND (? IS NULL OR m.id=?)",
          )
          .get(reviewId, mapId, mapId)!.sequence,
      );
    let last = upper + 1;
    if (input.cursor) {
      let decoded: JsonValue;
      try {
        decoded = parseJsonText(
          Buffer.from(input.cursor, "base64url").toString("utf8"),
        );
      } catch {
        throw new HostStoreError("CURSOR_EXPIRED", "Map cursor is invalid.");
      }
      const cursor = z
        .strictObject({
          hostId: z.string(),
          reviewId: z.string(),
          mapId: z.string().nullable(),
          upper: z.number().int().nonnegative(),
          last: z.number().int().positive(),
        })
        .safeParse(decoded);
      if (
        !cursor.success ||
        cursor.data.hostId !== this.hostId ||
        cursor.data.reviewId !== reviewId ||
        cursor.data.mapId !== mapId ||
        cursor.data.upper > upper ||
        cursor.data.last > cursor.data.upper
      )
        throw new HostStoreError(
          "CURSOR_EXPIRED",
          "Map cursor does not belong to this retained query.",
        );
      upper = cursor.data.upper;
      last = cursor.data.last;
    }
    const rows = this.db
      .prepare(
        "SELECT v.sequence,v.id,v.map_id,v.revision,v.content_hash,v.created_at,m.repository_id,m.commit_oid FROM host_map_versions v JOIN host_maps m ON v.map_id=m.id WHERE m.review_id=? AND (? IS NULL OR m.id=?) AND v.sequence<=? AND v.sequence<? ORDER BY v.sequence DESC LIMIT ?",
      )
      .all(reviewId, mapId, mapId, upper, last, limit + 1);
    const selected = rows.slice(0, limit);
    return {
      items: selected.map((row) =>
        HostMapSummarySchema.parse({
          id: row.id,
          mapId: row.map_id,
          repositoryId: row.repository_id,
          commit: row.commit_oid,
          revision: row.revision,
          contentHash: row.content_hash,
          createdAt: row.created_at,
        }),
      ),
      nextCursor:
        rows.length > limit
          ? Buffer.from(
              canonicalHostJson({
                hostId: this.hostId,
                reviewId,
                mapId,
                upper,
                last: z.number().int().parse(selected.at(-1)!.sequence),
              }),
            ).toString("base64url")
          : null,
    };
  }

  putTrace(reviewId: string, retained: HostRetainedTrace): void {
    this.requireWrite();
    this.mutableResourceReview(reviewId);
    const parsed = HostRetainedTraceSchema.parse(retained);
    if (parsed.trace.parentTraceId !== null)
      this.trace(reviewId, parsed.trace.parentTraceId);
    this.db
      .prepare(
        "INSERT INTO host_traces(id,review_id,content_hash,record_json) VALUES (?,?,?,?)",
      )
      .run(
        parsed.trace.id,
        reviewId,
        contentHash(parsed),
        canonicalHostJson(parsed),
      );
  }

  trace(reviewId: string, traceId: string): HostRetainedTrace {
    const row = this.db
      .prepare(
        "SELECT content_hash,record_json FROM host_traces WHERE review_id=? AND id=?",
      )
      .get(reviewId, traceId);
    if (!row) throw new HostStoreError("NOT_FOUND", "Trace not found.");
    const value = HostRetainedTraceSchema.parse(
      parseJsonText(rowText(row, "record_json")),
    );
    if (
      value.trace.id !== traceId ||
      contentHash(value) !== rowText(row, "content_hash")
    )
      throw new HostStoreError(
        "INTEGRITY_ERROR",
        "Retained trace failed its integrity check.",
      );
    return value;
  }

  putAsset(reviewId: string, asset: HostAsset, bytes: Uint8Array): void {
    this.requireWrite();
    this.mutableResourceReview(reviewId);
    const parsed = HostAssetSchema.parse(asset);
    if (
      bytes.byteLength !== parsed.byteLength ||
      createHash("sha256").update(bytes).digest("hex") !== parsed.sha256
    )
      throw new HostStoreError(
        "INTEGRITY_ERROR",
        "Image bytes do not match their retained metadata.",
      );
    this.db
      .prepare(
        "INSERT OR IGNORE INTO host_asset_blobs(hash,bytes) VALUES (?,?)",
      )
      .run(parsed.sha256, bytes);
    this.db
      .prepare(
        "INSERT INTO host_assets(id,review_id,blob_hash,content_hash,record_json) VALUES (?,?,?,?,?)",
      )
      .run(
        parsed.id,
        reviewId,
        parsed.sha256,
        contentHash(parsed),
        canonicalHostJson(parsed),
      );
  }

  asset(reviewId: string, assetId: string) {
    const row = this.db
      .prepare(
        "SELECT a.record_json,a.content_hash,a.blob_hash,b.bytes FROM host_assets a JOIN host_asset_blobs b ON a.blob_hash=b.hash WHERE a.review_id=? AND a.id=?",
      )
      .get(reviewId, assetId);
    if (!row) throw new HostStoreError("NOT_FOUND", "Image asset not found.");
    const asset = HostAssetSchema.parse(
      parseJsonText(rowText(row, "record_json")),
    );
    if (
      !(row.bytes instanceof Uint8Array) ||
      asset.id !== assetId ||
      contentHash(asset) !== rowText(row, "content_hash") ||
      asset.sha256 !== rowText(row, "blob_hash") ||
      asset.byteLength !== row.bytes.byteLength ||
      createHash("sha256").update(row.bytes).digest("hex") !== asset.sha256
    )
      throw new HostStoreError(
        "INTEGRITY_ERROR",
        "Retained image failed its integrity check.",
      );
    return { asset, bytes: row.bytes };
  }

  private writeMapVersion(
    mapId: string,
    revision: number,
    prepared: HostPreparedMap,
  ): HostMapVersion {
    const version = HostMapVersionSchema.parse({
      ...prepared.map,
      id: randomUUID(),
      mapId,
      repositoryId: prepared.repositoryId,
      commit: prepared.commit,
      revision,
      contentHash: contentHash({ ...prepared }),
      createdAt: new Date().toISOString(),
    });
    this.db
      .prepare(
        "INSERT INTO host_map_versions(id,map_id,revision,content_hash,created_at,record_json,evidence_json) VALUES (?,?,?,?,?,?,?)",
      )
      .run(
        version.id,
        mapId,
        revision,
        version.contentHash,
        version.createdAt,
        canonicalHostJson(version),
        canonicalHostJson(prepared.evidence),
      );
    return version;
  }

  private readMapVersion(reviewId: string, mapVersionId: string) {
    const row = this.db
      .prepare(
        "SELECT v.record_json,v.evidence_json,v.map_id,v.revision,v.content_hash,v.created_at,m.repository_id,m.commit_oid FROM host_map_versions v JOIN host_maps m ON v.map_id=m.id WHERE m.review_id=? AND v.id=?",
      )
      .get(reviewId, mapVersionId);
    if (!row) throw new HostStoreError("NOT_FOUND", "Map version not found.");
    const version = HostMapVersionSchema.parse(
      parseJsonText(rowText(row, "record_json")),
    );
    const evidence = z
      .record(HostHashSchema, HostSourceQuoteSchema)
      .parse(parseJsonText(rowText(row, "evidence_json")));
    const prepared = {
      repositoryId: version.repositoryId,
      commit: version.commit,
      map: {
        schemaVersion: version.schemaVersion,
        elements: version.elements,
        relationships: version.relationships,
      },
      evidence,
    };
    if (
      version.id !== mapVersionId ||
      version.mapId !== row.map_id ||
      version.revision !== row.revision ||
      version.repositoryId !== row.repository_id ||
      version.commit !== row.commit_oid ||
      version.createdAt !== row.created_at ||
      version.contentHash !== row.content_hash ||
      contentHash(prepared) !== version.contentHash
    )
      throw new HostStoreError(
        "INTEGRITY_ERROR",
        "Retained map failed its integrity check.",
      );
    return { version, evidence };
  }

  private mutableResourceReview(reviewId: string) {
    const review = this.review(reviewId);
    if (review.deletedAt !== null || review.workflow === "closed")
      throw new HostStoreError(
        "INVALID_STATE",
        "Closed or trashed reviews cannot be authored.",
      );
    return review;
  }

  saveDraft(record: HostDraft, expectedVersion: number | null): HostDraft {
    this.requireWrite();
    const draft = HostDraftSchema.parse(record);
    this.mutableResourceReview(draft.reviewId);
    this.document(draft.reviewId, draft.target.documentVersion);
    if (expectedVersion === null) {
      const existing = this.db
        .prepare("SELECT review_id,principal_id FROM host_drafts WHERE id=?")
        .get(draft.id);
      if (existing) {
        if (
          existing.review_id !== draft.reviewId ||
          existing.principal_id !== draft.principalId
        )
          throw new HostStoreError("NOT_FOUND", "Draft not found.");
        throw new HostStoreError(
          "VERSION_CONFLICT",
          "Draft already exists. Read its current version.",
        );
      }
      if (draft.version !== 0)
        throw new HostStoreError(
          "INVALID_STATE",
          "New drafts must start at version zero.",
        );
      this.db
        .prepare(
          "INSERT INTO host_drafts(id,review_id,principal_id,version,document_version,record_json) VALUES (?,?,?,?,?,?)",
        )
        .run(
          draft.id,
          draft.reviewId,
          draft.principalId,
          draft.version,
          draft.target.documentVersion,
          canonicalHostJson(draft),
        );
    } else {
      const before = this.draft(draft.reviewId, draft.id, draft.principalId);
      if (before.version !== expectedVersion)
        throw new HostStoreError(
          "VERSION_CONFLICT",
          "Draft changed. Refresh before saving.",
        );
      if (
        draft.version !== before.version + 1 ||
        draft.createdAt !== before.createdAt
      )
        throw new HostStoreError(
          "INVALID_STATE",
          "Draft identity and creation time are immutable.",
        );
      this.db
        .prepare(
          "UPDATE host_drafts SET version=?,document_version=?,record_json=? WHERE id=?",
        )
        .run(
          draft.version,
          draft.target.documentVersion,
          canonicalHostJson(draft),
          draft.id,
        );
    }
    return draft;
  }

  draft(reviewId: string, id: string, principalId: string): HostDraft {
    const row = this.db
      .prepare(
        "SELECT record_json FROM host_drafts WHERE review_id=? AND id=? AND principal_id=?",
      )
      .get(reviewId, id, principalId);
    if (!row) throw new HostStoreError("NOT_FOUND", "Draft not found.");
    return HostDraftSchema.parse(parseJsonText(rowText(row, "record_json")));
  }

  drafts(reviewId: string, principalId: string): HostDraft[] {
    this.review(reviewId);
    return this.db
      .prepare(
        "SELECT record_json FROM host_drafts WHERE review_id=? AND principal_id=? ORDER BY rowid DESC",
      )
      .all(reviewId, principalId)
      .map((row) =>
        HostDraftSchema.parse(parseJsonText(rowText(row, "record_json"))),
      );
  }

  deleteDraft(
    reviewId: string,
    id: string,
    principalId: string,
    expectedVersion: number,
  ): void {
    this.requireWrite();
    const before = this.draft(reviewId, id, principalId);
    if (before.version !== expectedVersion)
      throw new HostStoreError(
        "VERSION_CONFLICT",
        "Draft changed. Refresh before deleting.",
      );
    this.db.prepare("DELETE FROM host_drafts WHERE id=?").run(id);
  }

  createThread(record: HostThread): HostThread {
    this.requireWrite();
    const thread = HostThreadSchema.parse(record);
    this.mutableResourceReview(thread.reviewId);
    this.document(thread.reviewId, thread.target.documentVersion);
    if (thread.version !== 0)
      throw new HostStoreError(
        "INVALID_STATE",
        "New threads must start at version zero.",
      );
    this.db
      .prepare(
        "INSERT INTO host_threads(id,review_id,document_version,record_json) VALUES (?,?,?,?)",
      )
      .run(
        thread.id,
        thread.reviewId,
        thread.target.documentVersion,
        canonicalHostJson(thread),
      );
    return thread;
  }

  thread(reviewId: string, id: string): HostThread {
    const row = this.db
      .prepare(
        "SELECT record_json FROM host_threads WHERE review_id=? AND id=?",
      )
      .get(reviewId, id);
    if (!row) throw new HostStoreError("NOT_FOUND", "Thread not found.");
    return HostThreadSchema.parse(parseJsonText(rowText(row, "record_json")));
  }

  threads(reviewId: string): HostThread[] {
    this.review(reviewId);
    return this.db
      .prepare(
        "SELECT record_json FROM host_threads WHERE review_id=? ORDER BY rowid DESC",
      )
      .all(reviewId)
      .map((row) =>
        HostThreadSchema.parse(parseJsonText(rowText(row, "record_json"))),
      );
  }

  setThreadStatus(
    reviewId: string,
    id: string,
    expectedVersion: number,
    status: HostThread["status"],
  ): HostThread {
    this.requireWrite();
    this.mutableResourceReview(reviewId);
    const before = this.thread(reviewId, id);
    if (before.version !== expectedVersion)
      throw new HostStoreError(
        "VERSION_CONFLICT",
        "Thread changed. Refresh before changing its status.",
      );
    if (before.status === status) return before;
    const after = HostThreadSchema.parse({
      ...before,
      status,
      version: before.version + 1,
      updatedAt: new Date().toISOString(),
    });
    this.db
      .prepare("UPDATE host_threads SET record_json=? WHERE id=?")
      .run(canonicalHostJson(after), id);
    return after;
  }

  appendMessage(
    reviewId: string,
    input: Omit<HostMessage, "ordinal">,
  ): HostMessage {
    this.requireWrite();
    const thread = this.thread(reviewId, input.threadId);
    const previous = this.db
      .prepare(
        "SELECT t.review_id,m.record_json FROM host_messages m JOIN host_threads t ON m.thread_id=t.id WHERE m.id=?",
      )
      .get(input.id);
    if (previous) {
      if (previous.review_id !== reviewId)
        throw new HostStoreError("NOT_FOUND", "Message not found.");
      const existing = HostMessageSchema.parse(
        parseJsonText(rowText(previous, "record_json")),
      );
      if (
        canonicalHostJson(messageIdentity(existing)) !==
        canonicalHostJson(messageIdentity(input))
      )
        throw new HostStoreError(
          "IDEMPOTENCY_CONFLICT",
          "Message ID was already used for different content.",
        );
      return existing;
    }
    if (input.replyToMessageId !== null) {
      const reply = this.message(reviewId, input.replyToMessageId);
      if (reply.threadId !== thread.id)
        throw new HostStoreError(
          "INVALID_STATE",
          "Replies must remain in the same thread.",
        );
    }
    if (input.questionRunId !== null) {
      const run = this.questionRun(reviewId, input.questionRunId);
      if (
        run.threadId !== thread.id ||
        run.assistant.id !== input.author.id ||
        input.replyToMessageId !== run.questionId ||
        (run.state !== "pending" && run.state !== "running")
      )
        throw new HostStoreError(
          "INVALID_STATE",
          "This answer does not belong to an active question run.",
        );
      // Accepted work may finish after its review is closed or trashed.
    } else this.mutableResourceReview(reviewId);
    const last = this.db
      .prepare(
        "SELECT COALESCE(MAX(ordinal),0) AS ordinal FROM host_messages WHERE thread_id=?",
      )
      .get(thread.id)!;
    const message = HostMessageSchema.parse({
      ...input,
      ordinal: z.number().int().parse(last.ordinal) + 1,
    });
    this.db
      .prepare(
        "INSERT INTO host_messages(id,thread_id,ordinal,reply_to_message_id,question_run_id,record_json) VALUES (?,?,?,?,?,?)",
      )
      .run(
        message.id,
        message.threadId,
        message.ordinal,
        message.replyToMessageId,
        message.questionRunId,
        canonicalHostJson(message),
      );
    return message;
  }

  messages(reviewId: string, threadId: string): HostMessage[] {
    this.thread(reviewId, threadId);
    return this.db
      .prepare(
        "SELECT record_json FROM host_messages WHERE thread_id=? ORDER BY ordinal",
      )
      .all(threadId)
      .map((row) =>
        HostMessageSchema.parse(parseJsonText(rowText(row, "record_json"))),
      );
  }

  putSubmission(record: HostFeedbackSubmission): HostFeedbackSubmission {
    this.requireWrite();
    const submission = HostFeedbackSubmissionSchema.parse(record);
    this.mutableResourceReview(submission.reviewId);
    this.checkpoint(submission.reviewId, submission.checkpointId);
    if (
      submission.threadIds.length !== submission.messageIds.length ||
      new Set(submission.messageIds).size !== submission.messageIds.length
    )
      throw new HostStoreError(
        "INVALID_STATE",
        "Submission messages must correspond to its selected threads.",
      );
    submission.messageIds.forEach((id, index) => {
      const message = this.message(submission.reviewId, id);
      if (message.threadId !== submission.threadIds[index])
        throw new HostStoreError(
          "INVALID_STATE",
          "Submission message belongs to a different thread.",
        );
    });
    this.db
      .prepare(
        "INSERT INTO host_feedback_submissions(id,review_id,checkpoint_id,record_json) VALUES (?,?,?,?)",
      )
      .run(
        submission.id,
        submission.reviewId,
        submission.checkpointId,
        canonicalHostJson(submission),
      );
    return submission;
  }

  submission(reviewId: string, id: string): HostFeedbackSubmission {
    const row = this.db
      .prepare(
        "SELECT record_json FROM host_feedback_submissions WHERE review_id=? AND id=?",
      )
      .get(reviewId, id);
    if (!row)
      throw new HostStoreError("NOT_FOUND", "Feedback submission not found.");
    return HostFeedbackSubmissionSchema.parse(
      parseJsonText(rowText(row, "record_json")),
    );
  }

  submissions(reviewId: string): HostFeedbackSubmission[] {
    this.review(reviewId);
    return this.db
      .prepare(
        "SELECT record_json FROM host_feedback_submissions WHERE review_id=? ORDER BY rowid DESC",
      )
      .all(reviewId)
      .map((row) =>
        HostFeedbackSubmissionSchema.parse(
          parseJsonText(rowText(row, "record_json")),
        ),
      );
  }

  putQuestionContext(record: HostQuestionContext): HostQuestionContext {
    this.requireWrite();
    const context = HostQuestionContextSchema.parse(record);
    this.mutableResourceReview(context.reviewId);
    this.document(context.reviewId, context.documentVersion);
    if (Buffer.byteLength(canonicalHostJson(context)) > 64 * 1024)
      throw new HostStoreError(
        "INVALID_STATE",
        "Question context exceeds its retained size limit.",
      );
    this.db
      .prepare(
        "INSERT INTO host_question_contexts(id,review_id,document_version,record_json) VALUES (?,?,?,?)",
      )
      .run(
        context.id,
        context.reviewId,
        context.documentVersion,
        canonicalHostJson(context),
      );
    return context;
  }

  questionContext(reviewId: string, id: string): HostQuestionContext {
    const row = this.db
      .prepare(
        "SELECT record_json FROM host_question_contexts WHERE review_id=? AND id=?",
      )
      .get(reviewId, id);
    if (!row)
      throw new HostStoreError("NOT_FOUND", "Question context not found.");
    return HostQuestionContextSchema.parse(
      parseJsonText(rowText(row, "record_json")),
    );
  }

  createQuestionRun(record: HostQuestionRun): HostQuestionRun {
    this.requireWrite();
    const run = HostQuestionRunSchema.parse(record);
    this.mutableResourceReview(run.reviewId);
    const thread = this.thread(run.reviewId, run.threadId);
    const question = this.message(run.reviewId, run.questionId);
    const context = this.questionContext(run.reviewId, run.contextId);
    if (
      run.state !== "pending" ||
      run.answerMessageId !== null ||
      run.sessionId !== null ||
      run.error !== null ||
      run.assistant.kind !== "agent" ||
      question.threadId !== thread.id ||
      context.question !== question.body ||
      context.documentVersion !== thread.target.documentVersion
    )
      throw new HostStoreError(
        "INVALID_STATE",
        "A new question run must match its frozen question and context.",
      );
    if (
      this.db
        .prepare(
          "SELECT id FROM host_question_runs WHERE question_id=? AND state IN ('pending','running')",
        )
        .get(run.questionId)
    )
      throw new HostStoreError(
        "VERSION_CONFLICT",
        "This question already has an active attempt.",
      );
    this.db
      .prepare(
        "INSERT INTO host_question_runs(id,review_id,thread_id,question_id,context_id,state,answer_message_id,record_json) VALUES (?,?,?,?,?,?,?,?)",
      )
      .run(
        run.id,
        run.reviewId,
        run.threadId,
        run.questionId,
        run.contextId,
        run.state,
        run.answerMessageId,
        canonicalHostJson(run),
      );
    return run;
  }

  questionRun(reviewId: string, id: string): HostQuestionRun {
    const row = this.db
      .prepare(
        "SELECT record_json FROM host_question_runs WHERE review_id=? AND id=?",
      )
      .get(reviewId, id);
    if (!row) throw new HostStoreError("NOT_FOUND", "Question run not found.");
    return HostQuestionRunSchema.parse(
      parseJsonText(rowText(row, "record_json")),
    );
  }

  questionRuns(reviewId: string): HostQuestionRun[] {
    this.review(reviewId);
    return this.db
      .prepare(
        "SELECT record_json FROM host_question_runs WHERE review_id=? ORDER BY rowid DESC",
      )
      .all(reviewId)
      .map((row) =>
        HostQuestionRunSchema.parse(parseJsonText(rowText(row, "record_json"))),
      );
  }

  updateQuestionRun(
    reviewId: string,
    id: string,
    input: Partial<
      Pick<
        HostQuestionRun,
        "state" | "sessionId" | "answerMessageId" | "error" | "updatedAt"
      >
    >,
  ): HostQuestionRun {
    this.requireWrite();
    const changes = HostQuestionRunSchema.pick({
      state: true,
      sessionId: true,
      answerMessageId: true,
      error: true,
      updatedAt: true,
    })
      .partial()
      .parse(input);
    const before = this.questionRun(reviewId, id);
    const after = HostQuestionRunSchema.parse({ ...before, ...changes });
    if (canonicalHostJson(before) === canonicalHostJson(after)) return before;
    if (before.state !== "pending" && before.state !== "running")
      throw new HostStoreError(
        "INVALID_STATE",
        "A terminal question run cannot be changed.",
      );
    if (
      (before.state === "running" && after.state === "pending") ||
      (after.state === "completed" &&
        (after.answerMessageId === null || after.error !== null)) ||
      (after.state !== "completed" && after.answerMessageId !== null)
    )
      throw new HostStoreError(
        "INVALID_STATE",
        "Invalid question run transition.",
      );
    if (after.answerMessageId !== null) {
      const answer = this.message(reviewId, after.answerMessageId);
      if (
        answer.threadId !== before.threadId ||
        answer.questionRunId !== before.id ||
        answer.replyToMessageId !== before.questionId ||
        answer.author.id !== before.assistant.id
      )
        throw new HostStoreError(
          "INVALID_STATE",
          "Completed answer does not belong to this question run.",
        );
    }
    this.db
      .prepare(
        "UPDATE host_question_runs SET state=?,answer_message_id=?,record_json=? WHERE id=?",
      )
      .run(after.state, after.answerMessageId, canonicalHostJson(after), id);
    return after;
  }

  interruptOutstandingQuestionRuns(): HostQuestionRun[] {
    this.requireWrite();
    const rows = this.db
      .prepare(
        "SELECT review_id,id FROM host_question_runs WHERE state IN ('pending','running') ORDER BY rowid",
      )
      .all();
    return rows.map((row) =>
      this.updateQuestionRun(rowText(row, "review_id"), rowText(row, "id"), {
        state: "interrupted",
        error:
          "Review Desktop stopped before this question completed. Retry explicitly to start a new attempt.",
        updatedAt: new Date().toISOString(),
      }),
    );
  }

  attention(reviewId: string, principalId: string): HostAttention {
    this.review(reviewId);
    const row = this.db
      .prepare(
        "SELECT record_json FROM host_attention WHERE review_id=? AND principal_id=?",
      )
      .get(reviewId, principalId);
    return row
      ? HostAttentionSchema.parse(parseJsonText(rowText(row, "record_json")))
      : {
          reviewId,
          principalId,
          version: 0,
          viewedDocumentVersion: null,
          viewedAt: null,
          pinned: false,
        };
  }

  updateAttention(
    record: HostAttention,
    expectedVersion: number,
  ): HostAttention {
    this.requireWrite();
    const attention = HostAttentionSchema.parse(record);
    const before = this.attention(attention.reviewId, attention.principalId);
    if (before.version !== expectedVersion)
      throw new HostStoreError(
        "VERSION_CONFLICT",
        "Attention changed. Read its current version and retry.",
      );
    if (attention.version !== before.version + 1)
      throw new HostStoreError(
        "INVALID_STATE",
        "Attention must advance exactly one version.",
      );
    if (attention.viewedDocumentVersion !== null)
      this.document(attention.reviewId, attention.viewedDocumentVersion);
    this.db
      .prepare(
        "INSERT INTO host_attention(review_id,principal_id,record_json) VALUES (?,?,?) ON CONFLICT(review_id,principal_id) DO UPDATE SET record_json=excluded.record_json",
      )
      .run(
        attention.reviewId,
        attention.principalId,
        canonicalHostJson(attention),
      );
    return attention;
  }

  private message(reviewId: string, id: string): HostMessage {
    const row = this.db
      .prepare(
        "SELECT m.record_json FROM host_messages m JOIN host_threads t ON m.thread_id=t.id WHERE t.review_id=? AND m.id=?",
      )
      .get(reviewId, id);
    if (!row) throw new HostStoreError("NOT_FOUND", "Message not found.");
    return HostMessageSchema.parse(parseJsonText(rowText(row, "record_json")));
  }

  clearCanvasReports(): void {
    this.requireWrite();
    this.db.exec("DELETE FROM host_canvas_reports");
  }

  recordCanvasReport(input: HostCanvasReport, principalId: string): void {
    this.requireWrite();
    const report = HostCanvasReportSchema.parse(input);
    this.document(report.reviewId, report.documentVersion);
    const existing = this.db
      .prepare(
        "SELECT principal_id FROM host_canvas_reports WHERE review_id=? AND canvas_session_id=?",
      )
      .get(report.reviewId, report.canvasSessionId);
    if (existing && existing.principal_id !== principalId)
      throw new HostStoreError("NOT_FOUND", "Canvas session not found.");
    this.db
      .prepare(
        "INSERT OR REPLACE INTO host_canvas_reports(review_id,canvas_session_id,principal_id,received_at,report_json) VALUES (?,?,?,?,?)",
      )
      .run(
        report.reviewId,
        report.canvasSessionId,
        principalId,
        new Date().toISOString(),
        canonicalHostJson(report),
      );
    this.db
      .prepare(
        "DELETE FROM host_canvas_reports WHERE sequence IN (SELECT sequence FROM host_canvas_reports WHERE review_id=? ORDER BY sequence DESC LIMIT -1 OFFSET 20)",
      )
      .run(report.reviewId);
  }

  canvasReports(reviewId: string) {
    this.review(reviewId);
    return this.db
      .prepare(
        "SELECT principal_id,received_at,report_json FROM host_canvas_reports WHERE review_id=? ORDER BY sequence DESC",
      )
      .all(reviewId)
      .map((row) => ({
        ...HostCanvasReportSchema.parse(
          parseJsonText(rowText(row, "report_json")),
        ),
        principalId: rowText(row, "principal_id"),
        receivedAt: rowText(row, "received_at"),
      }));
  }

  retiredIds(reviewId: string): HostRetiredIds {
    const current = this.document(reviewId);
    const result = {
      nodeIds: new Set<string>(),
      definitionIds: new Set<string>(),
    };
    for (const row of this.db
      .prepare(
        "SELECT namespace,local_id FROM host_document_ids WHERE review_id=?",
      )
      .all(reviewId)) {
      const id = rowText(row, "local_id");
      if (row.namespace === "node" && !Object.hasOwn(current.nodes, id))
        result.nodeIds.add(id);
      if (
        row.namespace === "definition" &&
        !Object.hasOwn(current.definitions, id)
      )
        result.definitionIds.add(id);
    }
    return result;
  }

  appendEvent(
    reviewId: string | null,
    type: string,
    payload: JsonValue,
    privatePrincipalId: string | null = null,
  ): string {
    this.requireWrite();
    this.db
      .prepare(
        "INSERT INTO host_events(review_id,private_principal_id,type,payload_json,created_at) VALUES (?,?,?,?,?)",
      )
      .run(
        reviewId,
        privatePrincipalId,
        type,
        canonicalHostJson(payload),
        new Date().toISOString(),
      );
    return this.cursor();
  }

  events(
    after: string,
    input: { principalId: string; reviewId?: string; limit?: number },
  ): HostStoredEvent[] {
    const sequence = this.parseCursor(after);
    const limit = Math.max(1, Math.min(200, input.limit ?? 100));
    return this.db
      .prepare(
        "SELECT sequence,review_id,type,payload_json FROM host_events WHERE sequence>? AND (private_principal_id IS NULL OR private_principal_id=?) AND (? IS NULL OR review_id=?) ORDER BY sequence LIMIT ?",
      )
      .all(
        sequence,
        input.principalId,
        input.reviewId ?? null,
        input.reviewId ?? null,
        limit,
      )
      .map((row) => ({
        cursor: this.formatCursor(z.number().int().parse(row.sequence)),
        reviewId: row.review_id === null ? null : rowText(row, "review_id"),
        type: rowText(row, "type"),
        payload: parseJsonText(rowText(row, "payload_json")),
      }));
  }

  cursor(): string {
    const row = this.db
      .prepare("SELECT COALESCE(MAX(sequence),0) AS sequence FROM host_events")
      .get()!;
    return this.formatCursor(z.number().int().parse(row.sequence));
  }

  private formatCursor(sequence: number): string {
    return `v1:${this.hostId}:${sequence}`;
  }
  private parseCursor(cursor: string): number {
    const prefix = `v1:${this.hostId}:`;
    const value = cursor.slice(prefix.length);
    if (
      !cursor.startsWith(prefix) ||
      !/^(?:0|[1-9][0-9]*)$/.test(value) ||
      !Number.isSafeInteger(Number(value))
    )
      throw new HostStoreError(
        "CURSOR_EXPIRED",
        "Event cursor belongs to a different host or is invalid.",
      );
    const sequence = Number(value);
    if (sequence > Number(this.cursor().slice(prefix.length)))
      throw new HostStoreError(
        "CURSOR_EXPIRED",
        "Event cursor is ahead of this host.",
      );
    return sequence;
  }

  private writeDocumentVersion(
    review: HostStoredReview,
    prepared: HostPreparedDocument,
    version: number,
    createdAt: string,
  ): HostDocumentState {
    const objects = new Map<string, { kind: string; value: JsonValue }>();
    const collect = (
      kind: string,
      values: Record<string, JsonValue>,
    ): Record<string, string> =>
      Object.fromEntries(
        Object.entries(values).map(([id, value]) => {
          const hash = contentHash({ kind, schemaVersion: 1, value });
          objects.set(hash, { kind, value });
          return [id, hash];
        }),
      );
    const manifest: HostDocumentManifest = {
      schemaVersion: 1,
      roots: prepared.document.roots,
      nodes: collect("node", prepared.document.nodes),
      definitions: collect("definition", prepared.document.definitions),
      evidence: collect("evidence", prepared.evidence),
    };
    const hash = contentHash({
      schemaVersion: 1,
      binding: prepared.binding,
      manifest,
    });
    for (const [objectHash, object] of objects)
      this.db
        .prepare(
          "INSERT OR IGNORE INTO host_content_objects(hash,kind,value_json) VALUES (?,?,?)",
        )
        .run(objectHash, object.kind, canonicalHostJson(object.value));
    this.db
      .prepare(
        "INSERT INTO host_document_versions(review_id,version,binding_json,manifest_json,content_hash,created_at) VALUES (?,?,?,?,?,?)",
      )
      .run(
        review.id,
        version,
        canonicalHostJson(prepared.binding),
        canonicalHostJson(manifest),
        hash,
        createdAt,
      );
    for (const objectHash of objects.keys())
      this.db
        .prepare(
          "INSERT INTO host_document_object_refs(review_id,version,hash) VALUES (?,?,?)",
        )
        .run(review.id, version, objectHash);
    for (const [namespace, ids] of [
      ["node", Object.keys(prepared.document.nodes)],
      ["definition", Object.keys(prepared.document.definitions)],
    ] as const)
      for (const id of ids)
        this.db
          .prepare(
            "INSERT OR IGNORE INTO host_document_ids(review_id,namespace,local_id) VALUES (?,?,?)",
          )
          .run(review.id, namespace, id);
    return {
      ...prepared.document,
      documentId: review.documentId,
      reviewId: review.id,
      version,
      binding: prepared.binding,
      evidence: prepared.evidence,
      contentHash: hash,
      createdAt,
    };
  }

  private requireWrite(): void {
    if (!this.writing)
      throw new Error(
        "Host state must be changed inside a command transaction.",
      );
  }
  private parseResponse(json: string): HostStoredResponse {
    const value = z
      .strictObject({ eventCursor: z.string(), result: z.json() })
      .safeParse(parseJsonText(json));
    if (!value.success)
      throw new HostStoreError(
        "INTEGRITY_ERROR",
        "Command receipt is invalid.",
      );
    return value.data;
  }
}
