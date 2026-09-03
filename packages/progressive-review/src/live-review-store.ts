import { existsSync } from "node:fs";

import { validateSpec, type Spec } from "@json-render/core";
import { z } from "zod";

import { liveReviewCatalog } from "./live-review-catalog";
import type { LiveReviewPage } from "./live-review-types";
import {
  importLegacyReview,
  openReviewStateDbForDir,
  reviewIdForDir,
  reviewStateDbPathForDir,
} from "./review-state-db";

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
// The reviews row owns lifecycle status; this row's version owns the CAS.
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

export class LiveReviewVersionConflictError extends Error {
  override readonly name = "LiveReviewVersionConflictError";
}

export function hasLiveReviewPage(reviewDir: string): boolean {
  if (!existsSync(reviewStateDbPathForDir(reviewDir))) return false;
  importLegacyReview(reviewDir);
  return Boolean(
    openReviewStateDbForDir(reviewDir)
      .prepare("SELECT 1 FROM live_review_pages WHERE review_id = ?")
      .get(reviewIdForDir(reviewDir)),
  );
}

export function readLiveReviewPage(reviewDir: string): LiveReviewPage | null {
  if (!hasLiveReviewPage(reviewDir)) return null;
  const row = openReviewStateDbForDir(reviewDir)
    .prepare(
      "SELECT page_json, version FROM live_review_pages WHERE review_id = ?",
    )
    .get(reviewIdForDir(reviewDir)) as
    | { page_json: string; version: number }
    | undefined;
  if (!row) return null;
  return {
    ...pageSchema.parse(JSON.parse(row.page_json)),
    version: row.version,
  };
}

export function initializeLiveReviewPage(
  reviewDir: string,
  page: LiveReviewPage,
): void {
  const parsed = storedPage(page);
  const db = openWritableLiveReviewDb(reviewDir);
  const reviewId = reviewIdForDir(reviewDir);
  let inTransaction = false;
  try {
    db.exec("BEGIN IMMEDIATE");
    inTransaction = true;
    db.prepare(
      "INSERT INTO live_review_pages (review_id, page_json, version) VALUES (?, ?, ?)",
    ).run(reviewId, JSON.stringify(parsed), page.version);
    db.exec("COMMIT");
    inTransaction = false;
  } catch (error) {
    if (inTransaction) db.exec("ROLLBACK");
    throw error;
  } finally {
    // The process-wide state database remains open for all review domains.
  }
}

export function commitLiveReviewPage(
  reviewDir: string,
  page: LiveReviewPage,
  expectedVersion: number,
): void {
  if (page.version !== expectedVersion + 1) {
    throw new Error(
      "A live Review commit must increment its SQLite version once.",
    );
  }
  const parsed = storedPage(page);
  const db = openWritableLiveReviewDb(reviewDir);
  const reviewId = reviewIdForDir(reviewDir);
  let inTransaction = false;
  try {
    db.exec("BEGIN IMMEDIATE");
    inTransaction = true;
    const result = db
      .prepare(
        "UPDATE live_review_pages SET page_json = ?, version = ? WHERE review_id = ? AND version = ?",
      )
      .run(JSON.stringify(parsed), page.version, reviewId, expectedVersion);
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
    // The process-wide state database remains open for all review domains.
  }
}

function storedPage(page: LiveReviewPage): z.infer<typeof pageSchema> {
  const { version: _version, ...stored } = page;
  return pageSchema.parse(stored);
}

function openWritableLiveReviewDb(reviewDir: string) {
  importLegacyReview(reviewDir);
  return openReviewStateDbForDir(reviewDir);
}
