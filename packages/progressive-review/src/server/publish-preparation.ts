import { mergeBase, resolveRevision } from "@dev.fast/local-vcs";

import {
  actionableReviewsForCheckout,
  isPositionalChangeIdentity,
} from "../review-change-scope";
import { type StoredReview, listReviews } from "../review-home";
import {
  requireClosedThreadsForRepublish,
  requireCompletedAgentResponsesForRepublish,
} from "../review-publish-thread-gate";

export interface PreparedReviewPublish {
  review: StoredReview;
  uuid: string;
  sourceCommit: string;
  sourceBranch: string;
  warnings?: string[];
}

export async function prepareReviewPublish(input: {
  cwd: string;
  reviewUuid?: string;
}): Promise<PreparedReviewPublish> {
  const review = await resolvePublishReview(input.cwd, input.reviewUuid);
  requireClosedThreadsForRepublish(review);
  requireCompletedAgentResponsesForRepublish(review);
  const sourceBranch = requireSourceBranch(review);
  // Publish presents the stored pins; it never moves them, and the checkout's
  // position is irrelevant: sessions read the pinned-head worktree, not the
  // working tree. `review scaffold --update` is the only re-pin action.
  const sourceCommit = review.review.sourceCommit;
  if (!sourceCommit) {
    throw new Error(
      `Review ${review.review.uuid} is not bound to a source commit. Run \`review scaffold --update\`.`,
    );
  }
  const baseExists = await resolveRevision(
    review.review.worktreePath,
    review.review.baseCommit,
  );
  if (!baseExists) {
    throw new Error(
      `Review base commit no longer exists: ${review.review.baseCommit}. Run \`review scaffold --update\` and publish again.`,
    );
  }
  const warnings: string[] = [];
  if (await pinsAreBehind(review, sourceCommit, sourceBranch)) {
    warnings.push(
      `Pinned commits are behind ${sourceBranch}. Run \`review scaffold --update\` and publish again to present the latest commits.`,
    );
  }
  return {
    review,
    uuid: review.review.uuid,
    sourceCommit,
    sourceBranch,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

async function pinsAreBehind(
  review: StoredReview,
  sourceCommit: string,
  sourceBranch: string,
): Promise<boolean> {
  // A positional identity ("HEAD"/"@") names the checkout, not a branch;
  // comparing pins against it would warn whenever the user stands elsewhere.
  if (isPositionalChangeIdentity(sourceBranch)) return false;
  const rootPath = review.review.worktreePath;
  const branchHead = await resolveRevision(rootPath, sourceBranch).catch(
    () => null,
  );
  if (!branchHead || branchHead.commit === sourceCommit) return false;
  // A pinned commit ahead of the branch tip is not stale; the pins are stale
  // only when the tip is not contained in the pinned commit.
  const ancestor = await mergeBase({
    rootPath,
    baseRef: branchHead.commit,
    headRef: sourceCommit,
  }).catch(() => null);
  return ancestor?.commit !== branchHead.commit;
}

export async function resolvePublishReview(
  cwd: string,
  reviewUuid: string | undefined,
  options: { includeTerminal?: boolean } = {},
): Promise<StoredReview> {
  const listed = await listReviews({ worktreePath: cwd });
  if (listed.errors.length > 0) {
    throw new Error(
      `Could not read reviews:\n${listed.errors.map((error) => error.message).join("\n")}`,
    );
  }
  const publishable = listed.reviews.filter(
    (review) =>
      review.review.status !== "accepted" &&
      review.review.status !== "rejected",
  );
  if (reviewUuid) {
    const review = (
      options.includeTerminal ? listed.reviews : publishable
    ).find((entry) => entry.review.uuid === reviewUuid);
    if (!review) throw new Error(`Active review not found: ${reviewUuid}`);
    return review;
  }
  const scoped = await actionableReviewsForCheckout(publishable, cwd);
  if (scoped.length === 0) {
    throw new Error(
      "No publishable review found for the checked-out change. Scaffold one, or pass --review <uuid>.",
    );
  }
  if (scoped.length > 1) {
    throw new Error("Multiple active reviews require --review <uuid>.");
  }
  return scoped[0]!;
}

function requireSourceBranch(review: StoredReview): string {
  if (!review.review.sourceIdentity) {
    throw new Error(
      `Review ${review.review.uuid} has no pinned source branch.`,
    );
  }
  return review.review.sourceIdentity.name;
}
