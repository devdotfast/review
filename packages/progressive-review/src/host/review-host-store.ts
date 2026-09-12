import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";

import {
  type HostBinding,
  HostBindingSchema,
  HostDefinitionSchema,
  type HostDocument,
  type HostDocumentManifest,
  HostDocumentManifestSchema,
  type HostDocumentState,
  HostDocumentStateSchema,
  HostNodeSchema,
  type HostReview,
  HostReviewSchema,
  type HostSourceQuote,
  HostSourceQuoteSchema,
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
    if (!metadata) return;
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
