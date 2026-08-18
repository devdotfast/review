import type { CreateReviewCommentInput } from "./types";

export function reviewCommentPrompt(comment: CreateReviewCommentInput): string {
  return `${reviewCommentPromptPrefix(comment.threadId)}${comment.body}`;
}

export function reviewCommentPromptPrefix(threadId: string): string {
  return `dev-review: this session has been forked from the authoring session into a frozen, read-only clone of the repository at authoring time. The user will use this worktree to ask questions about the review.
dev-review-thread-id: ${threadId}
Use \`review\` from PATH for Review commands.\n\n`;
}
