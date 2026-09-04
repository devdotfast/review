import type { Spec } from "@json-render/core";

export type LiveReviewStatus =
  | "awaiting-agent"
  | "awaiting-review"
  | "accepted"
  | "rejected";

export interface ReviewBinding {
  kind: "current-checkout";
  worktreePath: string;
  baseCommit: string;
  sourceCommit: string;
}

export interface ReviewSummary {
  id: string;
  title: string;
  status: LiveReviewStatus;
  updatedAt: string;
  binding: ReviewBinding;
  matchesCheckout: boolean;
}

export interface BasicInfo {
  reviewId: string;
  title: string;
  status: LiveReviewStatus;
  rootNodeId: string;
  nodeCount: number;
  binding: ReviewBinding;
}

export interface Node {
  id: string;
  parentId: string | null;
  title?: string;
  source: string;
  childIds: string[];
}

export interface Selection {
  reviewId: string;
  nodeIds: string[];
}

export interface RenderDiagnostic {
  path: string;
  message: string;
}

export type RenderResult =
  | {
      ok: true;
      reviewId: string;
      targetNodeId: string;
      nodeId: string;
      version: number;
    }
  | {
      ok: false;
      reviewId: string;
      targetNodeId: string;
      diagnostics: RenderDiagnostic[];
    };

export interface ReviewAPI {
  listReviews(input?: {
    scope?: "current-checkout" | "all";
  }): Promise<ReviewSummary[]>;
  createReview(input: {
    source: { kind: "current-checkout" };
    title: string;
  }): Promise<BasicInfo>;
  openReview(input: { reviewId: string }): Promise<BasicInfo>;
  getBasicInfo(input?: { reviewId?: string }): Promise<BasicInfo>;
  getSelection(input?: { reviewId?: string }): Promise<Selection>;
  getNodeInfo(input: { reviewId?: string; nodeId: string }): Promise<Node>;
  getChildren(input: { reviewId?: string; nodeId: string }): Promise<Node[]>;
  renderMdx(input: {
    reviewId?: string;
    targetNodeId: string;
    mode: "append" | "replace";
    title?: string;
    mdx: string;
  }): Promise<RenderResult>;
  setReviewStatus(input: {
    reviewId?: string;
    status: LiveReviewStatus;
  }): Promise<BasicInfo>;
}

export interface StoredLiveReviewNode {
  id: string;
  title?: string;
  source: string;
  children: string[];
}

export interface LiveReviewPage {
  id: string;
  rootNodeId: string;
  nodes: Record<string, StoredLiveReviewNode>;
  version: number;
  updatedAt: string;
  projection: Spec;
}
