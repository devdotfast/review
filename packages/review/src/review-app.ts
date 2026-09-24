import type { Writable } from "node:stream";

import {
  ReviewApiClient,
  type ReviewApiSummary,
} from "@dev.fast/review-protocol";

import {
  type ReviewInstanceSelection,
  healthyReviewInstance,
  reviewInstanceUnavailable,
  selectReviewInstance,
} from "./desktop-discovery";
import { focusReviewDesktop, runReviewAppLaunch } from "./review-app-launcher";
import { pickReview } from "./review-app-picker";
import { resolveReviewRoot } from "./runtime";

interface ReviewAppRuntime {
  launch: typeof runReviewAppLaunch;
  selectInstance: () => Promise<ReviewInstanceSelection>;
  resolveReviewRoot: typeof resolveReviewRoot;
  pickReview: typeof pickReview;
  fetch: typeof globalThis.fetch;
}

export interface RunReviewAppInput {
  cwd: string;
  reviewUuid?: string;
  /** Bring Review Desktop forward. */
  focus?: boolean;
  stdin: NodeJS.ReadStream;
  stdout: Writable;
}

export interface ReviewAppEvent {
  event: "app";
  action: "pick";
  reviewUuid: string;
  title: string;
  cancelled?: boolean;
}

export async function runReviewAppPick(
  input: RunReviewAppInput,
  overrides: Partial<ReviewAppRuntime> = {},
): Promise<ReviewAppEvent | null> {
  const fetch = overrides.fetch ?? globalThis.fetch;

  const runtime = {
    launch: runReviewAppLaunch,
    selectInstance: () => selectReviewInstance({ fetch }),
    resolveReviewRoot,
    pickReview,
    fetch,
    ...overrides,
  };

  // Only `review app launch` may recover a stale or incompatible record; the
  // other verbs report the diagnosis rather than start a second Desktop. No
  // record at all means nothing is running, which launching does fix.
  let selection = await runtime.selectInstance();
  let launched = false;

  if (!selection.instance && !selection.problem) {
    await runtime.launch({ focus: input.focus });
    launched = true;
    selection = await runtime.selectInstance();
  }

  const discovery = healthyReviewInstance(selection);

  if (!discovery) throw reviewInstanceUnavailable(selection);

  const client = new ReviewApiClient(
    { serverUrl: discovery.url, token: discovery.token },
    runtime.fetch,
  );

  let review: Pick<ReviewApiSummary, "reviewId" | "title">;

  if (input.reviewUuid) {
    // Without `full`, GET /reviews-api/:id answers inspectSnapshot(): block
    // descriptors with no reviewId or title.
    review = await client.read(
      `/${encodeURIComponent(input.reviewUuid)}?full=true`,
    );
  } else {
    if (!input.stdin.isTTY)
      throw new Error(
        "review app pick needs a terminal without --review. Pass --review <uuid> or run it in a terminal.",
      );
    const root = await runtime.resolveReviewRoot(input.cwd);

    const reviews = (await client.read<ReviewApiSummary[]>(""))
      .filter((review) => review.repositoryPath === root && !review.dismissedAt)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    if (!reviews.length) throw new Error("No review to show.");

    const picked = await runtime.pickReview(
      reviews.map((review) => ({
        uuid: review.reviewId,
        title: review.title,
        status: review.viewedAt ? "viewed" : "new",
        lastPublishedAt: review.createdAt,
      })),
      input,
    );

    if (!picked) return null;
    review = { reviewId: picked.uuid, title: picked.title };
  }

  await client.post(`/${encodeURIComponent(review.reviewId)}/open`, {});

  // A focused fresh launch already came forward; a running one must be asked.
  if (input.focus && !launched)
    await focusReviewDesktop(discovery, runtime.fetch);

  return {
    event: "app",
    action: "pick",
    reviewUuid: review.reviewId,
    title: review.title,
  };
}
