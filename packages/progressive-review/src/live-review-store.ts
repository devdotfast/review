import { existsSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { validateSpec, type Spec } from "@json-render/core";
import { z } from "zod";

import { liveReviewCatalog } from "./live-review-catalog";
import type { LiveReviewPage } from "./live-review-types";

const nodeSchema = z.strictObject({
  id: z.string().min(1),
  title: z.string().min(1).optional(),
  source: z.string(),
  children: z.array(z.string().min(1)),
});

const projectionSchema = z.custom<Spec>((value) => {
  if (!value || typeof value !== "object") return false;
  const spec = value as Spec;
  return (
    liveReviewCatalog.validate(spec).success &&
    validateSpec(spec, { checkOrphans: true }).valid
  );
}, "Invalid live Review projection");

// z.object intentionally strips obsolete fields from the first tracer build.
// review.json owns lifecycle status; SQLite's version column owns the CAS.
const pageSchema = z
  .object({
    id: z.string().min(1),
    rootNodeId: z.string().min(1),
    nodes: z.record(z.string().min(1), nodeSchema),
    updatedAt: z.iso.datetime(),
    projection: projectionSchema,
  })
  .superRefine((page, context) => {
    if (!page.nodes[page.rootNodeId]) {
      context.addIssue({
        code: "custom",
        path: ["rootNodeId"],
        message: "Root node is missing",
      });
      return;
    }

    const visited = new Set<string>();
    const visiting = new Set<string>();
    const parentCounts = new Map<string, number>();
    const visit = (nodeId: string): void => {
      if (visiting.has(nodeId)) {
        context.addIssue({
          code: "custom",
          path: ["nodes", nodeId, "children"],
          message: "Review node tree contains a cycle",
        });
        return;
      }
      if (visited.has(nodeId)) return;
      const node = page.nodes[nodeId];
      if (!node) return;
      visiting.add(nodeId);
      visited.add(nodeId);
      if (node.id !== nodeId) {
        context.addIssue({
          code: "custom",
          path: ["nodes", nodeId, "id"],
          message: "Review node ID must match its adjacency-list key",
        });
      }
      if (new Set(node.children).size !== node.children.length) {
        context.addIssue({
          code: "custom",
          path: ["nodes", nodeId, "children"],
          message: "Review node children must be unique",
        });
      }
      for (const childId of node.children) {
        if (!page.nodes[childId]) {
          context.addIssue({
            code: "custom",
            path: ["nodes", nodeId, "children"],
            message: `Review child node is missing: ${childId}`,
          });
          continue;
        }
        const parentCount = (parentCounts.get(childId) ?? 0) + 1;
        parentCounts.set(childId, parentCount);
        if (parentCount > 1) {
          context.addIssue({
            code: "custom",
            path: ["nodes", childId],
            message: "Review node must have exactly one parent",
          });
        }
        visit(childId);
      }
      visiting.delete(nodeId);
    };
    visit(page.rootNodeId);
    for (const nodeId of Object.keys(page.nodes)) {
      if (!visited.has(nodeId)) {
        context.addIssue({
          code: "custom",
          path: ["nodes", nodeId],
          message: "Review node is not reachable from the root",
        });
      }
    }

    if (page.projection.root !== page.rootNodeId) {
      context.addIssue({
        code: "custom",
        path: ["projection", "root"],
        message: "Projection root must match the Review root node",
      });
    }
    for (const [nodeId, node] of Object.entries(page.nodes)) {
      const element = page.projection.elements[nodeId];
      if (element?.type !== "ReviewNode" || element.props.nodeId !== nodeId) {
        context.addIssue({
          code: "custom",
          path: ["projection", "elements", nodeId],
          message: "Projection is missing its Review node wrapper",
        });
        continue;
      }
      const structuralChildren = (element.children ?? []).filter(
        (childId) => childId in page.nodes,
      );
      if (
        structuralChildren.length !== node.children.length ||
        structuralChildren.some(
          (childId, index) => childId !== node.children[index],
        )
      ) {
        context.addIssue({
          code: "custom",
          path: ["projection", "elements", nodeId, "children"],
          message: "Projection children must match the authored node tree",
        });
      }
    }
    for (const [elementId, element] of Object.entries(
      page.projection.elements,
    )) {
      if (element.type === "ReviewNode" && !page.nodes[elementId]) {
        context.addIssue({
          code: "custom",
          path: ["projection", "elements", elementId],
          message: "Projection contains an unknown Review node wrapper",
        });
      }
    }
  });

const LIVE_REVIEW_DDL = `
CREATE TABLE IF NOT EXISTS live_review_page (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  page_json TEXT NOT NULL CHECK (json_valid(page_json)),
  version INTEGER NOT NULL CHECK (version >= 0)
) STRICT;
CREATE TABLE IF NOT EXISTS live_review_request (
  kind TEXT NOT NULL CHECK (kind IN ('create', 'render')),
  request_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  receipt_json TEXT NOT NULL CHECK (json_valid(receipt_json)),
  PRIMARY KEY (kind, request_id)
) STRICT;
`;

export interface LiveReviewRequestReceipt {
  kind: "create" | "render";
  requestId: string;
  requestHash: string;
  result: unknown;
}

export class LiveReviewVersionConflictError extends Error {
  override readonly name = "LiveReviewVersionConflictError";
}

export function hasLiveReviewPage(reviewDir: string): boolean {
  const dbPath = path.join(reviewDir, "review.db");
  if (!existsSync(dbPath)) return false;
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const table = db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'live_review_page'",
      )
      .get();
    if (!table) return false;
    return Boolean(
      db.prepare("SELECT 1 FROM live_review_page WHERE singleton = 1").get(),
    );
  } finally {
    db.close();
  }
}

export function readLiveReviewPage(reviewDir: string): LiveReviewPage | null {
  if (!hasLiveReviewPage(reviewDir)) return null;
  const db = new DatabaseSync(path.join(reviewDir, "review.db"), {
    readOnly: true,
  });
  try {
    const row = db
      .prepare(
        "SELECT page_json, version FROM live_review_page WHERE singleton = 1",
      )
      .get() as { page_json: string; version: number } | undefined;
    if (!row) return null;
    return {
      ...pageSchema.parse(JSON.parse(row.page_json)),
      version: row.version,
    };
  } finally {
    db.close();
  }
}

export function initializeLiveReviewPage(
  reviewDir: string,
  page: LiveReviewPage,
  receipt?: LiveReviewRequestReceipt,
): void {
  const parsed = storedPage(page);
  const db = openWritableLiveReviewDb(reviewDir);
  let inTransaction = false;
  try {
    db.exec("BEGIN IMMEDIATE");
    inTransaction = true;
    db.prepare(
      "INSERT INTO live_review_page (singleton, page_json, version) VALUES (1, ?, ?)",
    ).run(JSON.stringify(parsed), page.version);
    if (receipt) insertLiveReviewReceipt(db, receipt);
    db.exec("COMMIT");
    inTransaction = false;
  } catch (error) {
    if (inTransaction) db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }
}

export function commitLiveReviewPage(
  reviewDir: string,
  page: LiveReviewPage,
  expectedVersion: number,
  receipt?: LiveReviewRequestReceipt,
): void {
  if (page.version !== expectedVersion + 1) {
    throw new Error(
      "A live Review commit must increment its SQLite version once.",
    );
  }
  const parsed = storedPage(page);
  const db = openWritableLiveReviewDb(reviewDir);
  let inTransaction = false;
  try {
    db.exec("BEGIN IMMEDIATE");
    inTransaction = true;
    const result = db
      .prepare(
        "UPDATE live_review_page SET page_json = ?, version = ? WHERE singleton = 1 AND version = ?",
      )
      .run(JSON.stringify(parsed), page.version, expectedVersion);
    if (result.changes !== 1) {
      throw new LiveReviewVersionConflictError(
        "The Review page changed while the mutation was being validated.",
      );
    }
    if (receipt) insertLiveReviewReceipt(db, receipt);
    db.exec("COMMIT");
    inTransaction = false;
  } catch (error) {
    if (inTransaction) db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }
}

export function readLiveReviewReceipt(
  reviewDir: string,
  kind: LiveReviewRequestReceipt["kind"],
  requestId: string,
): LiveReviewRequestReceipt | null {
  const dbPath = path.join(reviewDir, "review.db");
  if (!existsSync(dbPath)) return null;
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const table = db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'live_review_request'",
      )
      .get();
    if (!table) return null;
    const row = db
      .prepare(
        "SELECT request_hash, receipt_json FROM live_review_request WHERE kind = ? AND request_id = ?",
      )
      .get(kind, requestId) as
      | { request_hash: string; receipt_json: string }
      | undefined;
    if (!row) return null;
    return {
      kind,
      requestId,
      requestHash: row.request_hash,
      result: JSON.parse(row.receipt_json),
    };
  } finally {
    db.close();
  }
}

export function commitLiveReviewReceipt(
  reviewDir: string,
  receipt: LiveReviewRequestReceipt,
): void {
  const db = openWritableLiveReviewDb(reviewDir);
  let inTransaction = false;
  try {
    db.exec("BEGIN IMMEDIATE");
    inTransaction = true;
    insertLiveReviewReceipt(db, receipt);
    db.exec("COMMIT");
    inTransaction = false;
  } catch (error) {
    if (inTransaction) db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }
}

function storedPage(page: LiveReviewPage): z.infer<typeof pageSchema> {
  const { version: _version, ...stored } = page;
  return pageSchema.parse(stored);
}

function openWritableLiveReviewDb(reviewDir: string): DatabaseSync {
  const db = new DatabaseSync(path.join(reviewDir, "review.db"));
  db.exec(
    "PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;",
  );
  db.exec(LIVE_REVIEW_DDL);
  return db;
}

function insertLiveReviewReceipt(
  db: DatabaseSync,
  receipt: LiveReviewRequestReceipt,
): void {
  const receiptJson = JSON.stringify(receipt.result);
  if (receiptJson === undefined) {
    throw new Error("A live Review request receipt must be JSON serializable.");
  }
  db.prepare(
    "INSERT INTO live_review_request (kind, request_id, request_hash, receipt_json) VALUES (?, ?, ?, ?)",
  ).run(receipt.kind, receipt.requestId, receipt.requestHash, receiptJson);
}
