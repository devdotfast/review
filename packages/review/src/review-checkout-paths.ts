import path from "node:path";

import { safeStorageSegment } from "./review-home-paths";
import { devFastGitDir } from "./software-map-paths";

export type ReviewCheckoutRole = "head" | "base" | "navigator";

/** Root for legacy commit-owned Review checkouts. Migration removes it. */
export function legacyReviewWorktreesDir(gitCommonDir: string): string {
  return path.join(devFastGitDir(gitCommonDir), "worktrees");
}

/**
 * Root for Review-owned checkouts. A Review UUID identifies one subtree.
 */
export function reviewManagedCheckoutsDir(gitCommonDir: string): string {
  return path.join(devFastGitDir(gitCommonDir), "reviews");
}

/** Return the checkout subtree owned by one Review UUID. */
export function reviewManagedCheckoutRoot(
  gitCommonDir: string,
  reviewUuid: string,
): string {
  return path.join(
    reviewManagedCheckoutsDir(gitCommonDir),
    safeStorageSegment(reviewUuid),
  );
}

/** A detached checkout owned by one Review revision and source role. */
export function reviewManagedCheckoutDir(
  gitCommonDir: string,
  reviewUuid: string,
  role: ReviewCheckoutRole,
  commit: string,
): string {
  return path.join(
    reviewManagedCheckoutRoot(gitCommonDir, reviewUuid),
    role,
    safeStorageSegment(commit),
  );
}
