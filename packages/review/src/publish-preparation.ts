import { actionableReviewsForCheckout } from "./review-change-scope";
import {
  type StoredReview,
  findScopedReview,
  listReviews,
} from "./review-home";

export async function resolvePublishReview(
  cwd: string,
  sessionId: string | undefined,
  options: { includeTerminal?: boolean } = {},
): Promise<StoredReview> {
  if (sessionId) {
    const selected = await findScopedReview(sessionId, {
      worktreePath: cwd,
      includeTerminal: options.includeTerminal,
    });

    if (!selected) throw new Error(`Active review not found: ${sessionId}`);

    return selected;
  }

  const listed = await listReviews({
    worktreePath: cwd,
    reportUnreadableReviews: true,
  });

  if (listed.errors.length > 0) {
    throw new Error(
      `Could not read reviews:\n${listed.errors.map((error) => `${error.reviewDir}: ${error.message}`).join("\n")}`,
    );
  }

  const publishable = listed.reviews.filter(
    (review) =>
      review.review.status !== "accepted" &&
      review.review.status !== "rejected",
  );

  const scoped = await actionableReviewsForCheckout(publishable, cwd);

  if (scoped.length === 0) {
    throw new Error(
      "No active review found for the checked-out change. Pass --review <uuid>.",
    );
  }

  if (scoped.length > 1) {
    throw new Error("Multiple active reviews require --review <uuid>.");
  }

  return scoped[0]!;
}
