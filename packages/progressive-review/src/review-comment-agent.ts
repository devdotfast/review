import type { CreateReviewCommentInput } from "./types";

export function reviewCommentPrompt(comment: CreateReviewCommentInput): string {
  return `${reviewCommentPromptPrefix(comment.threadId)}${comment.body}`;
}

export function reviewCommentPromptPrefix(threadId: string): string {
  return `dev-review: this session is answering questions about a Review in a frozen, read-only clone of the repository at authoring time.
dev-review-thread-id: ${threadId}
Use \`review\` from PATH for Review commands.\n\n`;
}
