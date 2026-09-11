import type { Writable } from "node:stream";

import { resolveAuthoringSessionRef } from "./authoring-session";
import { requestReviewLifecycle } from "./review-lifecycle-client";
import { ReviewRebindResultSchema } from "./review-lifecycle-contracts";
import type { RunReviewScaffoldInput } from "./review-scaffold";

/**
 * Move a review to a different unit of change and re-pin from it
 * immediately: the new head resolves, the fork point recomputes, and the
 * worktree and graph re-materialize. Publish never moves pins, so rebind
 * must finish the job itself.
 */
export interface ReviewRebindJsonOutput {
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
  const output = ReviewRebindResultSchema.parse(
    await requestReviewLifecycle("/lifecycle/rebind", {
      cwd: input.cwd,
      reviewUuid: input.reviewUuid,
      change: input.change,
      agent: resolveAuthoringSessionRef(input.env ?? process.env),
    }),
  );

  input.stdout.write(`${JSON.stringify(output)}\n`);

  return 0;
}
