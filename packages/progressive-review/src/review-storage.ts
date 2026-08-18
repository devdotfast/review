import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { readReviewComments } from "./review-state-store";

export const DEV_REVIEW_HOME_ENV = "DEV_REVIEW_HOME";

export function devReviewHome(): string {
  return path.resolve(
    process.env[DEV_REVIEW_HOME_ENV] ?? path.join(os.homedir(), ".dev"),
  );
}

export function reviewRepoStorageRoot(rootPath: string): string {
  const resolvedRoot = path.resolve(rootPath);
  const basename = safeStorageSegment(path.basename(resolvedRoot) || "repo");
  const hash = crypto
    .createHash("sha256")
    .update(resolvedRoot)
    .digest("hex")
    .slice(0, 12);
  return path.join(devReviewHome(), "repos", `${basename}-${hash}`);
}

// ---------------------------------------------------------------------------
// Git-notes-native software-map storage
// ---------------------------------------------------------------------------
// Per-commit map artifacts are git notes under refs/notes/dev-fast/*; scratch
// buffers and all derived caches live inside the repository's shared git
// directory ($GIT_COMMON_DIR/dev-fast/), so every worktree of a repo shares
// one store and nothing map-related lives in the home directory. Notes are
// the only durable map state: a scratch is a disposable, commit-addressed
// working copy of one commit's note.

export const SOFTWARE_MAP_NOTES_REF = "refs/notes/dev-fast/software-map";

export const SOFTWARE_MAP_FILE_NAME = "software-map.ts";

/** dev.fast's private directory inside a repo's shared git dir. */
export function devFastGitDir(gitCommonDir: string): string {
  return path.join(gitCommonDir, "dev-fast");
}

/**
 * The scratch buffer directory for one commit's map. The path itself names
 * the target commit, so scratches for parallel reviews coexist.
 */
export function scratchSoftwareMapDir(
  gitCommonDir: string,
  commit: string,
): string {
  return path.join(
    devFastGitDir(gitCommonDir),
    "scratch",
    safeStorageSegment(commit),
  );
}

export type ReviewCheckoutRole = "head" | "base";

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

/**
 * Where note contents are materialized as importable modules for the
 * document bundler.
 * Purely derived cache: every byte is reproducible from the notes refs.
 */
export function materializedSoftwareMapDir(
  gitCommonDir: string,
  commit: string,
): string {
  return path.join(
    devFastGitDir(gitCommonDir),
    "materialized",
    safeStorageSegment(commit),
  );
}

export function safeStorageSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]+/g, "__");
}

/** Count open comment threads stored for a UUID Review directory. */
export function readOpenReviewThreadCount(reviewDir: string): number {
  const threads = readReviewComments(path.join(reviewDir, "review.mdx"));
  return Object.values(threads).filter((thread) => thread.status === "open")
    .length;
}
