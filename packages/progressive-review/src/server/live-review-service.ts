import { createHash, randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";

import { currentHead } from "@dev.fast/local-vcs";
import type { ReviewAuthoringTarget } from "@dev.fast/review-protocol";

import { projectLiveReviewPage, parentIdForNode } from "../live-review-mdx";
import {
  commitLiveReviewPage,
  commitLiveReviewReceipt,
  initializeLiveReviewPage,
  readLiveReviewPage,
  readLiveReviewReceipt,
  type LiveReviewRequestReceipt,
} from "../live-review-store";
import {
  parseLiveReviewBasicInfo,
  parseLiveReviewRenderResult,
} from "../live-review-transport";
import type {
  BasicInfo,
  LiveReviewPage,
  Node,
  RenderResult,
  ReviewBinding,
  ReviewSummary,
} from "../live-review-types";
import {
  computeSync,
  createReviewDir,
  listReviews,
  type StoredReview,
} from "../review-home";
import { resolveReviewRoot } from "../runtime";
import { writePrivateJsonAtomic } from "./desktop-paths";

export class LiveReviewTerminalError extends Error {
  override readonly name = "LiveReviewTerminalError";
}

export class LiveReviewRequestConflictError extends Error {
  override readonly name = "LiveReviewRequestConflictError";
}

export interface LiveReviewCreateOutcome {
  review: StoredReview;
  info: BasicInfo;
  replayed: boolean;
}

export interface LiveReviewRenderOutcome {
  result: RenderResult;
  replayed: boolean;
}

export function requireLiveReviewPage(review: StoredReview): LiveReviewPage {
  const page = readLiveReviewPage(review.dir);
  if (!page || page.id !== review.review.uuid) {
    throw new Error(`Live Review page is missing: ${review.review.uuid}`);
  }
  return page;
}

export function liveReviewInfo(
  review: StoredReview,
  page = requireLiveReviewPage(review),
): BasicInfo {
  return {
    reviewId: page.id,
    title: page.nodes[page.rootNodeId]?.title ?? review.review.title,
    status: liveStatusForStored(review.review.status),
    rootNodeId: page.rootNodeId,
    nodeCount: Object.keys(page.nodes).length,
    binding: bindingFor(review),
  };
}

export async function listLiveReviews(input: {
  cwd: string;
  scope?: "current-checkout" | "all";
}): Promise<ReviewSummary[]> {
  const reviewRoot = await resolveReviewRoot(path.resolve(input.cwd));
  const listed = await listReviews(
    input.scope === "current-checkout" ? { worktreePath: reviewRoot } : {},
  );
  if (listed.errors.length > 0) {
    throw new Error(
      `Could not read Reviews: ${listed.errors.map((error) => error.message).join("; ")}`,
    );
  }
  const summaries: ReviewSummary[] = [];
  for (const review of listed.reviews) {
    const page = readLiveReviewPage(review.dir);
    if (!page) continue;
    summaries.push({
      id: page.id,
      title: page.nodes[page.rootNodeId]?.title ?? review.review.title,
      status: liveStatusForStored(review.review.status),
      updatedAt: page.updatedAt,
      binding: bindingFor(review),
      matchesCheckout: await computeSync(review.review, reviewRoot),
    });
  }
  return summaries.sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt),
  );
}

export async function createLiveReview(input: {
  cwd: string;
  title: string;
  requestId: string;
}): Promise<LiveReviewCreateOutcome> {
  const title = input.title.trim();
  if (!title) throw new Error("Review title must not be empty.");
  const requestHash = liveReviewRequestHash({
    cwd: path.resolve(input.cwd),
    source: { kind: "current-checkout" },
    title,
  });
  const replayed = await findCreateReceipt(input.requestId, requestHash);
  if (replayed) return { ...replayed, replayed: true };
  const reviewRoot = await resolveReviewRoot(path.resolve(input.cwd));
  const head = await currentHead(reviewRoot);
  if (!head)
    throw new Error(`Could not resolve the checkout at ${reviewRoot}.`);
  const review = await createReviewDir({
    worktreePath: reviewRoot,
    baseRef: head.commit,
    baseCommit: head.commit,
    sourceCommit: head.commit,
    title,
  });
  try {
    const rootNodeId = "root";
    const pageWithoutProjection = {
      id: review.review.uuid,
      rootNodeId,
      nodes: {
        [rootNodeId]: {
          id: rootNodeId,
          title,
          source: "",
          children: [],
        },
      },
      version: 0,
      updatedAt: new Date().toISOString(),
    };
    const projection = await projectLiveReviewPage({
      page: pageWithoutProjection,
      reviewRootPath: review.dir,
    });
    const page: LiveReviewPage = { ...pageWithoutProjection, projection };
    const info = liveReviewInfo(review, page);
    initializeLiveReviewPage(review.dir, page, {
      kind: "create",
      requestId: input.requestId,
      requestHash,
      result: info,
    });
    const active = await setLiveReviewStatus(review, "awaiting-agent-updates");
    return { review: active, info, replayed: false };
  } catch (error) {
    await rm(review.dir, { recursive: true, force: true });
    throw error;
  }
}

export function liveReviewNode(page: LiveReviewPage, nodeId: string): Node {
  const node = page.nodes[nodeId];
  if (!node) throw new Error(`Review node not found: ${nodeId}`);
  return {
    id: node.id,
    parentId: parentIdForNode(page.nodes, node.id),
    ...(node.title ? { title: node.title } : {}),
    source: node.source,
    childIds: [...node.children],
  };
}

export function liveReviewAuthoringTarget(
  page: LiveReviewPage,
  targetNodeId: string,
): ReviewAuthoringTarget {
  if (!page.nodes[targetNodeId]) {
    throw new Error(`Review node not found: ${targetNodeId}`);
  }
  let sectionNodeId: string | null = null;
  let currentNodeId = targetNodeId;
  while (currentNodeId !== page.rootNodeId) {
    const parentId = parentIdForNode(page.nodes, currentNodeId);
    if (parentId === page.rootNodeId) {
      sectionNodeId = currentNodeId;
      break;
    }
    if (!parentId) break;
    currentNodeId = parentId;
  }
  return { targetNodeId, sectionNodeId };
}

export async function renderLiveReviewMdx(input: {
  review: StoredReview;
  requestId: string;
  targetNodeId: string;
  mode: "append" | "replace";
  title?: string;
  mdx: string;
}): Promise<LiveReviewRenderOutcome> {
  const requestHash = liveReviewRequestHash({
    targetNodeId: input.targetNodeId,
    mode: input.mode,
    title: input.title ?? null,
    mdx: input.mdx,
  });
  const storedReceipt = readLiveReviewReceipt(
    input.review.dir,
    "render",
    input.requestId,
  );
  if (storedReceipt) {
    assertReceiptHash(storedReceipt, requestHash);
    return {
      result: parseLiveReviewRenderResult(storedReceipt.result),
      replayed: true,
    };
  }
  const page = requireLiveReviewPage(input.review);
  if (!page.nodes[input.targetNodeId]) {
    throw new Error(`Review node not found: ${input.targetNodeId}`);
  }
  const next = structuredClone(page);
  const nodeId = input.mode === "append" ? randomUUID() : input.targetNodeId;
  if (input.mode === "append") {
    next.nodes[nodeId] = {
      id: nodeId,
      ...(input.title?.trim() ? { title: input.title.trim() } : {}),
      source: input.mdx,
      children: [],
    };
    next.nodes[input.targetNodeId]!.children.push(nodeId);
  } else {
    next.nodes[nodeId] = {
      ...next.nodes[nodeId]!,
      ...(input.title?.trim() ? { title: input.title.trim() } : {}),
      source: input.mdx,
    };
  }
  next.version = page.version + 1;
  next.updatedAt = new Date().toISOString();
  try {
    next.projection = await projectLiveReviewPage({
      page: next,
      reviewRootPath: input.review.dir,
    });
  } catch (error) {
    const diagnostics =
      error &&
      typeof error === "object" &&
      "diagnostics" in error &&
      Array.isArray(error.diagnostics)
        ? error.diagnostics
        : [
            {
              path: input.targetNodeId,
              message: error instanceof Error ? error.message : String(error),
            },
          ];
    const result: RenderResult = {
      ok: false,
      reviewId: input.review.review.uuid,
      targetNodeId: input.targetNodeId,
      diagnostics,
    };
    commitLiveReviewReceipt(
      input.review.dir,
      renderReceipt(input.requestId, requestHash, result),
    );
    return { result, replayed: false };
  }
  const result: RenderResult = {
    ok: true,
    reviewId: input.review.review.uuid,
    targetNodeId: input.targetNodeId,
    nodeId,
    version: next.version,
  };
  commitLiveReviewPage(
    input.review.dir,
    next,
    page.version,
    renderReceipt(input.requestId, requestHash, result),
  );
  return { result, replayed: false };
}

export async function handoffLiveReview(
  review: StoredReview,
): Promise<StoredReview> {
  if (
    review.review.status === "accepted" ||
    review.review.status === "rejected"
  ) {
    throw new LiveReviewTerminalError(
      "A terminal Review cannot change lifecycle status.",
    );
  }
  return setLiveReviewStatus(review, "awaiting-review");
}

async function setLiveReviewStatus(
  review: StoredReview,
  status: StoredReview["review"]["status"],
): Promise<StoredReview> {
  const next = { ...review.review, status };
  await writePrivateJsonAtomic(path.join(review.dir, "review.json"), next);
  return { ...review, review: next };
}

async function findCreateReceipt(
  requestId: string,
  requestHash: string,
): Promise<{
  review: StoredReview;
  info: BasicInfo;
} | null> {
  const listed = await listReviews();
  if (listed.errors.length > 0) {
    throw new Error(
      `Could not inspect Review create receipts: ${listed.errors
        .map((error) => error.message)
        .join("; ")}`,
    );
  }
  let match: {
    review: StoredReview;
    info: BasicInfo;
  } | null = null;
  for (const review of listed.reviews) {
    const receipt = readLiveReviewReceipt(review.dir, "create", requestId);
    if (!receipt) continue;
    assertReceiptHash(receipt, requestHash);
    const info = parseLiveReviewBasicInfo(receipt.result);
    if (info.reviewId !== review.review.uuid) {
      throw new Error(`Invalid live Review create receipt: ${requestId}`);
    }
    requireLiveReviewPage(review);
    const active =
      review.review.status === "draft"
        ? await setLiveReviewStatus(review, "awaiting-agent-updates")
        : review;
    if (match && match.review.review.uuid !== active.review.uuid) {
      throw new Error(`Duplicate live Review create receipt: ${requestId}`);
    }
    match = { review: active, info };
  }
  return match;
}

function renderReceipt(
  requestId: string,
  requestHash: string,
  result: RenderResult,
): LiveReviewRequestReceipt {
  return { kind: "render", requestId, requestHash, result };
}

function assertReceiptHash(
  receipt: LiveReviewRequestReceipt,
  requestHash: string,
): void {
  if (receipt.requestHash === requestHash) return;
  throw new LiveReviewRequestConflictError(
    `Review request ${receipt.requestId} was already used with different input.`,
  );
}

function liveReviewRequestHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function bindingFor(review: StoredReview): ReviewBinding {
  const sourceCommit = review.review.sourceCommit;
  if (!sourceCommit)
    throw new Error(`Review ${review.review.uuid} is unbound.`);
  return {
    kind: "current-checkout",
    worktreePath: review.review.worktreePath,
    baseCommit: review.review.baseCommit,
    sourceCommit,
  };
}

function liveStatusForStored(
  status: StoredReview["review"]["status"],
): BasicInfo["status"] {
  if (status === "draft" || status === "awaiting-agent-updates") {
    return "awaiting-agent";
  }
  return status;
}
