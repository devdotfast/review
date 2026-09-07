import { existsSync } from "node:fs";
import path from "node:path";

import { ReviewRepairReadyResponseSchema } from "./review-lifecycle-contracts";
export { ReviewRepairReadyResponseSchema } from "./review-lifecycle-contracts";
import { z } from "zod";

import { isDerivedReviewPath } from "./review-derived-paths";
import {
  hasPendingReviewAgentWrites,
  reviewThreadDbPath,
} from "./review-thread-store-backend";
import { fingerprintReviewTree } from "./review-tree-fingerprint";

const revisionSchema = z.string().regex(/^[0-9a-f]{40}$/);
export const ReviewRepairReadyRequestSchema = z.strictObject({
  reviewUuid: z.uuid(),
  stagingDir: z.string().min(1),
  expectedRecord: z.string().min(1),
  expectedFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  expectedThreadDbFingerprint: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  newDocumentRevision: revisionSchema,
  newMapRevision: revisionSchema.nullable(),
  sourceFallback: z.strictObject({ document: z.boolean(), map: z.boolean() }),
});
export type ReviewRepairReadyRequest = z.infer<
  typeof ReviewRepairReadyRequestSchema
>;

export type ReviewRepairReadyResponse = z.infer<
  typeof ReviewRepairReadyResponseSchema
>;

export async function fingerprintReviewRepairInputs(
  dir: string,
): Promise<string> {
  return fingerprintReviewTree(dir, {
    include: (relativePath) =>
      !isDerivedReviewPath(relativePath.split(path.sep)[0] ?? ""),
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
