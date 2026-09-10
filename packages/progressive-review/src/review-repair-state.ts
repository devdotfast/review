import { existsSync } from "node:fs";
import path from "node:path";

import { ReviewRepairReadyResponseSchema } from "./review-lifecycle-contracts";
export { ReviewRepairReadyResponseSchema } from "./review-lifecycle-contracts";
import type { z } from "zod";

import { REVIEW_ARTIFACTS_DIR } from "./review-artifact-store";
import { isDerivedReviewPath } from "./review-derived-paths";
import {
  hasPendingReviewAgentWrites,
  reviewThreadDbPath,
} from "./review-thread-store-backend";
import { fingerprintReviewTree } from "./review-tree-fingerprint";

export type ReviewRepairReadyResponse = z.infer<
  typeof ReviewRepairReadyResponseSchema
>;

export async function fingerprintReviewRepairInputs(
  dir: string,
): Promise<string> {
  return fingerprintReviewTree(dir, {
    include: (relativePath) => {
      const top = relativePath.split(path.sep)[0] ?? "";
      return top !== REVIEW_ARTIFACTS_DIR && !isDerivedReviewPath(top);
    },
    symlink: "hash-target",
  });
}

/** Unanswered agent-directed inputs can still mutate authored files. Ordinary
 * open reviewer threads are intentionally not a repair gate. */
export function assertNoActiveReviewAgentWrites(dir: string): void {
  const reviewPath = path.join(dir, "review.mdx");
  if (!existsSync(reviewThreadDbPath(reviewPath))) return;
  if (hasPendingReviewAgentWrites(reviewPath))
    throw new Error(
      "Review repair is blocked by pending agent writes; wait for the active agent response to finish, then retry.",
    );
}
