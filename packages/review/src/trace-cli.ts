import type { Writable } from "node:stream";

import type { ReviewApiSummary } from "@dev.fast/review-protocol";
import {
  type TraceListScope,
  type TracePullScope,
  type TraceReviewScope,
  errorMessage,
  runTraceList as listWithScope,
  runTracePull as pullWithScope,
  resolveTraceReadStorage,
} from "@dev.fast/trace-core";
import type { TraceStorageKind } from "@dev.fast/trace-core";

import { runReviewInfo } from "./review-info";

/**
 * The Review app's trace commands. It resolves `--review <uuid>` (or the
 * Review that owns the current checkout) against the Review store and hands
 * the change range to the store-free read commands as a value.
 */

export {
  runTraceDisable,
  runTraceEnable,
  runTraceGitHook,
  runTraceHook,
  runTraceRepair,
  runTraceStatus,
  runTraceSync,
  type TraceListScope,
  type TracePullScope,
  type TraceReviewScope,
  runTraceBlame,
  runTraceLookupCommit,
  runTraceLookupSession,
  runTraceShow,
} from "@dev.fast/trace-core";

export async function resolveTraceReviewScope(
  cwd: string,
  reviewUuid: string | undefined,
): Promise<TraceReviewScope> {
  const review = await resolveTraceReview(cwd, reviewUuid);

  if (!review.repositoryPath || !review.pins)
    throw new Error("Review repository is unavailable.");

  return {
    uuid: review.reviewId,
    repoRoot: review.repositoryPath,
    baseCommit: review.pins.base,
    headCommit: review.pins.head,
  };
}

export async function runTraceList(input: {
  cwd: string;
  reviewUuid?: string;
  commitSha?: string;
  storage?: TraceStorageKind;
  json?: boolean;
  stdout: Writable;
}): Promise<number> {
  const resolvedStorage = await resolveTraceReadStorage(
    input.storage,
    input.cwd,
  );
  // Without --commit the command lists the Review's range, so a missing
  // --review still resolves the Review that owns this checkout.

  const scope: TraceListScope = input.commitSha
    ? { commit: input.commitSha }
    : { review: await resolveTraceReviewScope(input.cwd, input.reviewUuid) };

  return listWithScope({
    cwd: input.cwd,
    scope,
    resolvedStorage,
    json: input.json,
    stdout: input.stdout,
  });
}

export async function runTracePull(input: {
  cwd: string;
  repo?: string;
  reviewUuid?: string;
  commitSha?: string;
  session?: string;
  mainOnly?: boolean;
  storage?: TraceStorageKind;
  json?: boolean;
  stdout: Writable;
  stderr: Writable;
}): Promise<number> {
  try {
    const resolvedStorage = await resolveTraceReadStorage(
      input.storage,
      input.cwd,
    );

    const scope = await resolveTracePullScope(input);

    return pullWithScope({
      cwd: input.cwd,
      scope,
      repo: input.repo,
      mainOnly: input.mainOnly,
      resolvedStorage,
      json: input.json,
      stdout: input.stdout,
      stderr: input.stderr,
    });
  } catch (error) {
    input.stderr.write(`trace pull error: ${errorMessage(error)}\n`);

    return 1;
  }
}

async function resolveTracePullScope(input: {
  cwd: string;
  reviewUuid?: string;
  commitSha?: string;
  session?: string;
}): Promise<TracePullScope> {
  if (input.reviewUuid) {
    return {
      review: await resolveTraceReviewScope(input.cwd, input.reviewUuid),
    };
  }

  if (input.commitSha) return { commit: input.commitSha };

  if (input.session) return { session: input.session };

  return { repository: true };
}

async function resolveTraceReview(
  cwd: string,
  reviewUuid: string | undefined,
): Promise<ReviewApiSummary> {
  const candidates = (await runReviewInfo({ cwd, reviewUuid })).reviews;

  if (candidates.length === 0) {
    throw new Error("No review found for this worktree.");
  }

  if (candidates.length > 1) {
    throw new Error("Multiple Whiteboards require --session <uuid>.");
  }

  return candidates[0];
}
