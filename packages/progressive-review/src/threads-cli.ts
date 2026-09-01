import { randomUUID } from "node:crypto";
import path from "node:path";

import { ReviewCommentThreadRecordSchema } from "./review-comment-schema";
import { reviewUuidForManagedCheckout } from "./review-head-checkout";
import { type StoredReview, findReview, listReviews } from "./review-home";
import {
  appendReviewAgentMessage,
  readReviewComments,
  updateReviewComment,
} from "./review-state-store";

// `review threads get` reads its attached Review server. Other commands can
// still operate after that server closes, so they use review.db.

export interface ReviewThreadsTarget {
  cwd: string;
  reviewUuid?: string;
}

const REVIEW_AGENT_THREAD_URL_ENV = "DEV_FAST_REVIEW_AGENT_THREAD_URL";
const REVIEW_AGENT_HOOK_TOKEN_ENV = "DEV_FAST_REVIEW_AGENT_HOOK_TOKEN";

export async function runReviewThreadsList(
  input: ReviewThreadsTarget & { json?: boolean; stdout: NodeJS.WriteStream },
): Promise<number> {
  const review = await resolveThreadsReview(input.cwd, input.reviewUuid);
  const document = reviewDocumentPath(review);
  const payload = {
    review: review.review.uuid,
    comments: readReviewComments(document),
  };
  // Indented output is easier for a human to read, but it breaks any reader
  // that takes one event per line. --json picks the line-oriented form.
  input.stdout.write(
    input.json
      ? `${JSON.stringify(payload)}\n`
      : `${JSON.stringify(payload, null, 2)}\n`,
  );
  return 0;
}

export async function runReviewThreadsGet(
  input: ReviewThreadsTarget & {
    env?: NodeJS.ProcessEnv;
    threadId: string;
    stdout: NodeJS.WriteStream;
  },
): Promise<number> {
  const thread = await readAttachedReviewThread(input);
  input.stdout.write(`${JSON.stringify(thread, null, 2)}\n`);
  return 0;
}

async function readAttachedReviewThread(input: {
  env?: NodeJS.ProcessEnv;
  reviewUuid?: string;
  threadId: string;
}): Promise<{
  review: string;
  state: "draft" | "submitted";
  comment: ReturnType<typeof ReviewCommentThreadRecordSchema.parse>;
}> {
  const env = input.env ?? process.env;
  const baseUrl = env[REVIEW_AGENT_THREAD_URL_ENV]?.trim();
  const token = env[REVIEW_AGENT_HOOK_TOKEN_ENV]?.trim();
  if (!baseUrl || !token) {
    throw new Error(
      "review threads get requires an attached Review Desktop server.",
    );
  }
  let response: Response;
  try {
    response = await fetch(
      `${baseUrl.replace(/\/$/u, "")}/${encodeURIComponent(input.threadId)}`,
      { headers: { "x-review-token": token } },
    );
  } catch (error) {
    throw new Error("Review Desktop could not read the thread.", {
      cause: error,
    });
  }
  if (response.status === 404) {
    throw new Error(`Comment thread not found: ${input.threadId}`);
  }
  if (!response.ok) {
    throw new Error(
      `Review Desktop could not read the thread (${response.status}).`,
    );
  }
  const value: unknown = await response.json();
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Review Desktop returned an invalid thread response.");
  }
  const record = value as Record<string, unknown>;
  const review = record.review;
  const state = record.state;
  if (
    typeof review !== "string" ||
    (state !== "draft" && state !== "submitted")
  ) {
    throw new Error("Review Desktop returned an invalid thread response.");
  }
  if (input.reviewUuid && input.reviewUuid !== review) {
    throw new Error(`Review not found: ${input.reviewUuid}`);
  }
  return {
    review,
    state,
    comment: ReviewCommentThreadRecordSchema.parse(record.comment),
  };
}

export async function runReviewThreadsResolve(
  input: ReviewThreadsTarget & {
    threadId: string;
    stdout: NodeJS.WriteStream;
  },
): Promise<number> {
  const review = await resolveThreadsReview(input.cwd, input.reviewUuid);
  const document = reviewDocumentPath(review);
  if (!updateReviewComment(document, input.threadId, { status: "resolved" })) {
    throw new Error(`Comment thread not found: ${input.threadId}`);
  }
  input.stdout.write(
    `${JSON.stringify({
      event: "resolved",
      review: review.review.uuid,
      threadId: input.threadId,
    })}\n`,
  );
  return 0;
}

export async function runReviewThreadsReply(
  input: ReviewThreadsTarget & {
    threadId: string;
    body: string;
    author?: string;
    stdout: NodeJS.WriteStream;
  },
): Promise<number> {
  const body = input.body.trim();
  if (!body) throw new Error("Reply body is required.");
  const review = await resolveThreadsReview(input.cwd, input.reviewUuid);
  const document = reviewDocumentPath(review);
  const thread = readReviewComments(document)[input.threadId];
  if (!thread) {
    throw new Error(`Comment thread not found: ${input.threadId}`);
  }
  const messageId = randomUUID();
  // The republish gate requires a completed model response with role "agent"
  // on every current-round thread, so a CLI reply must not read as another
  // reviewer message.
  appendReviewAgentMessage(document, input.threadId, {
    id: messageId,
    by: input.author?.trim() || "Agent",
    at: new Date().toISOString(),
    body,
    role: "agent",
    format: "plain",
  });
  input.stdout.write(
    `${JSON.stringify({
      event: "replied",
      review: review.review.uuid,
      threadId: input.threadId,
      messageId,
    })}\n`,
  );
  return 0;
}

function reviewDocumentPath(review: StoredReview): string {
  return path.join(review.dir, "review.mdx");
}

async function resolveThreadsReview(
  cwd: string,
  reviewUuid: string | undefined,
): Promise<StoredReview> {
  const candidates = (await reviewsForThreads(cwd, reviewUuid)).filter(
    (review) => review.review.status !== "rejected",
  );
  if (candidates.length === 0) {
    throw new Error(
      reviewUuid
        ? `Review not found: ${reviewUuid}`
        : "No review found for this worktree.",
    );
  }
  if (candidates.length > 1) {
    throw new Error("Multiple reviews require --review <uuid>.");
  }
  return candidates[0]!;
}

async function reviewsForThreads(
  cwd: string,
  reviewUuid: string | undefined,
): Promise<StoredReview[]> {
  const managedReviewUuid = await reviewUuidForManagedCheckout(cwd);
  if (managedReviewUuid) {
    if (reviewUuid && reviewUuid !== managedReviewUuid) {
      throw new Error(
        `Managed checkout belongs to Review ${managedReviewUuid}, not ${reviewUuid}.`,
      );
    }
    const review = await findReview(managedReviewUuid);
    return review ? [review] : [];
  }
  const listed = await listReviews({ worktreePath: cwd });
  if (listed.errors.length > 0) {
    throw new Error(
      `Could not read reviews:\n${listed.errors.map((error) => error.message).join("\n")}`,
    );
  }
  if (reviewUuid) {
    return listed.reviews.filter((entry) => entry.review.uuid === reviewUuid);
  }
  return listed.reviews;
}
