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

import type { SessionRef } from "./agent-session-ref";

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

export interface UpdateReviewCommentInput {
  status?: ReviewCommentThreadRecord["status"];
  body?: string;
  messageId?: string;
}
