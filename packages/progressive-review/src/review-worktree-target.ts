import fs from "node:fs";
import path from "node:path";

import {
  currentHead,
  defaultBase,
  devfastPrepareCommands,
  gitCommonDir,
  resolveRevision,
} from "@dev.fast/local-vcs";

import { ensureReviewPinnedCheckout } from "./review-head-checkout";
import {
  type StoredReviewRecord,
  safeParseStoredReviewRecord,
} from "./review-home";
import {
  markerMatches,
  prepareReviewPinnedCheckout,
  reviewPrepareCommandsHash,
  reviewPrepareMarkerPath,
  spawnReviewPrepareBackground,
} from "./review-prepare";
import {
  type ReviewCheckoutRole,
  reviewManagedCheckoutDir,
} from "./review-storage";
import { span } from "./startup-trace";

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
  warning?: (message: string) => void;
}): Promise<ReviewSourceTarget> {
  const review = readReviewStoreRecord(input.reviewRootPath);
  const repoRoot = resolveReviewRepoRootFromStore(input.reviewRootPath);
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
    warning: input.warning,
  });
  const preparedBase =
    baseRef && baseRef !== headRef
      ? await prepareReviewSourceTargetForRef({
          reviewRootPath: input.reviewRootPath,
          repoRoot,
          ref: baseRef,
          role: "base",
          warning: input.warning,
        })
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

export async function prepareReviewSourceTargetForRef(input: {
  reviewRootPath: string;
  repoRoot: string;
  ref: string;
  role?: ReviewCheckoutRole;
  warning?: (message: string) => void;
}): Promise<PreparedReviewSourceTarget> {
  const ref = await resolveRevisionCommit(input.repoRoot, input.ref);
  const sourceRootPath = await ensurePinnedReviewWorktreeAtCommit({
    repoRoot: input.repoRoot,
    commit: ref,
    reviewUuid: readReviewStoreRecord(input.reviewRootPath).uuid,
    role: input.role ?? "base",
    warning: input.warning,
  });
  return { ref, sourceRootPath };
}

export interface EnsurePinnedReviewWorktreeInput {
  repoRoot: string;
  commit: string;
  reviewUuid: string;
  role: ReviewCheckoutRole;
  warning?: (message: string) => void;
  background?: boolean;
  cliEntryPath?: string;
}

export async function ensurePinnedReviewWorktreeAtCommit(
  input: EnsurePinnedReviewWorktreeInput,
): Promise<string> {
  const sourceRootPath = await span(
    "ensureReviewPinnedCheckout",
    () =>
      ensureReviewPinnedCheckout({
        rootPath: input.repoRoot,
        ref: input.commit,
        reviewUuid: input.reviewUuid,
        role: input.role,
      }),
    `${input.commit} -> ${input.repoRoot}`,
  );
  if (!sourceRootPath) {
    throw new Error(
      `Cannot materialize a pinned worktree for ${input.commit} in ${input.repoRoot}.`,
    );
  }

  const commands = await devfastPrepareCommands(input.repoRoot).catch(
    () => [] as string[],
  );
  if (commands.length === 0) {
    return sourceRootPath;
  }

  const markerPath = reviewPrepareMarkerPath(sourceRootPath);
  const expectedHash = reviewPrepareCommandsHash(commands);
  const alreadyPrepared = await markerMatches(markerPath, expectedHash).catch(
    () => false,
  );
  if (alreadyPrepared) {
    return sourceRootPath;
  }

  if (input.background !== false) {
    spawnReviewPrepareBackground({
      checkoutPath: sourceRootPath,
      commit: input.commit,
      cliEntryPath: input.cliEntryPath,
    });
    return sourceRootPath;
  }

  await span(
    "prepareReviewPinnedCheckout",
    () =>
      prepareReviewPinnedCheckout({
        checkoutPath: sourceRootPath,
        commit: input.commit,
        commands,
        warning: input.warning,
      }),
    `${input.commit} -> ${sourceRootPath}`,
  );
  return sourceRootPath;
}

export async function pinnedSourceRootPath(
  repoRoot: string,
  reviewUuid: string,
  role: ReviewCheckoutRole,
  commit: string,
): Promise<string> {
  const commonDir = await gitCommonDir(repoRoot).catch(() => null);
  if (!commonDir) {
    throw new Error(
      `Cannot pin a source worktree for ${commit}: repository ${repoRoot} has no shared git directory.`,
    );
  }
  return reviewManagedCheckoutDir(commonDir, reviewUuid, role, commit);
}

export async function resolveDefaultReviewHeadRef(
  repoRoot: string,
): Promise<string | undefined> {
  return currentHead(repoRoot).then((head) => head?.commit);
}

export async function resolveDefaultReviewBaseRef(
  repoRoot: string,
  headRef: string,
): Promise<string | undefined> {
  return defaultBase({ rootPath: repoRoot, headRef }).then(
    (base) => base?.commit,
  );
}

export async function resolveReviewSessionBaseCommit(input: {
  reviewRootPath: string;
}): Promise<string | null> {
  const review = readReviewStoreRecord(input.reviewRootPath);
  const repoRoot = resolveReviewRepoRootFromStore(input.reviewRootPath);
  return resolveRevisionCommit(repoRoot, review.baseCommit);
}

export function resolveReviewRepoRootFromStore(reviewRootPath: string): string {
  const worktreePath = readReviewStoreRecord(reviewRootPath).worktreePath;
  const resolvedWorktreePath = path.resolve(worktreePath);
  if (!fs.existsSync(resolvedWorktreePath)) {
    throw new Error(
      `Review worktree ${resolvedWorktreePath} no longer exists; run review rebind from the repo checkout or scaffold a new review.`,
    );
  }
  return resolvedWorktreePath;
}

export function readReviewStoreRecord(
  reviewRootPath: string,
): StoredReviewRecord {
  const storePath = path.resolve(reviewRootPath);
  try {
    const value: unknown = JSON.parse(
      fs.readFileSync(path.join(storePath, "review.json"), "utf8"),
    );
    const parsed = safeParseStoredReviewRecord(value);
    if (!parsed.success) throw parsed.error;
    return parsed.data;
  } catch {
    throw new Error(
      `Review store ${storePath} has no readable review.json; re-scaffold the review.`,
    );
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
