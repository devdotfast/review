import { randomUUID } from "node:crypto";
import type { Writable } from "node:stream";

import {
  ReviewCommentThreadRecordSchema,
  isJsonObject,
  jsonString,
} from "@dev.fast/review-protocol";
import { EnvHttpProxyAgent } from "undici";

import {
  REVIEW_AGENT_THREAD_TOKEN_ENV,
  REVIEW_AGENT_THREAD_URL_ENV,
} from "./native-agent/terminal-command";
import {
  commandThreadsClient,
  readThreadsClient,
  replyThreadClient,
  resolveThreadsReviewClient as resolveThreadsReview,
} from "./review-lifecycle-client";

export interface ReviewThreadsTarget {
  cwd: string;
  reviewUuid?: string;
}

export async function runReviewThreadsList(
  input: ReviewThreadsTarget & { json?: boolean; stdout: Writable },
): Promise<number> {
  const review = await resolveThreadsReview(input.cwd, input.reviewUuid);

  const payload = {
    review: review.review.uuid,
    comments: (await readThreadsClient(review.review.uuid)).comments,
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
    stdout: Writable;
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
  const token = env[REVIEW_AGENT_THREAD_TOKEN_ENV]?.trim();

  if (!baseUrl || !token) {
    throw new Error(
      "review threads get requires an attached Review Desktop server.",
    );
  }

  // Node fetch does not automatically use the proxy supplied by Codex's
  // network sandbox. Keep this dispatcher local to the attached-thread read.
  const dispatcher = new EnvHttpProxyAgent({
    httpProxy: env.http_proxy ?? env.HTTP_PROXY,
    httpsProxy: env.https_proxy ?? env.HTTPS_PROXY,
    noProxy: env.no_proxy ?? env.NO_PROXY,
  });

  const requestOptions = { dispatcher };

  try {
    let response: Response;

    try {
      response = await fetch(
        `${baseUrl.replace(/\/$/u, "")}/${encodeURIComponent(input.threadId)}`,
        { headers: { "x-review-token": token }, ...requestOptions },
      );
    } catch (error) {
      throw new Error("Review Desktop could not read the thread.", {
        cause: error,
      });
    }

    if (response.status === 404) {
      await response.body?.cancel();
      throw new Error(`Comment thread not found: ${input.threadId}`);
    }

    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(
        `Review Desktop could not read the thread (${response.status}).`,
      );
    }

    const record: unknown = await response.json();

    if (!isJsonObject(record)) {
      throw new Error("Review Desktop returned an invalid thread response.");
    }

    const review = jsonString(record.review);
    const state = record.state;

    if (review === undefined || (state !== "draft" && state !== "submitted")) {
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
  } finally {
    await dispatcher.close();
  }
}

export async function runReviewThreadsResolve(
  input: ReviewThreadsTarget & {
    threadId: string;
    stdout: Writable;
  },
): Promise<number> {
  const review = await resolveThreadsReview(input.cwd, input.reviewUuid);
  await commandThreadsClient(review.review.uuid, {
    command: "comment.update",
    mutationId: randomUUID(),
    threadId: input.threadId,
    update: { status: "resolved" },
  });
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
    stdout: Writable;
  },
): Promise<number> {
  const body = input.body.trim();

  if (!body) throw new Error("Reply body is required.");
  const review = await resolveThreadsReview(input.cwd, input.reviewUuid);
  const messageId = randomUUID();
  // The republish gate requires a completed model response with role "agent"
  // on every current-round thread, so a CLI reply must not read as another
  // reviewer message.
  await replyThreadClient({
    reviewUuid: review.review.uuid,
    mutationId: randomUUID(),
    threadId: input.threadId,
    messageId,
    author: input.author?.trim() || "Agent",
    body,
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
