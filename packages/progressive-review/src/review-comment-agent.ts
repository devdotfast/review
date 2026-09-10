import type { CreateReviewCommentInput } from "./types";

export function reviewCommentPrompt(comment: CreateReviewCommentInput): string {
  return `${reviewCommentPromptPrefix(comment.threadId)}${comment.body}`;
}

export function reviewCommentPromptPrefix(threadId: string): string {
  return `dev-review: this session is answering a bundled Review tutorial question in a frozen, read-only clone of the repository.
dev-review-thread-id: ${threadId}
Read the complete question context with \`review internal-thread ${threadId}\` from PATH. This utility is only for the attached tutorial; do not use the retired \`review threads\` commands.
Do not modify files, publish, resolve, or reply through the CLI. Review Desktop stores your returned answer in the same thread. Return only the answer to the user message below.\n\n`;
}
