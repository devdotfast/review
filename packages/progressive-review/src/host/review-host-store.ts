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
  type HostFeedbackTarget,
  HostFeedbackTargetSchema,
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
  type HostRetainedTrace,
  HostRetainedTraceSchema,
  type HostReviewState,
  HostReviewStateSchema,
  type HostReviewVersionHeader,
  HostReviewVersionHeaderSchema,
  type HostReviewVersionSummary,
  HostReviewVersionSummarySchema,
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
export type HostStoredReview = HostReviewState;
export type HostReviewMetadata = Pick<
  HostReviewVersionHeader,
  "title" | "description" | "labels" | "mapVersions"
>;
export interface HostReviewCommitOptions {
  metadata?: HostReviewMetadata;
  principalId?: string;
  reason?: HostReviewVersionSummary["reason"];
  restoredFromReviewVersion?: number;
  force?: boolean;
}

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
    readonly currentVersion?: number,
  ) {
    super(message);
    this.name = "HostStoreError";
  }
}

export interface HostStoredResponse<TResult extends JsonValue = JsonValue> {
  result: TResult;
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

interface HostDocumentItemIdentity {
  key: string;
  nodeId: string;
  path: string;
}

const LegacyFeedbackTargetSchema = z
  .object({
    kind: z.string(),
    documentVersion: z.number(),
    nodeId: z.string().optional(),
    itemId: z.string().optional(),
    commit: z.string().optional(),
  })
  .passthrough();
type LegacyFeedbackTarget = z.infer<typeof LegacyFeedbackTargetSchema>;

/** Stable item identities include their owning diagram and typed sub-scope. */
function documentItemIdentities(
  document: HostDocument,
): HostDocumentItemIdentity[] {
  const items: HostDocumentItemIdentity[] = [];
  for (const node of Object.values(document.nodes)) {
    const root = `/nodes/${node.id.replaceAll("~", "~0").replaceAll("/", "~1")}`;
    const add = (scope: string[], path: string) =>
      items.push({
        key: JSON.stringify([node.id, ...scope]),
        nodeId: node.id,
        path: `${root}${path}`,
      });
    if (node.type === "sequence")
      node.messages.forEach((item, index) =>
        add(["message", item.id], `/messages/${index}/id`),
      );
    else if (node.type === "call_stack_diff")
      for (const side of ["base", "head"] as const)
        node[side].forEach((item, index) =>
          add(["frame", side, item.id], `/${side}/${index}/id`),
        );
    else if (node.type === "database_lens")
      node.useCases.forEach((useCase, index) => {
        add(["use_case", useCase.id], `/useCases/${index}/id`);
        useCase.operations.forEach((item, operationIndex) =>
          add(
            ["operation", useCase.id, item.id],
            `/useCases/${index}/operations/${operationIndex}/id`,
          ),
        );
      });
  }
  return items;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS host_review_states (
  review_id TEXT PRIMARY KEY REFERENCES host_reviews(id), record_json TEXT NOT NULL CHECK(json_valid(record_json))
) STRICT;
CREATE TABLE IF NOT EXISTS host_review_versions (
  review_id TEXT NOT NULL, version INTEGER NOT NULL, record_json TEXT NOT NULL CHECK(json_valid(record_json)),
  PRIMARY KEY(review_id,version),
  FOREIGN KEY(review_id,version) REFERENCES host_document_versions(review_id,version)
) STRICT;
CREATE TABLE IF NOT EXISTS host_feedback_submissions_v2 (
  id TEXT PRIMARY KEY, review_id TEXT NOT NULL, review_version INTEGER NOT NULL, record_json TEXT NOT NULL CHECK(json_valid(record_json)),
  FOREIGN KEY(review_id,review_version) REFERENCES host_document_versions(review_id,version)
) STRICT;
CREATE TABLE IF NOT EXISTS host_feedback_sequences (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, record_id TEXT NOT NULL,
  review_id TEXT NOT NULL, principal_id TEXT, UNIQUE(kind,record_id)
) STRICT;
CREATE TABLE IF NOT EXISTS host_legacy_records (
  table_name TEXT NOT NULL, record_id TEXT NOT NULL, record_json TEXT NOT NULL,
  PRIMARY KEY(table_name,record_id)
) STRICT;

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
CREATE TABLE IF NOT EXISTS host_document_item_ids (
  review_id TEXT NOT NULL REFERENCES host_reviews(id), item_key TEXT NOT NULL,
  PRIMARY KEY(review_id,item_key)
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
CREATE TABLE IF NOT EXISTS host_map_item_ids (
  map_id TEXT NOT NULL REFERENCES host_maps(id), namespace TEXT NOT NULL CHECK(namespace IN ('element','relationship')),
  local_id TEXT NOT NULL, PRIMARY KEY(map_id,namespace,local_id)
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
    if (version?.value !== "1" && version?.value !== "2")
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
      if (version && version.value !== "1" && version.value !== "2")
        throw new HostStoreError(
          "INVALID_STATE",
          "This review database requires a different application version.",
        );
      const put = this.db.prepare(
        "INSERT OR IGNORE INTO host_meta(key,value) VALUES (?,?)",
      );
      put.run("schema_version", "2");
      this.migrateReviewVersions();
      if (version?.value === "1") this.migrateLegacyRecords();
      this.migrateDocumentItemIds();
      this.migrateMapItemIds();
      this.migrateFeedbackSequences();
      this.db
        .prepare("UPDATE host_meta SET value='2' WHERE key='schema_version'")
        .run();
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

  /** Additive upgrade: old records and tables remain available for recovery. */
  private migrateReviewVersions(): void {
    const legacySchema = z.object({
      id: z.string(),
      repositoryId: z.string(),
      documentVersion: z.number(),
      version: z.number(),
      title: z.string(),
      description: z.string(),
      labels: z.array(z.string()),
      workflow: z.string(),
      createdBy: z.string(),
      createdAt: z.string(),
      deletedAt: z.string().nullable(),
      publishedCheckpointId: z.string().nullable(),
    });
    const checkpointSchema = z.object({
      id: z.string(),
      documentVersion: z.number(),
      title: z.string(),
      description: z.string(),
      createdAt: z.string(),
      createdBy: z.string(),
      mapVersions: z.object({
        base: z.string().nullable(),
        head: z.string().nullable(),
      }),
    });
    for (const row of this.db
      .prepare("SELECT id,record_json FROM host_reviews ORDER BY id")
      .all()) {
      const reviewId = rowText(row, "id");
      if (
        this.db
          .prepare("SELECT 1 FROM host_review_states WHERE review_id=?")
          .get(reviewId)
      )
        continue;
      const raw = rowText(row, "record_json"),
        legacy = legacySchema.parse(parseJsonText(raw));
      this.db
        .prepare(
          "INSERT OR IGNORE INTO host_legacy_records VALUES ('host_reviews',?,?)",
        )
        .run(reviewId, raw);
      const state: HostReviewState = {
        id: legacy.id,
        repositoryId: legacy.repositoryId,
        latestReviewVersion: legacy.documentVersion,
        stateVersion: legacy.version,
        state: legacy.workflow === "closed" ? "closed" : "open",
        deletedAt: legacy.deletedAt,
        createdAt: legacy.createdAt,
        createdBy: legacy.createdBy,
      };
      this.db
        .prepare("INSERT INTO host_review_states VALUES (?,?)")
        .run(reviewId, canonicalHostJson(state));
      const checkpoints = this.db
        .prepare(
          "SELECT record_json FROM host_checkpoints WHERE review_id=? ORDER BY ordinal",
        )
        .all(reviewId)
        .map((item) =>
          checkpointSchema.parse(parseJsonText(rowText(item, "record_json"))),
        );
      const historicalRecords = this.db
        .prepare(
          "SELECT created_at,payload_json FROM host_events WHERE review_id=? AND type IN ('review.created','review.updated') ORDER BY sequence",
        )
        .all(reviewId)
        .flatMap((item) => {
          const parsed = z
            .object({ review: legacySchema })
            .safeParse(parseJsonText(rowText(item, "payload_json")));
          return parsed.success
            ? [{ at: rowText(item, "created_at"), review: parsed.data.review }]
            : [];
        });
      const latestDocument = this.document(reviewId, legacy.documentVersion);
      const latestCheckpoint = checkpoints.find(
        (item) => item.id === legacy.publishedCheckpointId,
      );
      const checkpointBinding = latestCheckpoint
        ? this.document(reviewId, latestCheckpoint.documentVersion).binding
        : null;
      const selectedMaps =
        latestCheckpoint &&
        checkpointBinding?.baseCommit === latestDocument.binding.baseCommit &&
        checkpointBinding.headCommit === latestDocument.binding.headCommit
          ? latestCheckpoint.mapVersions
          : { base: null, head: null };
      const currentMetadata: HostReviewMetadata = {
        title: legacy.title,
        description: legacy.description,
        labels: legacy.labels,
        mapVersions: selectedMaps,
      };
      let nextVersion = legacy.documentVersion;
      for (const item of this.db
        .prepare(
          "SELECT version,created_at FROM host_document_versions WHERE review_id=? ORDER BY version",
        )
        .all(reviewId)) {
        const version = z.number().parse(item.version),
          at = rowText(item, "created_at");
        const historical =
          historicalRecords
            .filter(
              (record) =>
                record.at <= at && record.review.documentVersion <= version,
            )
            .at(-1)?.review ??
          historicalRecords[0]?.review ??
          legacy;
        const metadata =
          version === legacy.documentVersion
            ? currentMetadata
            : {
                title: historical.title,
                description: historical.description,
                labels: historical.labels,
                mapVersions: { base: null, head: null },
              };
        this.writeReviewHeader(
          state,
          this.document(reviewId, version),
          metadata,
          version === 0 ? "create" : "document",
          historical.createdBy,
        );
      }
      // Publication could change metadata/maps without changing the old document
      // counter. Preserve every distinct checkpoint as its own exact snapshot.
      const checkpointVersions = new Map<string, number>();
      for (const checkpoint of checkpoints) {
        const original = this.document(reviewId, checkpoint.documentVersion);
        const historical =
          historicalRecords
            .filter((record) => record.at <= checkpoint.createdAt)
            .at(-1)?.review ?? legacy;
        const metadata = {
          title: checkpoint.title,
          description: checkpoint.description,
          labels: historical.labels,
          mapVersions: checkpoint.mapVersions,
        };
        const existing = this.reviewSnapshot(
          reviewId,
          checkpoint.documentVersion,
        );
        const same =
          canonicalHostJson(metadata) ===
          canonicalHostJson({
            title: existing.title,
            description: existing.description,
            labels: existing.labels,
            mapVersions: existing.mapVersions,
          });
        if (same) {
          checkpointVersions.set(checkpoint.id, checkpoint.documentVersion);
          continue;
        }
        const document = this.writeDocumentVersion(
          state,
          {
            document: {
              schemaVersion: original.schemaVersion,
              roots: original.roots,
              nodes: original.nodes,
              definitions: original.definitions,
            },
            binding: original.binding,
            evidence: original.evidence,
          },
          ++nextVersion,
          checkpoint.createdAt,
        );
        this.writeReviewHeader(
          state,
          document,
          metadata,
          "metadata",
          checkpoint.createdBy,
        );
        checkpointVersions.set(checkpoint.id, nextVersion);
      }
      if (nextVersion !== legacy.documentVersion) {
        const document = this.writeDocumentVersion(
          state,
          {
            document: {
              schemaVersion: latestDocument.schemaVersion,
              roots: latestDocument.roots,
              nodes: latestDocument.nodes,
              definitions: latestDocument.definitions,
            },
            binding: latestDocument.binding,
            evidence: latestDocument.evidence,
          },
          ++nextVersion,
          new Date().toISOString(),
        );
        this.writeReviewHeader(
          state,
          document,
          currentMetadata,
          "metadata",
          legacy.createdBy,
        );
        this.db
          .prepare("UPDATE host_reviews SET document_version=? WHERE id=?")
          .run(nextVersion, reviewId);
        this.db
          .prepare(
            "UPDATE host_review_states SET record_json=? WHERE review_id=?",
          )
          .run(
            canonicalHostJson({ ...state, latestReviewVersion: nextVersion }),
            reviewId,
          );
      }
      for (const item of this.db
        .prepare(
          "SELECT id,record_json FROM host_feedback_submissions WHERE review_id=?",
        )
        .all(reviewId)) {
        const old = z
          .object({ checkpointId: z.string() })
          .passthrough()
          .parse(parseJsonText(rowText(item, "record_json")));
        const version = checkpointVersions.get(old.checkpointId);
        if (version === undefined)
          throw new HostStoreError(
            "INTEGRITY_ERROR",
            "A retained decision has no checkpoint.",
          );
        const { checkpointId: _checkpointId, ...fields } = old;
        const upgraded = HostFeedbackSubmissionSchema.parse({
          ...fields,
          reviewVersion: version,
        });
        this.db
          .prepare(
            "INSERT OR IGNORE INTO host_feedback_submissions_v2 VALUES (?,?,?,?)",
          )
          .run(
            upgraded.id,
            reviewId,
            upgraded.reviewVersion,
            canonicalHostJson(upgraded),
          );
      }
    }
  }

  close(): void {
    this.db.close();
  }

  private upgradeLegacyTarget(
    old: LegacyFeedbackTarget,
    reviewId: string,
  ): HostFeedbackTarget {
    const { documentVersion, commit, itemId, ...fields } = old;
    if (old.kind === "trace")
      return HostFeedbackTargetSchema.parse({
        kind: "node",
        reviewVersion: documentVersion,
        nodeId: old.nodeId,
      });
    if (old.kind !== "diagram") {
      const candidate = {
        ...fields,
        reviewVersion: documentVersion,
      };
      if (commit)
        return HostFeedbackTargetSchema.parse({
          ...candidate,
          comparisonCommit: commit,
        });
      return HostFeedbackTargetSchema.parse(candidate);
    }
    const node = this.document(reviewId, documentVersion).nodes[old.nodeId!];
    const items: JsonValue[] = [];
    if (node?.type === "sequence") {
      if (node.messages.some((item) => item.id === itemId))
        items.push({ kind: "message", messageId: itemId! });
      if (
        node.messages.some(
          (item) => item.fromActorId === itemId || item.toActorId === itemId,
        )
      )
        items.push({ kind: "actor", actorId: itemId! });
    } else if (node?.type === "call_stack_diff") {
      for (const side of ["base", "head"] as const)
        if (node[side].some((item) => item.id === itemId))
          items.push({ kind: "frame", side, frameId: itemId! });
    } else if (node?.type === "database_lens") {
      for (const useCase of node.useCases) {
        if (useCase.id === itemId)
          items.push({ kind: "use_case", useCaseId: itemId! });
        if (useCase.operations.some((item) => item.id === itemId))
          items.push({
            kind: "operation",
            useCaseId: useCase.id,
            operationId: itemId!,
          });
      }
    } else if (node?.type === "software_map") {
      const row = this.db
        .prepare("SELECT record_json FROM host_map_versions WHERE id=?")
        .get(node.mapVersionId);
      const map = z
        .object({
          elements: z.record(z.string(), z.unknown()),
          relationships: z.record(z.string(), z.unknown()),
        })
        .parse(parseJsonText(rowText(row!, "record_json")));
      if (Object.hasOwn(map.elements, itemId!))
        items.push({ kind: "map_element", elementId: itemId! });
      if (Object.hasOwn(map.relationships, itemId!))
        items.push({ kind: "map_relationship", relationshipId: itemId! });
    }
    if (items.length !== 1)
      throw new HostStoreError(
        "INVALID_STATE",
        "A historical diagram comment has an ambiguous item identity. Its original database is unchanged; resolve its item kind/side before upgrading.",
      );
    return HostFeedbackTargetSchema.parse({
      kind: "diagram",
      reviewVersion: documentVersion,
      nodeId: old.nodeId,
      item: items[0],
    });
  }

  private migrateLegacyRecords(): void {
    const recordSchema = z.record(z.string(), z.unknown());
    const backup = (table: string, id: string, raw: string) =>
      this.db
        .prepare("INSERT OR IGNORE INTO host_legacy_records VALUES (?,?,?)")
        .run(table, id, raw);
    for (const [table, counter] of [
      ["host_drafts", "draftVersion"],
      ["host_threads", "threadVersion"],
    ] as const) {
      for (const row of this.db
        .prepare(`SELECT id,review_id,record_json FROM ${table}`)
        .all()) {
        const raw = rowText(row, "record_json"),
          old = recordSchema.parse(parseJsonText(raw));
        if (old[counter] !== undefined) continue;
        const { version, target, ...fields } = old;
        const upgraded = {
          ...fields,
          [counter]: version,
          target: this.upgradeLegacyTarget(
            LegacyFeedbackTargetSchema.parse(target),
            rowText(row, "review_id"),
          ),
        };
        const parsed =
          table === "host_drafts"
            ? HostDraftSchema.parse(upgraded)
            : HostThreadSchema.parse(upgraded);
        backup(table, rowText(row, "id"), raw);
        this.db
          .prepare(`UPDATE ${table} SET record_json=? WHERE id=?`)
          .run(canonicalHostJson(parsed), rowText(row, "id"));
      }
    }
    for (const row of this.db
      .prepare("SELECT review_id,principal_id,record_json FROM host_attention")
      .all()) {
      const raw = rowText(row, "record_json"),
        old = recordSchema.parse(parseJsonText(raw));
      if (old.attentionVersion !== undefined) continue;
      const { version, viewedDocumentVersion, viewedAt, ...fields } = old;
      const parsed = HostAttentionSchema.parse({
        ...fields,
        attentionVersion: version,
        lastViewedReviewVersion: viewedDocumentVersion,
        lastViewedAt: viewedAt,
      });
      backup("host_attention", `${parsed.reviewId}:${parsed.principalId}`, raw);
      this.db
        .prepare(
          "UPDATE host_attention SET record_json=? WHERE review_id=? AND principal_id=?",
        )
        .run(canonicalHostJson(parsed), parsed.reviewId, parsed.principalId);
    }
    for (const row of this.db
      .prepare("SELECT id,record_json FROM host_map_versions")
      .all()) {
      const raw = rowText(row, "record_json"),
        old = recordSchema.parse(parseJsonText(raw));
      if (old.mapVersion !== undefined) continue;
      const { revision, ...fields } = old,
        parsed = HostMapVersionSchema.parse({
          ...fields,
          mapVersion: revision,
        });
      backup("host_map_versions", parsed.id, raw);
      this.db
        .prepare("UPDATE host_map_versions SET record_json=? WHERE id=?")
        .run(canonicalHostJson(parsed), parsed.id);
    }
    for (const row of this.db
      .prepare("SELECT id,record_json FROM host_traces")
      .all()) {
      const raw = rowText(row, "record_json"),
        old = z
          .object({ trace: recordSchema, events: z.array(recordSchema) })
          .parse(parseJsonText(raw));
      const {
        parentTraceId: _parent,
        sessionId: _session,
        version: _version,
        ...trace
      } = old.trace;
      const parsed = HostRetainedTraceSchema.parse({
        trace,
        events: old.events.map((event, index) => ({
          ...event,
          ordinal: index,
          at: event.at ?? null,
        })),
      });
      backup("host_traces", rowText(row, "id"), raw);
      this.db
        .prepare(
          "UPDATE host_traces SET record_json=?,content_hash=? WHERE id=?",
        )
        .run(
          canonicalHostJson(parsed),
          contentHash(parsed),
          rowText(row, "id"),
        );
    }
    for (const row of this.db
      .prepare("SELECT id,review_id,record_json FROM host_question_contexts")
      .all()) {
      const raw = rowText(row, "record_json"),
        old = recordSchema.parse(parseJsonText(raw));
      if (old.reviewVersion !== undefined) continue;
      const reviewId = rowText(row, "review_id"),
        material = recordSchema.parse(old.material);
      const target = this.upgradeLegacyTarget(
        LegacyFeedbackTargetSchema.parse(material.target),
        reviewId,
      );
      const run = this.db
        .prepare(
          "SELECT thread_id,question_id FROM host_question_runs WHERE context_id=? ORDER BY rowid LIMIT 1",
        )
        .get(rowText(row, "id"));
      if (!run)
        throw new HostStoreError(
          "INTEGRITY_ERROR",
          "A saved question context has no run.",
        );
      const excerpt = (text: string) => ({
        state: "truncated" as const,
        text,
      });
      const prior = z.array(recordSchema).parse(material.priorMessages ?? []);
      const question = this.db
        .prepare("SELECT ordinal FROM host_messages WHERE id=?")
        .get(rowText(run, "question_id"));
      const selected =
        material.sourceEvidence === null
          ? null
          : recordSchema.parse(material.sourceEvidence);
      const { documentVersion, ...fields } = old;
      const parsed = HostQuestionContextSchema.parse({
        ...fields,
        reviewVersion: documentVersion,
        material: {
          schemaVersion: 1,
          review: {
            title: excerpt(
              z.string().parse(recordSchema.parse(material.review).title),
            ),
          },
          binding: material.binding,
          mapVersions: this.reviewSnapshot(reviewId, target.reviewVersion)
            .mapVersions,
          originalTarget: target,
          viewedTarget: {
            threadId: rowText(run, "thread_id"),
            reviewVersion: target.reviewVersion,
            status: "exact",
            target,
            evidence: null,
          },
          sourceEvidence: selected
            ? {
                span: selected.span,
                sha256: selected.sha256,
                text: excerpt(z.string().parse(selected.textExcerpt)),
              }
            : null,
          documentJson: excerpt(z.string().parse(material.documentJsonExcerpt)),
          priorMessages: prior.map((item) => ({
            id: item.id,
            author: item.author,
            body: excerpt(z.string().parse(item.bodyExcerpt)),
          })),
          priorMessagesOmitted: Math.max(
            0,
            z.number().parse(question!.ordinal) - 1 - prior.length,
          ),
        },
      });
      backup("host_question_contexts", parsed.id, raw);
      this.db
        .prepare("UPDATE host_question_contexts SET record_json=? WHERE id=?")
        .run(canonicalHostJson(parsed), parsed.id);
    }
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

  snapshot<TResult extends JsonValue>(
    read: () => TResult,
  ): HostStoredResponse<TResult> {
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

  repositories(
    createdThrough = Number.MAX_SAFE_INTEGER,
  ): { id: string; displayName: string; vcs: "git" | "jj" }[] {
    return this.db
      .prepare(
        "SELECT id,display_name,vcs FROM host_repositories WHERE rowid<=? ORDER BY id",
      )
      .all(createdThrough)
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
    metadata: HostReviewMetadata,
  ): HostDocumentState {
    this.requireWrite();
    if (
      review.latestReviewVersion !== 0 ||
      review.stateVersion !== 0 ||
      review.repositoryId !== prepared.binding.repositoryId
    )
      throw new HostStoreError(
        "INVALID_STATE",
        "New reviews require version zero and their registered repository.",
      );
    const state = HostReviewStateSchema.parse(review);
    this.db
      .prepare(
        "INSERT INTO host_reviews(id,repository_id,document_version,record_json) VALUES (?,?,0,?)",
      )
      .run(review.id, review.repositoryId, canonicalHostJson(state));
    this.db
      .prepare(
        "INSERT INTO host_review_states(review_id,record_json) VALUES (?,?)",
      )
      .run(review.id, canonicalHostJson(state));
    const document = this.writeDocumentVersion(
      state,
      prepared,
      0,
      review.createdAt,
    );
    this.writeReviewHeader(
      state,
      document,
      metadata,
      "create",
      review.createdBy,
    );
    return document;
  }

  review(reviewId: string): HostStoredReview {
    const row = this.db
      .prepare("SELECT record_json FROM host_review_states WHERE review_id=?")
      .get(reviewId);
    if (!row) throw new HostStoreError("NOT_FOUND", "Review not found.");
    return HostReviewStateSchema.parse(
      parseJsonText(rowText(row, "record_json")),
    );
  }

  reviewSnapshot(
    reviewId: string,
    reviewVersion?: number,
  ): HostReviewVersionHeader {
    const current = this.review(reviewId);
    const row = this.db
      .prepare(
        "SELECT record_json FROM host_review_versions WHERE review_id=? AND version=?",
      )
      .get(reviewId, reviewVersion ?? current.latestReviewVersion);
    if (!row)
      throw new HostStoreError("NOT_FOUND", "Review version not found.");
    const { reason: _reason, ...header } = HostReviewVersionSummarySchema.parse(
      parseJsonText(rowText(row, "record_json")),
    );
    return HostReviewVersionHeaderSchema.parse(header);
  }

  reviewHistory(reviewId: string): HostReviewVersionSummary[] {
    this.review(reviewId);
    return this.db
      .prepare(
        "SELECT record_json FROM host_review_versions WHERE review_id=? ORDER BY version DESC",
      )
      .all(reviewId)
      .map((row) =>
        HostReviewVersionSummarySchema.parse(
          parseJsonText(rowText(row, "record_json")),
        ),
      );
  }

  /** These identity tables are never deleted or replaced; trash changes only state. */
  collectionBoundary(kind: "reviews" | "repositories"): number {
    const table = kind === "reviews" ? "host_reviews" : "host_repositories";
    return z
      .number()
      .int()
      .nonnegative()
      .parse(
        this.db
          .prepare(`SELECT COALESCE(MAX(rowid),0) AS boundary FROM ${table}`)
          .get()!.boundary,
      );
  }

  reviews(
    includeTrashed = false,
    createdThrough = Number.MAX_SAFE_INTEGER,
  ): HostStoredReview[] {
    return this.db
      .prepare(
        "SELECT s.record_json FROM host_review_states s JOIN host_reviews r ON r.id=s.review_id WHERE r.rowid<=? ORDER BY json_extract(s.record_json,'$.createdAt') DESC,s.review_id DESC",
      )
      .all(createdThrough)
      .map((row) =>
        HostReviewStateSchema.parse(parseJsonText(rowText(row, "record_json"))),
      )
      .filter((review) => includeTrashed || review.deletedAt === null);
  }

  updateReviewState(
    reviewId: string,
    expectedStateVersion: number,
    update: (review: HostStoredReview) => HostStoredReview,
  ): HostStoredReview {
    this.requireWrite();
    const before = this.review(reviewId);
    if (before.stateVersion !== expectedStateVersion)
      throw new HostStoreError(
        "VERSION_CONFLICT",
        "Review state changed. Read its current version.",
        before.stateVersion,
      );
    const proposed = HostReviewStateSchema.parse(update(before));
    if (
      proposed.id !== before.id ||
      proposed.repositoryId !== before.repositoryId ||
      proposed.latestReviewVersion !== before.latestReviewVersion ||
      proposed.createdAt !== before.createdAt ||
      proposed.createdBy !== before.createdBy
    )
      throw new HostStoreError(
        "INVALID_STATE",
        "Lifecycle changes cannot alter review identity or material.",
      );
    if (
      proposed.state === before.state &&
      proposed.deletedAt === before.deletedAt
    )
      return before;
    const after = { ...proposed, stateVersion: before.stateVersion + 1 };
    this.db
      .prepare("UPDATE host_review_states SET record_json=? WHERE review_id=?")
      .run(canonicalHostJson(after), reviewId);
    return after;
  }

  document(reviewId: string, version?: number): HostDocumentState {
    const review = this.review(reviewId);
    const row = this.db
      .prepare(
        "SELECT * FROM host_document_versions WHERE review_id=? AND version=?",
      )
      .get(reviewId, version ?? review.latestReviewVersion);
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
        .all(reviewId, version ?? review.latestReviewVersion)
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
      reviewId,
      reviewVersion: row.version,
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
    expectedReviewVersion: number,
    prepared: HostPreparedDocument,
    options: HostReviewCommitOptions = {},
  ): HostDocumentState {
    this.requireWrite();
    const review = this.mutableResourceReview(reviewId);
    if (review.latestReviewVersion !== expectedReviewVersion)
      throw new HostStoreError(
        "VERSION_CONFLICT",
        "Review material changed. Read its current version.",
        review.latestReviewVersion,
      );
    if (review.repositoryId !== prepared.binding.repositoryId)
      throw new HostStoreError(
        "INVALID_STATE",
        "A review cannot change repositories.",
      );
    const previous = this.document(reviewId);
    if (
      options.restoredFromReviewVersion === undefined &&
      this.reusedDocumentItems(reviewId, prepared.document).length
    )
      throw new HostStoreError(
        "INVALID_STATE",
        "Removed diagram item IDs cannot be reused. Restore the historical review version or use fresh IDs.",
      );
    const priorHeader = this.reviewSnapshot(reviewId);
    const metadata = options.metadata ?? {
      title: priorHeader.title,
      description: priorHeader.description,
      labels: priorHeader.labels,
      mapVersions: priorHeader.mapVersions,
    };
    const same =
      canonicalHostJson({
        document: {
          schemaVersion: previous.schemaVersion,
          roots: previous.roots,
          nodes: previous.nodes,
          definitions: previous.definitions,
        },
        binding: previous.binding,
        evidence: previous.evidence,
        metadata: {
          title: priorHeader.title,
          description: priorHeader.description,
          labels: priorHeader.labels,
          mapVersions: priorHeader.mapVersions,
        },
      }) === canonicalHostJson({ ...prepared, metadata });
    if (same && !options.force) return previous;
    const result = this.writeDocumentVersion(
      review,
      prepared,
      expectedReviewVersion + 1,
      new Date().toISOString(),
    );
    this.writeReviewHeader(
      review,
      result,
      metadata,
      options.reason ?? "document",
      options.principalId ?? review.createdBy,
      options.restoredFromReviewVersion,
    );
    const after = { ...review, latestReviewVersion: result.reviewVersion };
    this.db
      .prepare("UPDATE host_reviews SET document_version=? WHERE id=?")
      .run(result.reviewVersion, reviewId);
    this.db
      .prepare("UPDATE host_review_states SET record_json=? WHERE review_id=?")
      .run(canonicalHostJson(after), reviewId);
    return result;
  }

  private writeReviewHeader(
    review: HostStoredReview,
    document: HostDocumentState,
    metadata: HostReviewMetadata,
    reason: HostReviewVersionSummary["reason"],
    principalId: string,
    restoredFromReviewVersion?: number,
  ): void {
    const header = HostReviewVersionSummarySchema.parse({
      reviewId: review.id,
      reviewVersion: document.reviewVersion,
      ...metadata,
      binding: document.binding,
      createdAt: document.createdAt,
      createdBy: principalId,
      restoredFromReviewVersion: restoredFromReviewVersion ?? null,
      reason,
    });
    this.db
      .prepare(
        "INSERT INTO host_review_versions(review_id,version,record_json) VALUES (?,?,?)",
      )
      .run(review.id, document.reviewVersion, canonicalHostJson(header));
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
    if (before.mapVersion !== expectedVersion)
      throw new HostStoreError(
        "VERSION_CONFLICT",
        "Map changed. Read its current revision and retry.",
        before.mapVersion,
      );
    if (
      before.repositoryId !== prepared.repositoryId ||
      before.commit !== prepared.commit
    )
      throw new HostStoreError(
        "INVALID_STATE",
        "A map's pinned repository and commit cannot change.",
      );
    for (const row of this.db
      .prepare(
        "SELECT namespace,local_id FROM host_map_item_ids WHERE map_id=?",
      )
      .all(mapId)) {
      const id = rowText(row, "local_id");
      const namespace =
        row.namespace === "element" ? "elements" : "relationships";
      if (
        !Object.hasOwn(before[namespace], id) &&
        Object.hasOwn(prepared.map[namespace], id)
      )
        throw new HostStoreError(
          "INVALID_STATE",
          `Removed map ${row.namespace} ID ${id} cannot be reused. Use a fresh ID.`,
        );
    }
    if (before.contentHash === contentHash({ ...prepared })) return before;
    const after = this.writeMapVersion(mapId, expectedVersion + 1, prepared);
    this.db
      .prepare("UPDATE host_maps SET current_revision=? WHERE id=?")
      .run(after.mapVersion, mapId);
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
          mapVersion: row.revision,
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
    mapVersion: number,
    prepared: HostPreparedMap,
  ): HostMapVersion {
    const version = HostMapVersionSchema.parse({
      ...prepared.map,
      id: randomUUID(),
      mapId,
      repositoryId: prepared.repositoryId,
      commit: prepared.commit,
      mapVersion,
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
        mapVersion,
        version.contentHash,
        version.createdAt,
        canonicalHostJson(version),
        canonicalHostJson(prepared.evidence),
      );
    this.rememberMapItemIds(mapId, prepared.map);
    return version;
  }

  private rememberMapItemIds(mapId: string, map: HostMap): void {
    const insert = this.db.prepare(
      "INSERT OR IGNORE INTO host_map_item_ids(map_id,namespace,local_id) VALUES (?,?,?)",
    );
    for (const id of Object.keys(map.elements))
      insert.run(mapId, "element", id);
    for (const id of Object.keys(map.relationships))
      insert.run(mapId, "relationship", id);
  }

  private migrateMapItemIds(): void {
    if (
      this.db
        .prepare("SELECT value FROM host_meta WHERE key='map_item_ids_indexed'")
        .get()
    )
      return;
    for (const row of this.db
      .prepare(
        "SELECT m.review_id,v.id FROM host_map_versions v JOIN host_maps m ON m.id=v.map_id ORDER BY v.sequence",
      )
      .all()) {
      const version = this.mapVersion(
        rowText(row, "review_id"),
        rowText(row, "id"),
      );
      this.rememberMapItemIds(version.mapId, version);
    }
    this.db
      .prepare(
        "INSERT INTO host_meta(key,value) VALUES ('map_item_ids_indexed','1')",
      )
      .run();
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
      version.mapVersion !== row.revision ||
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
    if (review.deletedAt !== null || review.state === "closed")
      throw new HostStoreError(
        "INVALID_STATE",
        "Closed or trashed reviews cannot be authored.",
      );
    return review;
  }

  private migrateFeedbackSequences(): void {
    for (const [kind, table] of Object.entries({
      drafts: "host_drafts",
      threads: "host_threads",
      submissions: "host_feedback_submissions_v2",
      questions: "host_question_runs",
    })) {
      const principal = kind === "drafts" ? "principal_id" : "NULL";
      this.db.exec(
        `INSERT OR IGNORE INTO host_feedback_sequences(kind,record_id,review_id,principal_id) SELECT '${kind}',id,review_id,${principal} FROM ${table} ORDER BY rowid`,
      );
    }
  }

  private recordFeedbackSequence(
    kind: string,
    recordId: string,
    reviewId: string,
    principalId: string | null = null,
  ): void {
    this.db
      .prepare(
        "INSERT INTO host_feedback_sequences(kind,record_id,review_id,principal_id) VALUES (?,?,?,?) ON CONFLICT(kind,record_id) DO UPDATE SET sequence=excluded.sequence,review_id=excluded.review_id,principal_id=excluded.principal_id",
      )
      .run(kind, recordId, reviewId, principalId);
  }

  feedbackSequence(
    kind: "drafts" | "threads" | "submissions" | "questions",
    reviewId: string,
    principalId?: string,
  ): number {
    this.review(reviewId);
    const row = this.db
      .prepare(
        "SELECT COALESCE(MAX(sequence),0) AS sequence FROM host_feedback_sequences WHERE kind=? AND review_id=? AND (? IS NULL OR principal_id=?)",
      )
      .get(kind, reviewId, principalId ?? null, principalId ?? null);
    return z.number().int().parse(row!.sequence);
  }

  saveDraft(record: HostDraft, expectedVersion: number | null): HostDraft {
    this.requireWrite();
    const draft = HostDraftSchema.parse(record);
    this.mutableResourceReview(draft.reviewId);
    this.document(draft.reviewId, draft.target.reviewVersion);
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
      if (draft.draftVersion !== 0)
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
          draft.draftVersion,
          draft.target.reviewVersion,
          canonicalHostJson(draft),
        );
      this.recordFeedbackSequence(
        "drafts",
        draft.id,
        draft.reviewId,
        draft.principalId,
      );
    } else {
      const before = this.draft(draft.reviewId, draft.id, draft.principalId);
      if (before.draftVersion !== expectedVersion)
        throw new HostStoreError(
          "VERSION_CONFLICT",
          "Draft changed. Refresh before saving.",
        );
      if (
        draft.draftVersion !== before.draftVersion + 1 ||
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
          draft.draftVersion,
          draft.target.reviewVersion,
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

  drafts(
    reviewId: string,
    principalId: string,
    maxSequence = Number.MAX_SAFE_INTEGER,
  ): HostDraft[] {
    this.review(reviewId);
    return this.db
      .prepare(
        "SELECT records.record_json FROM host_drafts records JOIN host_feedback_sequences seq ON seq.kind='drafts' AND seq.record_id=records.id WHERE records.review_id=? AND records.principal_id=? AND seq.sequence<=? ORDER BY seq.sequence DESC",
      )
      .all(reviewId, principalId, maxSequence)
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
    this.mutableResourceReview(reviewId);
    const before = this.draft(reviewId, id, principalId);
    if (before.draftVersion !== expectedVersion)
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
    this.document(thread.reviewId, thread.target.reviewVersion);
    if (thread.threadVersion !== 0)
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
        thread.target.reviewVersion,
        canonicalHostJson(thread),
      );
    this.recordFeedbackSequence("threads", thread.id, thread.reviewId);
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

  threads(
    reviewId: string,
    maxSequence = Number.MAX_SAFE_INTEGER,
  ): HostThread[] {
    this.review(reviewId);
    return this.db
      .prepare(
        "SELECT records.record_json FROM host_threads records JOIN host_feedback_sequences seq ON seq.kind='threads' AND seq.record_id=records.id WHERE records.review_id=? AND seq.sequence<=? ORDER BY seq.sequence DESC",
      )
      .all(reviewId, maxSequence)
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
    if (before.threadVersion !== expectedVersion)
      throw new HostStoreError(
        "VERSION_CONFLICT",
        "Thread changed. Refresh before changing its status.",
      );
    if (before.status === status) return before;
    const after = HostThreadSchema.parse({
      ...before,
      status,
      threadVersion: before.threadVersion + 1,
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
    this.document(submission.reviewId, submission.reviewVersion);
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
        "INSERT INTO host_feedback_submissions_v2(id,review_id,review_version,record_json) VALUES (?,?,?,?)",
      )
      .run(
        submission.id,
        submission.reviewId,
        submission.reviewVersion,
        canonicalHostJson(submission),
      );
    this.recordFeedbackSequence(
      "submissions",
      submission.id,
      submission.reviewId,
    );
    return submission;
  }

  submission(reviewId: string, id: string): HostFeedbackSubmission {
    const row = this.db
      .prepare(
        "SELECT record_json FROM host_feedback_submissions_v2 WHERE review_id=? AND id=?",
      )
      .get(reviewId, id);
    if (!row)
      throw new HostStoreError("NOT_FOUND", "Feedback submission not found.");
    return HostFeedbackSubmissionSchema.parse(
      parseJsonText(rowText(row, "record_json")),
    );
  }

  submissions(
    reviewId: string,
    maxSequence = Number.MAX_SAFE_INTEGER,
  ): HostFeedbackSubmission[] {
    this.review(reviewId);
    return this.db
      .prepare(
        "SELECT records.record_json FROM host_feedback_submissions_v2 records JOIN host_feedback_sequences seq ON seq.kind='submissions' AND seq.record_id=records.id WHERE records.review_id=? AND seq.sequence<=? ORDER BY seq.sequence DESC",
      )
      .all(reviewId, maxSequence)
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
    this.document(context.reviewId, context.reviewVersion);
    if (Buffer.byteLength(canonicalHostJson(context)) > 56 * 1024)
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
        context.reviewVersion,
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
      context.material.viewedTarget.threadId !== thread.id
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
    this.recordFeedbackSequence("questions", run.id, run.reviewId);
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

  questionRuns(
    reviewId: string,
    maxSequence = Number.MAX_SAFE_INTEGER,
  ): HostQuestionRun[] {
    this.review(reviewId);
    return this.db
      .prepare(
        "SELECT records.record_json FROM host_question_runs records JOIN host_feedback_sequences seq ON seq.kind='questions' AND seq.record_id=records.id WHERE records.review_id=? AND seq.sequence<=? ORDER BY seq.sequence DESC",
      )
      .all(reviewId, maxSequence)
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
          attentionVersion: 0,
          lastViewedReviewVersion: null,
          lastViewedAt: null,
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
    if (before.attentionVersion !== expectedVersion)
      throw new HostStoreError(
        "VERSION_CONFLICT",
        "Attention changed. Read its current version and retry.",
      );
    if (attention.attentionVersion !== before.attentionVersion + 1)
      throw new HostStoreError(
        "INVALID_STATE",
        "Attention must advance exactly one version.",
      );
    if (attention.lastViewedReviewVersion !== null)
      this.document(attention.reviewId, attention.lastViewedReviewVersion);
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

  reusedDocumentItems(
    reviewId: string,
    candidate: HostDocument,
  ): HostDocumentItemIdentity[] {
    const current = new Set(
      documentItemIdentities(this.document(reviewId)).map((item) => item.key),
    );
    const retained = new Set(
      this.db
        .prepare(
          "SELECT item_key FROM host_document_item_ids WHERE review_id=?",
        )
        .all(reviewId)
        .map((row) => rowText(row, "item_key")),
    );
    return documentItemIdentities(candidate).filter(
      (item) => !current.has(item.key) && retained.has(item.key),
    );
  }

  private rememberDocumentItemIds(
    reviewId: string,
    document: HostDocument,
  ): void {
    const insert = this.db.prepare(
      "INSERT OR IGNORE INTO host_document_item_ids(review_id,item_key) VALUES (?,?)",
    );
    for (const item of documentItemIdentities(document))
      insert.run(reviewId, item.key);
  }

  private migrateDocumentItemIds(): void {
    if (
      this.db
        .prepare(
          "SELECT value FROM host_meta WHERE key='diagram_item_ids_indexed'",
        )
        .get()
    )
      return;
    for (const row of this.db
      .prepare(
        "SELECT review_id,version FROM host_document_versions ORDER BY review_id,version",
      )
      .all()) {
      const reviewId = rowText(row, "review_id");
      this.rememberDocumentItemIds(
        reviewId,
        this.document(reviewId, Number(row.version)),
      );
    }
    this.db
      .prepare(
        "INSERT INTO host_meta(key,value) VALUES ('diagram_item_ids_indexed','1')",
      )
      .run();
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
    this.rememberDocumentItemIds(review.id, prepared.document);
    return {
      ...prepared.document,
      reviewId: review.id,
      reviewVersion: version,
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
