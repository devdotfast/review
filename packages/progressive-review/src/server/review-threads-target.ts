import { reviewUuidForManagedCheckout } from "../review-head-checkout";
import {
  type StoredReview,
  findReview,
  findScopedReview,
  listReviews,
} from "../review-home";

export async function resolveThreadsReview(
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
  if (reviewUuid) {
    const selected = await findScopedReview(reviewUuid, {
      worktreePath: cwd,
      includeTerminal: true,
    });
    return selected ? [selected] : [];
  }
  const listed = await listReviews({ worktreePath: cwd });
  if (listed.errors.length > 0) {
    throw new Error(
      `Could not read reviews:\n${listed.errors.map((error) => error.message).join("\n")}`,
    );
  }
  return listed.reviews;
}
