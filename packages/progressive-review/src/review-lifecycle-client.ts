import path from "node:path";

import {
  type JsonValue,
  type ReviewThreadsCommand,
  ReviewThreadsCommandResponseSchema,
  ReviewThreadsSnapshotResponseSchema,
  jsonObject,
  jsonString,
  parseJsonText,
} from "@dev.fast/review-protocol";
import { z } from "zod";

import { resolveAuthoringSessionRef } from "./authoring-session";
import { requireHealthyReviewDesktop } from "./desktop-discovery";
import type {
  findScopedReview,
  listReviews,
  sealReviewCandidate,
  touchReviewAgentSession,
} from "./review-home";
import {
  ReviewListResponseSchema,
  ReviewScaffoldResponseSchema,
  ReviewStoredResponseSchema,
} from "./review-lifecycle-contracts";
import type {
  ReviewScaffoldEvent,
  RunReviewScaffoldInput,
} from "./review-scaffold";
import type { resolvePublishReview } from "./server/publish-preparation";

export async function resolveThreadsReviewClient(
  cwd: string,
  reviewUuid?: string,
) {
  return ReviewStoredResponseSchema.parse(
    await requestReviewLifecycle("/lifecycle/threads/resolve-target", {
      cwd,
      reviewUuid,
    }),
  );
}

export async function readThreadsClient(reviewUuid: string) {
  const result = ReviewThreadsSnapshotResponseSchema.parse(
    await requestReviewLifecycle("/lifecycle/threads/snapshot", { reviewUuid }),
  );

  if (!result.ok) throw new Error(result.error);

  return result.snapshot;
}

export async function commandThreadsClient(
  reviewUuid: string,
  command: ReviewThreadsCommand,
) {
  const result = ReviewThreadsCommandResponseSchema.parse(
    await requestReviewLifecycle("/lifecycle/threads/command", {
      reviewUuid,
      command,
    }),
  );

  if (!result.ok) throw new Error(result.error);

  return result.commit;
}

export async function replyThreadClient(input: {
  reviewUuid: string;
  mutationId: string;
  threadId: string;
  messageId: string;
  author: string;
  body: string;
  format: "plain" | "markdown";
}) {
  const result = ReviewThreadsCommandResponseSchema.parse(
    await requestReviewLifecycle("/lifecycle/threads/reply", input),
  );

  if (!result.ok) throw new Error(result.error);

  return result.commit;
}

export const listReviewsClient: typeof listReviews = async (filter = {}) =>
  ReviewListResponseSchema.parse(
    await requestReviewLifecycle("/lifecycle/list", filter),
  );

export const resolveReviewClient: typeof resolvePublishReview = async (
  cwd,
  reviewUuid,
  options = {},
) =>
  ReviewStoredResponseSchema.parse(
    await requestReviewLifecycle("/lifecycle/resolve", {
      cwd,
      reviewUuid,
      ...options,
    }),
  );

export const findScopedReviewClient: typeof findScopedReview = async (
  reviewUuid,
  scope,
) =>
  ReviewStoredResponseSchema.nullable().parse(
    await requestReviewLifecycle("/lifecycle/find", {
      reviewUuid,
      worktreePath: scope.worktreePath,
      includeTerminal: scope.includeTerminal,
      includeLegacySchema: scope.includeLegacySchema,
    }),
  );

export const checkpointReviewClient: typeof sealReviewCandidate = async (
  reviewDir,
  message,
) =>
  z.string().parse(
    await requestReviewLifecycle("/lifecycle/checkpoint", {
      reviewUuid: path.basename(reviewDir),
      message,
    }),
  );

export const touchReviewAgentSessionClient: typeof touchReviewAgentSession =
  async (stored, session, role) =>
    ReviewStoredResponseSchema.parse(
      await requestReviewLifecycle("/lifecycle/agent-session", {
        reviewUuid: stored.review.uuid,
        session,
        role,
      }),
    );

export async function openThreadCountClient(
  reviewDir: string,
): Promise<number> {
  return z
    .number()
    .int()
    .nonnegative()
    .parse(
      await requestReviewLifecycle("/lifecycle/open-thread-count", {
        reviewUuid: path.basename(reviewDir),
      }),
    );
}

export async function scaffoldReviewClient(
  input: RunReviewScaffoldInput,
): Promise<ReviewScaffoldEvent> {
  const result = ReviewScaffoldResponseSchema.parse(
    await requestReviewLifecycle("/lifecycle/scaffold", {
      cwd: input.cwd,
      reviewUuid: input.reviewUuid,
      baseRef: input.baseRef,
      headRef: input.headRef,
      pullRequest: input.pullRequest,
      update: input.update,
      newReview: input.newReview,
      background: input.background,
      agent: resolveAuthoringSessionRef(input.env ?? process.env),
    }),
  );

  for (const review of result.reviews) await input.onReviewBound?.(review.uuid);

  return result;
}

/** Only discovery and HTTP live in the client; all Review storage is server-owned. */
export async function requestReviewLifecycle<Input>(
  pathname: string,
  body?: Input,
): Promise<JsonValue> {
  const desktop = await requireHealthyReviewDesktop("Review lifecycle");

  const response = await fetch(`${desktop.url}${pathname}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "content-type": "application/json",
      "x-review-token": desktop.token,
    },
    body: JSON.stringify(body),
  });

  const result = parseJsonText(await response.text());

  if (!response.ok)
    throw new Error(
      jsonString(jsonObject(result)?.error) ??
        `Review Desktop returned ${response.status}.`,
    );

  return result;
}
