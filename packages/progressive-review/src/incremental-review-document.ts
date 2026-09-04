import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  type ReviewDocumentMutationRequest,
  type ReviewDocumentMutationResponse,
  ReviewDocumentMutationResponseSchema,
  type ReviewDocumentNode,
  ReviewDocumentNodeSchema,
  type ReviewDocumentSnapshot,
  isJsonObject,
  parseJsonText,
} from "@dev.fast/review-protocol";

import { writeFileAtomicAsync } from "./atomic-write";
import type { StoredReview } from "./review-home";
import {
  commitReviewDocumentMutation,
  putReviewDocumentState,
  readReviewDocumentState,
  readReviewMutationReceipt,
} from "./review-state-db";

const INCREMENTAL_HEADER = "---\nreviewCanvas: incremental\nrevision: ";
const INCREMENTAL_HEADER_PATTERN =
  /^---\nreviewCanvas: incremental\nrevision: (\d+)\n(?:mutationId: ([A-Za-z0-9_-]+)\n)?---\n/u;
const NODE_PATTERN =
  /<ReviewNode data=\{(\{[^\n]+\})\}>\n([\s\S]*?)\n<\/ReviewNode>/gu;

export class ReviewDocumentApiError extends Error {
  override readonly name = "ReviewDocumentApiError";

  constructor(
    message: string,
    readonly statusCode: number,
    readonly code: string,
  ) {
    super(message);
  }
}

export interface ParsedIncrementalReviewDocument {
  revision: number;
  mutationId?: string;
  nodes: ReviewDocumentNode[];
}

export function parseIncrementalReviewDocument(
  source: string,
): ParsedIncrementalReviewDocument | null {
  const normalized = source.replace(/\r\n?/gu, "\n");
  const header = INCREMENTAL_HEADER_PATTERN.exec(normalized);
  if (!header) return null;
  const revision = Number(header[1]);
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new ReviewDocumentApiError(
      "The incremental Review revision is invalid.",
      422,
      "invalid_document",
    );
  }
  const body = normalized.slice(header[0].length);
  const nodes: ReviewDocumentNode[] = [];
  const ids = new Set<string>();
  let cursor = 0;
  for (const match of body.matchAll(NODE_PATTERN)) {
    const index = match.index;
    if (body.slice(cursor, index).trim()) {
      throw invalidDocument("Only top-level ReviewNode blocks are allowed.");
    }
    const metadata = parseJsonText(match[1]!);
    if (!isJsonObject(metadata)) {
      throw invalidDocument("Review node metadata must be an object.");
    }
    const parsed = ReviewDocumentNodeSchema.parse({
      ...metadata,
      content: match[2]!,
    });
    if (ids.has(parsed.id)) {
      throw invalidDocument(`Duplicate Review node ID: ${parsed.id}`);
    }
    ids.add(parsed.id);
    nodes.push(parsed);
    cursor = index + match[0].length;
  }
  if (body.slice(cursor).trim()) {
    throw invalidDocument("Only top-level ReviewNode blocks are allowed.");
  }
  const mutationId = header[2]
    ? Buffer.from(header[2], "base64url").toString("utf8")
    : undefined;
  return mutationId ? { revision, mutationId, nodes } : { revision, nodes };
}

export function serializeIncrementalReviewDocument(
  revision: number,
  nodes: readonly ReviewDocumentNode[],
  mutationId?: string,
): string {
  requireUniqueNodeIds(nodes);
  const blocks = nodes.map((node) => {
    if (node.content.includes("</ReviewNode>")) {
      throw invalidDocument(
        `Review node ${node.id} contains the reserved closing tag.`,
      );
    }
    const { content, ...metadata } = ReviewDocumentNodeSchema.parse(node);
    const data = JSON.stringify(metadata).replace(/</gu, "\\u003c");
    return `<ReviewNode data={${data}}>\n${content}\n</ReviewNode>`;
  });
  const mutationLine = mutationId
    ? `\nmutationId: ${Buffer.from(mutationId).toString("base64url")}`
    : "";
  return `${INCREMENTAL_HEADER}${revision}${mutationLine}\n---\n${blocks.join("\n\n")}${blocks.length ? "\n" : ""}`;
}

export async function readReviewDocumentSnapshot(
  review: StoredReview,
): Promise<ReviewDocumentSnapshot> {
  const routePath = "/";
  const documentPath = path.join(review.dir, "review.mdx");
  const source = await readFile(documentPath, "utf8");
  const sourceHash = hashSource(source);
  const parsed = parseIncrementalReviewDocument(source);
  const snapshot: ReviewDocumentSnapshot = parsed
    ? {
        reviewId: review.review.uuid,
        routePath,
        mode: "incremental",
        revision: parsed.revision,
        sourceHash,
        source,
        nodes: parsed.nodes,
      }
    : {
        reviewId: review.review.uuid,
        routePath,
        mode: "compiled",
        revision: 0,
        sourceHash,
        source,
        nodes: null,
      };
  const stored = readReviewDocumentState(review.dir, routePath);
  if (
    !stored ||
    stored.mode !== snapshot.mode ||
    stored.revision !== snapshot.revision ||
    stored.sourceHash !== sourceHash
  ) {
    putReviewDocumentState(review.dir, routePath, {
      mode: snapshot.mode,
      revision: snapshot.revision,
      sourceHash,
      projection: snapshot.nodes,
    });
  }
  return snapshot;
}

export async function mutateReviewDocument(
  review: StoredReview,
  request: ReviewDocumentMutationRequest,
): Promise<Extract<ReviewDocumentMutationResponse, { ok: true }>> {
  const priorReceipt = readReviewMutationReceipt(
    review.dir,
    request.mutationId,
  );
  if (priorReceipt) {
    const parsed = ReviewDocumentMutationResponseSchema.parse(priorReceipt);
    if (!parsed.ok) {
      throw new Error("Stored Review mutation receipt is not a success.");
    }
    return parsed;
  }
  const current = await readReviewDocumentSnapshot(review);
  const parsedCurrent = parseIncrementalReviewDocument(current.source);
  if (parsedCurrent?.mutationId === request.mutationId) {
    const recovered: Extract<ReviewDocumentMutationResponse, { ok: true }> = {
      ok: true,
      mutationId: request.mutationId,
      snapshot: current,
    };
    commitReviewDocumentMutation({
      reviewDir: review.dir,
      routePath: current.routePath,
      mutationId: request.mutationId,
      state: {
        mode: current.mode,
        revision: current.revision,
        sourceHash: current.sourceHash,
        projection: current.nodes,
      },
      response: recovered,
      createdAt: new Date().toISOString(),
    });
    return recovered;
  }
  if (request.expectedRevision !== current.revision) {
    throw new ReviewDocumentApiError(
      `Review document revision changed from ${request.expectedRevision} to ${current.revision}.`,
      409,
      "revision_conflict",
    );
  }
  if (
    request.expectedSourceHash !== undefined &&
    request.expectedSourceHash !== current.sourceHash
  ) {
    throw new ReviewDocumentApiError(
      "Review document source changed before the mutation was applied.",
      409,
      "source_conflict",
    );
  }
  if (current.mode === "compiled" && request.operation.type !== "replace") {
    throw new ReviewDocumentApiError(
      "A compiled Review must first be replaced with an incremental document.",
      409,
      "compiled_document",
    );
  }
  if (current.mode === "compiled" && request.expectedSourceHash === undefined) {
    throw new ReviewDocumentApiError(
      "Replacing a compiled Review requires expectedSourceHash.",
      409,
      "source_hash_required",
    );
  }
  const nodes = applyReviewDocumentOperation(
    current.nodes ?? [],
    request.operation,
  );
  const revision = current.revision + 1;
  const source = serializeIncrementalReviewDocument(
    revision,
    nodes,
    request.mutationId,
  );
  const sourceHash = hashSource(source);
  const snapshot: ReviewDocumentSnapshot = {
    reviewId: review.review.uuid,
    routePath: "/",
    mode: "incremental",
    revision,
    sourceHash,
    source,
    nodes,
  };
  const response: Extract<ReviewDocumentMutationResponse, { ok: true }> = {
    ok: true,
    mutationId: request.mutationId,
    snapshot,
  };
  await writeFileAtomicAsync(path.join(review.dir, "review.mdx"), source, {
    encoding: "utf8",
    mode: 0o600,
  });
  commitReviewDocumentMutation({
    reviewDir: review.dir,
    routePath: "/",
    mutationId: request.mutationId,
    state: {
      mode: "incremental",
      revision,
      sourceHash,
      projection: nodes,
    },
    response,
    createdAt: new Date().toISOString(),
  });
  return response;
}

function applyReviewDocumentOperation(
  current: readonly ReviewDocumentNode[],
  operation: ReviewDocumentMutationRequest["operation"],
): ReviewDocumentNode[] {
  if (operation.type === "replace") {
    requireUniqueNodeIds(operation.nodes);
    return operation.nodes.map((node) => ({ ...node }));
  }
  const nodes = current.map((node) => ({ ...node }));
  if (operation.type === "insert") {
    if (nodes.some((node) => node.id === operation.node.id)) {
      throw invalidMutation(`Review node already exists: ${operation.node.id}`);
    }
    if (operation.index > nodes.length) {
      throw invalidMutation("Insert index is past the end of the document.");
    }
    nodes.splice(operation.index, 0, { ...operation.node });
    return nodes;
  }
  const index = nodes.findIndex((node) => node.id === operation.nodeId);
  if (index < 0) {
    throw new ReviewDocumentApiError(
      `Review node not found: ${operation.nodeId}`,
      404,
      "node_not_found",
    );
  }
  if (operation.type === "delete") {
    nodes.splice(index, 1);
    return nodes;
  }
  if (operation.type === "move") {
    const [node] = nodes.splice(index, 1);
    if (operation.index > nodes.length) {
      throw invalidMutation("Move index is past the end of the document.");
    }
    nodes.splice(operation.index, 0, node!);
    return nodes;
  }
  const patch = operation.patch;
  const next: ReviewDocumentNode = { ...nodes[index]! };
  if (patch.kind !== undefined) next.kind = patch.kind;
  if (patch.content !== undefined) next.content = patch.content;
  if (patch.title === null) delete next.title;
  else if (patch.title !== undefined) next.title = patch.title;
  if (patch.tone === null) delete next.tone;
  else if (patch.tone !== undefined) next.tone = patch.tone;
  if (patch.language === null) delete next.language;
  else if (patch.language !== undefined) next.language = patch.language;
  nodes[index] = ReviewDocumentNodeSchema.parse(next);
  return nodes;
}

function requireUniqueNodeIds(nodes: readonly ReviewDocumentNode[]): void {
  const ids = new Set<string>();
  for (const node of nodes) {
    ReviewDocumentNodeSchema.parse(node);
    if (ids.has(node.id)) {
      throw invalidMutation(`Duplicate Review node ID: ${node.id}`);
    }
    ids.add(node.id);
  }
}

function hashSource(source: string): string {
  return crypto.createHash("sha256").update(source).digest("hex");
}

function invalidDocument(message: string): ReviewDocumentApiError {
  return new ReviewDocumentApiError(message, 422, "invalid_document");
}

function invalidMutation(message: string): ReviewDocumentApiError {
  return new ReviewDocumentApiError(message, 422, "invalid_mutation");
}
