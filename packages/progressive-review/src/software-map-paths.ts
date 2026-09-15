import path from "node:path";

import { safeStorageSegment } from "./review-home-paths";

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
