import path from "node:path";

import { ReviewStatusSchema } from "@dev.fast/review-protocol";
import { z } from "zod";

import { isDerivedReviewPath } from "./review-derived-paths";
import { fingerprintReviewTree } from "./review-tree-fingerprint";

const revisionSchema = z.string().regex(/^[0-9a-f]{40}$/);

export const ReviewRepairReadyRequestSchema = z.strictObject({
  reviewUuid: z.uuid(),
  stagingDir: z.string().min(1),
  expectedRecord: z.string().min(1),
  expectedFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  newDocumentRevision: revisionSchema,
  newMapRevision: revisionSchema.nullable(),
  sourceFallback: z.strictObject({ document: z.boolean(), map: z.boolean() }),
});

export type ReviewRepairReadyRequest = z.infer<
  typeof ReviewRepairReadyRequestSchema
>;

export const ReviewRepairReadyResponseSchema = z.strictObject({
  ok: z.literal(true),
  status: ReviewStatusSchema,
  oldDocumentRevision: z.string().min(1).nullable(),
  oldMapRevision: z.string().min(1).nullable(),
  newDocumentRevision: revisionSchema,
  newMapRevision: revisionSchema.nullable(),
  sessionId: z.string().min(1),
  url: z.string().min(1),
});

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
