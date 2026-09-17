import type { Writable } from "node:stream";

import {
  ReviewApiClient,
  type ReviewApiSummary,
} from "@dev.fast/review-protocol";

import { readReviewDesktopDiscovery } from "./desktop-discovery";
import { runReviewAppLaunch } from "./review-app-launcher";
import { pickReview } from "./review-app-picker";
import { resolveReviewRoot } from "./runtime";

interface ReviewAppRuntime {
  launch: typeof runReviewAppLaunch;
  readReviewDesktopDiscovery: typeof readReviewDesktopDiscovery;
  resolveReviewRoot: typeof resolveReviewRoot;
  pickReview: typeof pickReview;
  fetch: typeof globalThis.fetch;
}

export interface RunReviewAppInput {
  cwd: string;
  reviewUuid?: string;
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
  const runtime = {
    launch: runReviewAppLaunch,
    readReviewDesktopDiscovery,
    resolveReviewRoot,
    pickReview,
    fetch: globalThis.fetch,
    ...overrides,
  };

  await runtime.launch();
  const discovery = await runtime.readReviewDesktopDiscovery();

  if (!discovery)
    throw new Error(
      "Review Desktop is not ready. Run `review app launch` and retry `review app pick`.",
    );

  const client = new ReviewApiClient(
    { serverUrl: discovery.url, token: discovery.token },
    runtime.fetch,
  );

  let review: Pick<ReviewApiSummary, "reviewId" | "title">;

  if (input.reviewUuid) {
    review = await client.read(`/${encodeURIComponent(input.reviewUuid)}`);
  } else {
    if (!input.stdin.isTTY)
      throw new Error(
        "review app pick needs a terminal without --review. Pass --review <uuid> or run it in a terminal.",
      );
    const root = await runtime.resolveReviewRoot(input.cwd);

    const reviews = (await client.read<ReviewApiSummary[]>("/"))
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

  return {
    event: "app",
    action: "pick",
    reviewUuid: review.reviewId,
    title: review.title,
  };
}
