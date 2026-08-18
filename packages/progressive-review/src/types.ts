import type {
  CodeThreadTarget,
  CreateReviewCommentInput,
  ReviewCommentAgentSession,
  ReviewCommentDraftThread,
  ReviewCommentDraftThreadMap,
  ReviewCommentMessage,
  ReviewCommentThreadMap,
  ReviewCommentThreadRecord,
  TextSurface,
  ThreadSelection,
  ThreadTarget,
} from "@dev.fast/review-protocol";

import type { SessionRef } from "./authoring-session";
export type {
  CodeThreadTarget,
  CreateReviewCommentInput,
  ReviewCommentAgentSession,
  ReviewCommentDraftThread,
  ReviewCommentDraftThreadMap,
  ReviewCommentMessage,
  ReviewCommentThreadMap,
  ReviewCommentThreadRecord,
  TextSurface,
  ThreadSelection,
  ThreadTarget,
};

export interface CreateReviewSubmissionInput {
  submissionId: string;
  decision: "approve" | "request-changes";
  comments: CreateReviewCommentInput[];
}

export interface ReviewSubmissionEvent {
  id: string;
  decision: "approve" | "request-changes";
  createdAt: string;
  rootPath: string;
  reviewPath: string;
  documentRoute: string;
  appUrl?: string;
  baseRef?: string;
  headRef?: string;
  pullRequestNumber?: number;
  agent?: SessionRef;
  codexThreadId?: string;
  comments: CreateReviewCommentInput[];
  prompt: string;
}

export type ReviewLifecyclePhaseName = "review_document" | "server";

export interface ReviewLifecycleError {
  name: string;
  message: string;
  stack?: string;
  component?: string;
  propertyPath?: string;
  expected?: unknown;
  received?: unknown;
}

export type ReviewLifecycleEvent =
  | {
      event: "start";
      cliPath: string;
      cliName: string;
      cliVersion: string;
      provenance: "workspace" | "installed";
      source: string;
      args: string[];
      base: string;
      head: string;
      repo?: string;
      pullRequest?: number;
    }
  | {
      event: "phase";
      name: ReviewLifecyclePhaseName;
      status: "running" | "complete";
    }
  | {
      event: "ready";
      url: string;
      document: string;
      headCheckout?: string;
    }
  | {
      event: "diagnostic";
      level: "info" | "warn" | "error";
      origin: "review";
      message: string;
      error?: ReviewLifecycleError;
    }
  | { event: "submitted"; submission: ReviewSubmissionEvent }
  | { event: "dismissed"; reason: "canvas_closed" }
  | {
      event: "error";
      error: ReviewLifecycleError;
    };

export interface UpdateReviewCommentInput {
  status?: ReviewCommentThreadRecord["status"];
  body?: string;
  messageId?: string;
}

export interface ReviewSession {
  rootPath: string;
  baseRef: string;
  headRef?: string;
  pullRequestNumber?: number;
  pullRequestUrl?: string;
  appUrl: string;
  reviewPath: string;
  codeGraphUrl?: string;
  agent?: SessionRef;
  codexThreadId?: string;
  startedAt: number;
}
