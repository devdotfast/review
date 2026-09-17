import {
  ReviewApiClient,
  type ReviewApiSummary,
} from "@dev.fast/review-protocol";

import { requireHealthyReviewDesktop } from "./desktop-discovery";
import { resolveReviewRoot } from "./runtime";

export interface RunReviewInfoInput {
  cwd: string;
  all?: boolean;
  reviewUuid?: string;
}

export interface ReviewInfoEvent {
  event: "info";
  reviews: ReviewApiSummary[];
}

export async function runReviewInfo(
  input: RunReviewInfoInput,
  runtime = { requireHealthyReviewDesktop, resolveReviewRoot },
): Promise<ReviewInfoEvent> {
  if (input.all && input.reviewUuid)
    throw new Error("Review info cannot combine all and reviewUuid.");
  const discovery = await runtime.requireHealthyReviewDesktop("review info");

  const client = new ReviewApiClient({
    serverUrl: discovery.url,
    token: discovery.token,
  });

  const reviews = await client.read<ReviewApiSummary[]>("/");

  if (input.reviewUuid) {
    const selected = reviews.find(
      (review) => review.reviewId === input.reviewUuid,
    );

    if (!selected) throw new Error(`Review not found: ${input.reviewUuid}`);

    return { event: "info", reviews: [selected] };
  }

  const root = await runtime.resolveReviewRoot(input.cwd);

  return {
    event: "info",
    reviews: reviews.filter(
      (review) =>
        review.repositoryPath === root && (input.all || !review.dismissedAt),
    ),
  };
}
