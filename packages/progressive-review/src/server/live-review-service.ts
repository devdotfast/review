import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";

import { currentHead } from "@dev.fast/local-vcs";
import type { ReviewAuthoringTarget } from "@dev.fast/review-protocol";

import { type SessionRef, authoringSessionKey } from "../authoring-session";
import { parentIdForNode, projectLiveReviewPage } from "../live-review-mdx";
import type {
  BasicInfo,
  LiveReviewPage,
  Node,
  RenderResult,
  ReviewBinding,
  ReviewSummary,
} from "../live-review-types";
import { type StoredReview, computeSync } from "../review-home";
import { resolveReviewRoot } from "../runtime";
import { reviewStateService } from "./review-state-service";

export class LiveReviewTerminalError extends Error {
  override readonly name = "LiveReviewTerminalError";
}

export interface LiveReviewCreateOutcome {
  review: StoredReview;
  info: BasicInfo;
}

export function requireLiveReviewPage(review: StoredReview): LiveReviewPage {
  const page = reviewStateService.readPage(review.dir);
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
  const listed = await reviewStateService.list(
    input.scope === "current-checkout" ? { worktreePath: reviewRoot } : {},
  );
  if (listed.errors.length > 0) {
    throw new Error(
      `Could not read Reviews: ${listed.errors.map((error) => error.message).join("; ")}`,
    );
  }
  const summaries: ReviewSummary[] = [];
  for (const review of listed.reviews) {
    const page = reviewStateService.readPage(review.dir);
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
  agent?: SessionRef;
}): Promise<LiveReviewCreateOutcome> {
  const title = input.title.trim();
  if (!title) throw new Error("Review title must not be empty.");
  const reviewRoot = await resolveReviewRoot(path.resolve(input.cwd));
  const head = await currentHead(reviewRoot);
  if (!head)
    throw new Error(`Could not resolve the checkout at ${reviewRoot}.`);
  const review = await reviewStateService.create({
    worktreePath: reviewRoot,
    baseRef: head.commit,
    baseCommit: head.commit,
    sourceCommit: head.commit,
    title,
    ...(input.agent ? { sourceSession: authoringSessionKey(input.agent) } : {}),
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
    reviewStateService.initialize(review.dir, page);
    const active = await reviewStateService.setStatus(
      review,
      "awaiting-agent-updates",
    );
    return { review: active, info };
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
  targetNodeId: string;
  mode: "append" | "replace";
  title?: string;
  mdx: string;
}): Promise<RenderResult> {
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
    return {
      ok: false,
      reviewId: input.review.review.uuid,
      targetNodeId: input.targetNodeId,
      diagnostics,
    };
  }
  const result: RenderResult = {
    ok: true,
    reviewId: input.review.review.uuid,
    targetNodeId: input.targetNodeId,
    nodeId,
    version: next.version,
  };
  reviewStateService.commitDocument(
    input.review.review.uuid,
    input.review.dir,
    page,
    next,
  );
  return result;
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
  return reviewStateService.setStatus(review, "awaiting-review");
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
