import { randomUUID } from "node:crypto";
import path from "node:path";

import { currentHead } from "@dev.fast/local-vcs";

import {
  readHealthyReviewDesktopDiscovery,
  type ReviewDesktopHealthDependencies,
} from "./desktop-discovery";
import { projectLiveReviewPage, parentIdForNode } from "./live-review-mdx";
import {
  commitLiveReviewPage,
  initializeLiveReviewPage,
  readLiveReviewPage,
} from "./live-review-store";
import type {
  BasicInfo,
  LiveReviewPage,
  LiveReviewStatus,
  Node,
  RenderResult,
  ReviewAPI,
  ReviewBinding,
  ReviewSummary,
  Selection,
} from "./live-review-types";
import { runReviewAppLaunch } from "./review-app-launcher";
import {
  computeSync,
  createReviewDir,
  findReview,
  listReviews as listStoredReviews,
  type StoredReview,
} from "./review-home";
export type {
  BasicInfo,
  LiveReviewStatus,
  Node,
  RenderResult,
  ReviewAPI,
  ReviewBinding,
  ReviewSummary,
  Selection,
} from "./live-review-types";
import { resolveReviewRoot } from "./runtime";
import { writePrivateJsonAtomic } from "./server/desktop-paths";

interface LiveReviewApiDependencies extends ReviewDesktopHealthDependencies {
  launchDesktop?: typeof runReviewAppLaunch;
  now?: () => Date;
  focusReview?: (review: StoredReview) => Promise<void>;
  notifyPageUpdated?: (reviewId: string) => Promise<void>;
}

export function createReviewApi(
  input: { cwd: string },
  dependencies: LiveReviewApiDependencies = {},
): ReviewAPI {
  const cwd = path.resolve(input.cwd);
  const now = dependencies.now ?? (() => new Date());
  let defaultReviewId: string | undefined;

  const requireReview = async (reviewId?: string): Promise<StoredReview> => {
    const resolvedId = reviewId ?? defaultReviewId;
    if (!resolvedId) {
      throw new Error("reviewId is required until a Review has been opened.");
    }
    const review = await findReview(resolvedId);
    if (!review || !readLiveReviewPage(review.dir)) {
      throw new Error(`Live Review not found: ${resolvedId}`);
    }
    return review;
  };

  const readPage = (review: StoredReview): LiveReviewPage => {
    const page = readLiveReviewPage(review.dir);
    if (!page)
      throw new Error(`Live Review page is missing: ${review.review.uuid}`);
    return page;
  };

  const info = (review: StoredReview, page: LiveReviewPage): BasicInfo => ({
    reviewId: page.id,
    title: page.nodes[page.rootNodeId]?.title ?? review.review.title,
    status: page.status,
    rootNodeId: page.rootNodeId,
    nodeCount: Object.keys(page.nodes).length,
    binding: bindingFor(review),
  });

  const notifyPageUpdated = async (reviewId: string): Promise<void> => {
    if (dependencies.notifyPageUpdated) {
      await dependencies.notifyPageUpdated(reviewId);
      return;
    }
    const discovery = await readHealthyReviewDesktopDiscovery(dependencies);
    if (!discovery) return;
    await (dependencies.fetch ?? globalThis.fetch)(
      `${discovery.url}/reviews/${encodeURIComponent(reviewId)}/page-updated`,
      {
        method: "POST",
        headers: { "x-review-token": discovery.token },
      },
    ).catch(() => undefined);
  };

  const focusReview = async (review: StoredReview): Promise<void> => {
    if (dependencies.focusReview) {
      await dependencies.focusReview(review);
      return;
    }
    await (dependencies.launchDesktop ?? runReviewAppLaunch)();
    const discovery = await readHealthyReviewDesktopDiscovery(dependencies);
    if (!discovery) throw new Error("Review Desktop is not ready.");
    const response = await (dependencies.fetch ?? globalThis.fetch)(
      `${discovery.url}/reviews/${encodeURIComponent(review.review.uuid)}/open`,
      {
        method: "POST",
        headers: { "x-review-token": discovery.token },
      },
    );
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as {
        error?: unknown;
      } | null;
      throw new Error(
        typeof payload?.error === "string"
          ? payload.error
          : `Review Desktop returned ${response.status}.`,
      );
    }
  };

  return {
    async listReviews(listInput = {}) {
      const reviewRoot = await resolveReviewRoot(cwd);
      const listed = await listStoredReviews(
        listInput.scope === "current-checkout"
          ? { worktreePath: reviewRoot }
          : {},
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
          status: page.status,
          updatedAt: page.updatedAt,
          binding: bindingFor(review),
          matchesCheckout: await computeSync(review.review, reviewRoot),
        });
      }
      return summaries.sort((left, right) =>
        right.updatedAt.localeCompare(left.updatedAt),
      );
    },

    async createReview(createInput) {
      if (createInput.source.kind !== "current-checkout") {
        throw new Error("Only current-checkout sources are supported.");
      }
      const title = createInput.title.trim();
      if (!title) throw new Error("Review title must not be empty.");
      const reviewRoot = await resolveReviewRoot(cwd);
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
        status: "awaiting-agent" as const,
        presentedVersionId: null,
        version: 0,
        updatedAt: now().toISOString(),
      };
      const projection = await projectLiveReviewPage({
        page: pageWithoutProjection,
        reviewRootPath: review.dir,
      });
      const page: LiveReviewPage = { ...pageWithoutProjection, projection };
      initializeLiveReviewPage(review.dir, page);
      const activeReview: StoredReview = {
        ...review,
        review: { ...review.review, status: "awaiting-agent-updates" },
      };
      await writePrivateJsonAtomic(
        path.join(review.dir, "review.json"),
        activeReview.review,
      );
      defaultReviewId = review.review.uuid;
      await focusReview(activeReview);
      return info(activeReview, page);
    },

    async openReview({ reviewId }) {
      const review = await requireReview(reviewId);
      await focusReview(review);
      defaultReviewId = reviewId;
      return info(review, readPage(review));
    },

    async getBasicInfo(infoInput = {}) {
      const review = await requireReview(infoInput.reviewId);
      return info(review, readPage(review));
    },

    async getSelection(selectionInput = {}): Promise<Selection> {
      const review = await requireReview(selectionInput.reviewId);
      return { reviewId: review.review.uuid, nodeIds: [] };
    },

    async getNodeInfo({ reviewId, nodeId }) {
      const review = await requireReview(reviewId);
      return publicNode(readPage(review), nodeId);
    },

    async getChildren({ reviewId, nodeId }) {
      const review = await requireReview(reviewId);
      const page = readPage(review);
      const node = publicNode(page, nodeId);
      return node.childIds.map((childId) => publicNode(page, childId));
    },

    async renderMdx(renderInput): Promise<RenderResult> {
      const review = await requireReview(renderInput.reviewId);
      const page = readPage(review);
      const target = page.nodes[renderInput.targetNodeId];
      if (!target) {
        throw new Error(`Review node not found: ${renderInput.targetNodeId}`);
      }
      const next = structuredClone(page);
      const nodeId =
        renderInput.mode === "append" ? randomUUID() : renderInput.targetNodeId;
      if (renderInput.mode === "append") {
        next.nodes[nodeId] = {
          id: nodeId,
          ...(renderInput.title?.trim()
            ? { title: renderInput.title.trim() }
            : {}),
          source: renderInput.mdx,
          children: [],
        };
        next.nodes[renderInput.targetNodeId]!.children.push(nodeId);
      } else {
        next.nodes[nodeId] = {
          ...next.nodes[nodeId]!,
          ...(renderInput.title?.trim()
            ? { title: renderInput.title.trim() }
            : {}),
          source: renderInput.mdx,
        };
      }
      next.version = page.version + 1;
      next.updatedAt = now().toISOString();
      try {
        next.projection = await projectLiveReviewPage({
          page: next,
          reviewRootPath: review.dir,
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
                  path: renderInput.targetNodeId,
                  message:
                    error instanceof Error ? error.message : String(error),
                },
              ];
        return {
          ok: false,
          reviewId: review.review.uuid,
          targetNodeId: renderInput.targetNodeId,
          diagnostics,
        };
      }
      commitLiveReviewPage(review.dir, next, page.version);
      if (
        renderInput.mode === "replace" &&
        nodeId === page.rootNodeId &&
        renderInput.title?.trim()
      ) {
        await writePrivateJsonAtomic(path.join(review.dir, "review.json"), {
          ...review.review,
          title: renderInput.title.trim(),
        });
      }
      await notifyPageUpdated(review.review.uuid);
      return {
        ok: true,
        reviewId: review.review.uuid,
        targetNodeId: renderInput.targetNodeId,
        nodeId,
        version: next.version,
      };
    },

    async setReviewStatus(statusInput) {
      const review = await requireReview(statusInput.reviewId);
      const page = readPage(review);
      const next: LiveReviewPage = {
        ...page,
        status: statusInput.status,
        version: page.version + 1,
        updatedAt: now().toISOString(),
      };
      commitLiveReviewPage(review.dir, next, page.version);
      await writePrivateJsonAtomic(path.join(review.dir, "review.json"), {
        ...review.review,
        status: storedStatus(statusInput.status),
      });
      await notifyPageUpdated(review.review.uuid);
      return info(
        {
          ...review,
          review: {
            ...review.review,
            status: storedStatus(statusInput.status),
          },
        },
        next,
      );
    },
  };
}

function publicNode(page: LiveReviewPage, nodeId: string): Node {
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

function storedStatus(
  status: LiveReviewStatus,
): StoredReview["review"]["status"] {
  return status === "awaiting-agent" ? "awaiting-agent-updates" : status;
}
