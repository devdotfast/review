import path from "node:path";

import type {
  ReviewAuthoringTarget,
  ReviewCommentDraftThreadMap,
  ReviewCommentThreadMap,
  ReviewThreadsCommit,
} from "@dev.fast/review-protocol";
import type { Spec } from "@json-render/core";

import {
  commitLiveReviewPage,
  initializeLiveReviewPage,
  readLiveReviewPage,
} from "../live-review-store";
import type {
  LiveReviewPage,
  StoredLiveReviewNode,
} from "../live-review-types";
import {
  readReviewCommentDrafts,
  readReviewComments,
} from "../review-state-store";
import { ReviewThreadsService } from "../review-threads-service";

export interface ReviewStateSnapshot {
  page: LiveReviewPage;
  authoringTarget: ReviewAuthoringTarget | null;
  threads: ReviewCommentThreadMap;
  drafts: ReviewCommentDraftThreadMap;
}

export type ReviewStateEvent =
  | { type: "state.snapshot"; state: ReviewStateSnapshot }
  | {
      type: "document.committed";
      version: number;
      updatedAt: string;
      upsertedNodes: StoredLiveReviewNode[];
      deletedNodeIds: string[];
      projection: {
        root: string;
        upsertedElements: Spec["elements"];
        deletedElementIds: string[];
      };
    }
  | {
      type: "authoring-target.changed";
      target: ReviewAuthoringTarget;
    }
  | {
      type: "threads.committed";
      commit: ReviewThreadsCommit;
    };

type ReviewStateListener = (event: ReviewStateEvent) => void;

/**
 * The single local authority for live Review state.
 *
 * SQLite commits happen before events. Events are disposable cache patches,
 * not an event log: a reconnect reads a fresh snapshot from SQLite.
 */
export class ReviewStateService {
  readonly #authoringTargets = new Map<string, ReviewAuthoringTarget>();
  readonly #listeners = new Map<string, Set<ReviewStateListener>>();
  readonly #threadServices = new Map<string, ReviewThreadsService>();

  readPage(reviewDir: string): LiveReviewPage | null {
    return readLiveReviewPage(reviewDir);
  }

  snapshot(reviewId: string, reviewDir: string): ReviewStateSnapshot {
    const page = this.readPage(reviewDir);
    if (!page || page.id !== reviewId) {
      throw new Error(`Live Review page is missing: ${reviewId}`);
    }
    return {
      page,
      authoringTarget: this.#authoringTargets.get(reviewId) ?? null,
      threads: readReviewComments(path.join(reviewDir, "review.mdx")),
      drafts: readReviewCommentDrafts(path.join(reviewDir, "review.mdx")),
    };
  }

  initialize(reviewDir: string, page: LiveReviewPage): void {
    initializeLiveReviewPage(reviewDir, page);
  }

  commitDocument(
    reviewId: string,
    reviewDir: string,
    previous: LiveReviewPage,
    next: LiveReviewPage,
  ): void {
    commitLiveReviewPage(reviewDir, next, previous.version);
    this.#emit(reviewId, documentDelta(previous, next));
  }

  selectAuthoringTarget(reviewId: string, target: ReviewAuthoringTarget): void {
    this.#authoringTargets.set(reviewId, target);
    this.#emit(reviewId, { type: "authoring-target.changed", target });
  }

  threads(
    reviewId: string,
    reviewPath: string,
    author: string,
  ): ReviewThreadsService {
    const existing = this.#threadServices.get(reviewId);
    if (existing) return existing;
    const service = new ReviewThreadsService({ reviewPath, author });
    service.subscribe((commit) =>
      this.#emit(reviewId, { type: "threads.committed", commit }),
    );
    this.#threadServices.set(reviewId, service);
    return service;
  }

  subscribe(reviewId: string, listener: ReviewStateListener): () => void {
    const listeners = this.#listeners.get(reviewId) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(reviewId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.#listeners.delete(reviewId);
    };
  }

  forget(reviewId: string): void {
    this.#authoringTargets.delete(reviewId);
    this.#threadServices.delete(reviewId);
  }

  #emit(reviewId: string, event: ReviewStateEvent): void {
    for (const listener of this.#listeners.get(reviewId) ?? []) listener(event);
  }
}

export const reviewStateService = new ReviewStateService();

function documentDelta(
  previous: LiveReviewPage,
  next: LiveReviewPage,
): Extract<ReviewStateEvent, { type: "document.committed" }> {
  const upsertedNodes = Object.values(next.nodes).filter(
    (node) => JSON.stringify(previous.nodes[node.id]) !== JSON.stringify(node),
  );
  const deletedNodeIds = Object.keys(previous.nodes).filter(
    (nodeId) => !(nodeId in next.nodes),
  );
  const upsertedElements = Object.fromEntries(
    Object.entries(next.projection.elements).filter(
      ([elementId, element]) =>
        JSON.stringify(previous.projection.elements[elementId]) !==
        JSON.stringify(element),
    ),
  );
  const deletedElementIds = Object.keys(previous.projection.elements).filter(
    (elementId) => !(elementId in next.projection.elements),
  );
  return {
    type: "document.committed",
    version: next.version,
    updatedAt: next.updatedAt,
    upsertedNodes,
    deletedNodeIds,
    projection: {
      root: next.projection.root,
      upsertedElements,
      deletedElementIds,
    },
  };
}
