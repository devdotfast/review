import type { StoredReview } from "./review-home";
import { reviewStateService } from "./server/review-state-service";

export class ReviewOpenThreadsError extends Error {
  override readonly name = "ReviewOpenThreadsError";
  readonly code = "review_open_threads";
  readonly statusCode = 409;

  constructor(
    readonly reviewUuid: string,
    readonly threadIds: readonly string[],
  ) {
    const count = threadIds.length;
    super(
      `Review ${reviewUuid} has ${count} open comment ${count === 1 ? "thread" : "threads"}: ${threadIds.join(", ")}. ` +
        `Address each thread, run \`review threads resolve <threadId> --review ${reviewUuid}\` for each one, ` +
        "then run `review threads list` and publish again only when no open threads remain.",
    );
  }
}

export class ReviewMissingAgentResponsesError extends Error {
  override readonly name = "ReviewMissingAgentResponsesError";
  readonly code = "review_missing_agent_responses";
  readonly statusCode = 409;

  constructor(
    readonly reviewUuid: string,
    readonly threadIds: readonly string[],
  ) {
    const count = threadIds.length;
    super(
      `Review ${reviewUuid} has ${count} current-round comment ${count === 1 ? "thread" : "threads"} without a completed model response: ${threadIds.join(", ")}. ` +
        "Respond to each listed comment, then run `review publish` again.",
    );
  }
}

/** The first publication has no previous review round to close. */
export function requireClosedThreadsForRepublish(review: StoredReview): void {
  if (!review.review.presentedDocumentRevision) return;
  const comments = reviewStateService
    .threads(
      review.review.uuid,
      path.join(review.dir, "review.mdx"),
      "Reviewer",
    )
    .snapshot().comments;
  const threadIds = Object.values(comments)
    .filter((thread) => thread.status === "open")
    .map((thread) => thread.threadId)
    .sort((left, right) => left.localeCompare(right));
  if (threadIds.length > 0) {
    throw new ReviewOpenThreadsError(review.review.uuid, threadIds);
  }
}

/** Require a completed model response for each comment from the current round. */
export function requireCompletedAgentResponsesForRepublish(
  review: StoredReview,
): void {
  const publishedAt = review.review.lastPublishedAt;
  if (!review.review.presentedDocumentRevision || !publishedAt) return;

  const comments = reviewStateService
    .threads(
      review.review.uuid,
      path.join(review.dir, "review.mdx"),
      "Reviewer",
    )
    .snapshot().comments;
  const threadIds = Object.values(comments)
    .filter((thread) =>
      thread.messages.some(
        (message) =>
          message.role !== "agent" && messageIsAfter(message.at, publishedAt),
      ),
    )
    .filter((thread) => !hasCompletedAgentResponse(thread, publishedAt))
    .map((thread) => thread.threadId)
    .sort((left, right) => left.localeCompare(right));
  if (threadIds.length > 0) {
    throw new ReviewMissingAgentResponsesError(review.review.uuid, threadIds);
  }
}

function hasCompletedAgentResponse(
  thread: {
    messages: readonly {
      id: string;
      at: string;
      role?: "reviewer" | "agent";
    }[];
  },
  publishedAt: string,
): boolean {
  const currentRoundReviewerMessages = thread.messages.filter(
    (message) =>
      message.role !== "agent" && messageIsAfter(message.at, publishedAt),
  );
  return currentRoundReviewerMessages.every((reviewerMessage) =>
    thread.messages.some(
      (message) =>
        message.role === "agent" &&
        !messageIsAfter(reviewerMessage.at, message.at),
    ),
  );
}

function messageIsAfter(messageAt: string, publishedAt: string): boolean {
  const messageTime = Date.parse(messageAt);
  const publishedTime = Date.parse(publishedAt);
  if (Number.isFinite(messageTime) && Number.isFinite(publishedTime)) {
    return messageTime > publishedTime;
  }
  return messageAt > publishedAt;
}
import path from "node:path";
