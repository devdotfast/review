import path from "node:path";

import { actionableReviewsForCheckout } from "../review-change-scope";
import { type StoredReview, computeSync, listReviews } from "../review-home";
import { type ReviewInfoEvent, type RunReviewInfoInput } from "../review-info";
import { readReviewComments } from "../review-state-store";
import { resolveReviewRoot } from "../runtime";
import { resolveReviewRepositoryIdentity } from "./repository-identity";

export async function resolveReviewInfo(
  input: RunReviewInfoInput,
): Promise<ReviewInfoEvent> {
  const reviewRoot = await resolveReviewRoot(input.cwd);
  const repository = await resolveReviewRepositoryIdentity(reviewRoot);
  const filter = input.all
    ? { repoKey: repository.repositoryId }
    : { worktreePath: reviewRoot };
  const listed = await listReviews(filter);
  if (listed.errors.length > 0) {
    throw new Error(
      `Could not list reviews:\n${listed.errors.map((error) => `${error.reviewDir}: ${error.message}`).join("\n")}`,
    );
  }
  const reviews = input.all
    ? listed.reviews
    : await actionableReviewsForCheckout(listed.reviews, reviewRoot);
  return reviewInfoEvent(reviews);
}

export async function reviewInfoEvent(
  reviews: readonly StoredReview[],
): Promise<ReviewInfoEvent> {
  return {
    event: "info",
    reviews: await Promise.all(
      reviews.map(async (stored) => ({
        uuid: stored.review.uuid,
        dir: stored.dir,
        change: stored.review.sourceIdentity?.name ?? null,
        inSync: await computeSync(stored.review, stored.review.worktreePath),
        unresolvedComments: countUnresolvedComments(stored.dir),
        status: stored.review.status,
        title: stored.review.title,
      })),
    ),
  };
}

function countUnresolvedComments(dir: string): number {
  const comments = readReviewComments(path.join(dir, "review.mdx"));
  return Object.values(comments).filter((thread) => thread.status === "open")
    .length;
}
