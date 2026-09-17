import fs from "node:fs";
import path from "node:path";

import { currentHead, resolveRevision } from "@dev.fast/local-vcs";
import { parseJsonText } from "@dev.fast/review-protocol";

import { type ReviewCheckoutRole } from "./review-checkout-paths";
import { ensureReviewPinnedCheckout } from "./review-head-checkout";
import {
  type StoredReviewRecord,
  safeParseStoredReviewRecord,
} from "./review-home";

export interface PreparedReviewSourceTarget {
  ref: string;
  sourceRootPath: string;
}

export interface ReviewSourceTarget {
  repoRoot: string;
  headRef?: string;
  baseRef?: string;
  sourceRootPath: string;
  diffRootPath: string;
  preparedBase?: PreparedReviewSourceTarget;
}

export async function resolveReviewSourceTarget(input: {
  reviewRootPath: string;
}): Promise<ReviewSourceTarget> {
  const review = readReviewStoreRecord(input.reviewRootPath);
  const repoRoot = resolveReviewRepoRootFromStore(input.reviewRootPath, review);

  const headRef = review.sourceCommit
    ? await resolveRevisionCommit(repoRoot, review.sourceCommit)
    : await resolveDefaultReviewHeadRef(repoRoot);

  const baseRef = review.baseCommit;

  if (!headRef) {
    return {
      repoRoot,
      sourceRootPath: repoRoot,
      diffRootPath: repoRoot,
      baseRef,
    };
  }

  const sourceRootPath = await ensurePinnedReviewWorktreeAtCommit({
    repoRoot,
    commit: headRef,
    reviewUuid: review.uuid,
    role: "head",
  });

  const preparedBase =
    baseRef && baseRef !== headRef
      ? await preparedBaseTarget(repoRoot, review.uuid, baseRef)
      : baseRef === headRef
        ? { ref: headRef, sourceRootPath }
        : undefined;

  return {
    repoRoot,
    headRef,
    baseRef,
    sourceRootPath,
    diffRootPath: repoRoot,
    preparedBase,
  };
}

async function preparedBaseTarget(
  repoRoot: string,
  reviewUuid: string,
  baseRef: string,
): Promise<PreparedReviewSourceTarget> {
  const ref = await resolveRevisionCommit(repoRoot, baseRef);

  return {
    ref,
    sourceRootPath: await ensurePinnedReviewWorktreeAtCommit({
      repoRoot,
      commit: ref,
      reviewUuid,
      role: "base",
    }),
  };
}

async function ensurePinnedReviewWorktreeAtCommit(input: {
  repoRoot: string;
  commit: string;
  reviewUuid: string;
  role: ReviewCheckoutRole;
}): Promise<string> {
  const sourceRootPath = await ensureReviewPinnedCheckout({
    rootPath: input.repoRoot,
    ref: input.commit,
    reviewUuid: input.reviewUuid,
    role: input.role,
  });

  if (!sourceRootPath) {
    throw new Error(
      `Cannot materialize a pinned worktree for ${input.commit} in ${input.repoRoot}.`,
    );
  }

  return sourceRootPath;
}

async function resolveDefaultReviewHeadRef(
  repoRoot: string,
): Promise<string | undefined> {
  return currentHead(repoRoot).then((head) => head?.commit);
}

export async function resolveReviewSessionBaseCommit(input: {
  reviewRootPath: string;
}): Promise<string | null> {
  const review = readReviewStoreRecord(input.reviewRootPath);
  const repoRoot = resolveReviewRepoRootFromStore(input.reviewRootPath, review);

  return resolveRevisionCommit(repoRoot, review.baseCommit);
}

export function resolveReviewRepoRootFromStore(
  reviewRootPath: string,
  review = readReviewStoreRecord(reviewRootPath),
): string {
  const worktreePath = review.worktreePath;
  const resolvedWorktreePath = path.resolve(worktreePath);

  if (!fs.existsSync(resolvedWorktreePath)) {
    throw new Error(
      `Review worktree ${resolvedWorktreePath} no longer exists.`,
    );
  }

  return resolvedWorktreePath;
}

export function readReviewStoreRecord(
  reviewRootPath: string,
): StoredReviewRecord {
  const storePath = path.resolve(reviewRootPath);

  try {
    const value = parseJsonText(
      fs.readFileSync(path.join(storePath, "review.json"), "utf8"),
    );

    const parsed = safeParseStoredReviewRecord(value);

    if (!parsed.success) throw parsed.error;

    return parsed.data;
  } catch {
    throw new Error(`Review store ${storePath} has no readable review.json.`);
  }
}

async function resolveRevisionCommit(
  repoRoot: string,
  commit: string,
): Promise<string> {
  const resolved = await resolveRevision(repoRoot, commit);

  if (!resolved) throw new Error(`Revision does not exist: ${commit}`);

  return resolved.commit;
}
