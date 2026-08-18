import { currentHead } from "@dev.fast/local-vcs";

import { resolveReviewHeadRelationship } from "./review-head-relationship";
import type { StoredReview } from "./review-home";

const POSITIONAL_REFS = new Set(["@", "HEAD"]);

/**
 * A positional identity names "wherever the checkout currently stands", not a
 * unit of change. Scaffold refuses to create such bindings; update and the
 * publish staleness check refuse to follow them.
 */
export function isPositionalChangeIdentity(ref: string): boolean {
  return POSITIONAL_REFS.has(ref);
}

/**
 * The actionable reviews for the checked-out unit of change: non-terminal,
 * with the checkout at or descended from the review's head — the same
 * relationship publish accepts. Terminal reviews are history: every ancestor
 * change's accepted review would otherwise accumulate forever. Legacy
 * positional identities ("@", "HEAD") name no unit, so they match on their
 * pinned commit instead. A directory with no repository cannot scope by
 * change, so it keeps the full list.
 */
export async function actionableReviewsForCheckout(
  reviews: readonly StoredReview[],
  reviewRoot: string,
): Promise<StoredReview[]> {
  const checkout = await currentHead(reviewRoot);
  if (!checkout) return [...reviews];
  const matches = await Promise.all(
    reviews.map(async (stored) => {
      if (
        stored.review.status === "accepted" ||
        stored.review.status === "rejected"
      ) {
        return false;
      }
      const identity = stored.review.sourceIdentity?.name;
      const headRef =
        !identity || POSITIONAL_REFS.has(identity)
          ? stored.review.sourceCommit
          : identity;
      if (!headRef) return false;
      const relationship = await resolveReviewHeadRelationship({
        rootPath: reviewRoot,
        headRef,
      });
      return (
        relationship.kind === "exact" || relationship.kind === "descendant"
      );
    }),
  );
  return reviews.filter((_, index) => matches[index]);
}
