import path from "node:path";
import type { Writable } from "node:stream";

import {
  changeIdentityForRevision,
  resolveRevision,
} from "@dev.fast/local-vcs";

import { repinReview } from "./review-scaffold";
import { resolveReviewRoot } from "./runtime";
import { writePrivateJsonAtomic } from "./server/desktop-paths";
import { resolvePublishReview } from "./server/publish-preparation";

/**
 * Move a review to a different unit of change and re-pin from it
 * immediately: the new head resolves, the fork point recomputes, and the
 * worktree and graph re-materialize. Publish never moves pins, so rebind
 * must finish the job itself.
 */
export async function runReviewRebind(input: {
  cwd: string;
  change: string;
  reviewUuid?: string;
  toolingRoot?: string;
  progress?: (message: string) => void;
  env?: NodeJS.ProcessEnv;
  stdout: Writable;
}): Promise<number> {
  const reviewRoot = await resolveReviewRoot(input.cwd);
  const review = await resolvePublishReview(reviewRoot, input.reviewUuid);
  const resolved = await resolveRevision(
    review.review.worktreePath,
    input.change,
  );
  if (!resolved) {
    throw new Error(
      `Change does not resolve in ${review.review.worktreePath}: ${input.change}`,
    );
  }
  const sourceIdentity = await changeIdentityForRevision(
    review.review.worktreePath,
    input.change,
  );
  if (!sourceIdentity) {
    throw new Error(`Change does not resolve to one identity: ${input.change}`);
  }
  const record = { ...review.review, sourceIdentity };
  await writePrivateJsonAtomic(path.join(review.dir, "review.json"), record);
  const repinned = await repinReview(
    { dir: review.dir, review: record },
    {
      cwd: reviewRoot,
      toolingRoot: input.toolingRoot,
      progress: input.progress,
      env: input.env,
    },
  );
  input.stdout.write(
    `${JSON.stringify({
      event: "rebound",
      uuid: record.uuid,
      change: input.change,
      ...(repinned.warnings ? { warnings: repinned.warnings } : {}),
    })}\n`,
  );
  return 0;
}
