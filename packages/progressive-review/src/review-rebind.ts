import type { Writable } from "node:stream";

import {
  changeIdentityForRevision,
  resolveRevision,
} from "@dev.fast/local-vcs";

import { type RunReviewScaffoldInput, repinReview } from "./review-scaffold";
import { resolveReviewRoot } from "./runtime";
import { resolvePublishReview } from "./server/publish-preparation";

/**
 * Move a review to a different unit of change and re-pin from it
 * immediately: the new head resolves, the fork point recomputes, and the
 * worktree and graph re-materialize. Publish never moves pins, so rebind
 * must finish the job itself.
 */
interface ReviewRebindJsonOutput {
  event: "rebound";
  uuid: string;
  change: string;
  warnings?: string[];
}

export async function runReviewRebind(input: {
  cwd: string;
  change: string;
  reviewUuid?: string;
  toolingRoot?: string;
  progress?: (message: string) => void;
  env?: NodeJS.ProcessEnv;
  stdout: Writable;
  createSourceAgentSession?: RunReviewScaffoldInput["createSourceAgentSession"];
}): Promise<number> {
  const reviewRoot = await resolveReviewRoot(input.cwd);
  const review = await resolvePublishReview(reviewRoot, input.reviewUuid);
  if (review.review.pullRequestNumber != null) {
    throw new Error(
      `Review ${review.review.uuid} is bound to a pull request. Re-bind is for moving branch-bound reviews; use \`review scaffold --update\` to re-fetch a PR review.`,
    );
  }
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
  const repinned = await repinReview(
    { dir: review.dir, review: record },
    {
      cwd: reviewRoot,
      toolingRoot: input.toolingRoot,
      progress: input.progress,
      env: input.env,
      createSourceAgentSession: input.createSourceAgentSession,
    },
  );
  const output: ReviewRebindJsonOutput = {
    event: "rebound",
    uuid: record.uuid,
    change: input.change,
  };
  if (repinned.warnings) output.warnings = repinned.warnings;
  input.stdout.write(`${JSON.stringify(output)}\n`);
  return 0;
}
