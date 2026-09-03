import { existsSync, rmSync } from "node:fs";
import { mkdir, rm, rmdir } from "node:fs/promises";
import path from "node:path";

import {
  git,
  gitCommonDir,
  jjRevisionIsConflicted,
  resolveRevision,
} from "@dev.fast/local-vcs";

import { isInsideDirectory } from "./review-paths";
import { removeReviewPrepareArtifacts } from "./review-prepare";
import {
  type ReviewCheckoutRole,
  legacyReviewWorktreesDir,
  reviewManagedCheckoutDir,
  reviewManagedCheckoutRoot,
  reviewManagedCheckoutsDir,
} from "./review-storage";

// A review renders the pinned code on the canvas, but file reads against the
// user's working tree see whatever is checked out there — including edits
// made after the pin. Materialize any pinned commit (the head, the base) as a
// detached, reusable git worktree beside the other dev-fast state in the
// shared git dir so review sessions and graph builds read immutable bytes,
// even when the working copy currently sits at the pinned commit. Returns the
// checkout path, or null when the ref cannot be resolved to a commit or the
// repo has no shared git dir.
export async function ensureReviewPinnedCheckout(input: {
  rootPath: string;
  ref: string;
  reviewUuid: string;
  role?: ReviewCheckoutRole;
}): Promise<string | null> {
  const target = await resolveReviewPinnedCheckout({
    ...input,
    role: input.role ?? "head",
  });
  if (!target) return null;
  await materializeReviewPinnedCheckout({
    rootPath: input.rootPath,
    ...target,
  });
  return target.checkoutPath;
}

async function resolveReviewPinnedCheckout(input: {
  rootPath: string;
  ref: string;
  reviewUuid: string;
  role: ReviewCheckoutRole;
}): Promise<{ checkoutPath: string; commit: string } | null> {
  const commit = await resolveReviewPinnedCommit(input.rootPath, input.ref);
  if (!commit) return null;
  const commonDir = await gitCommonDir(input.rootPath);
  if (!commonDir) return null;
  return {
    checkoutPath: reviewManagedCheckoutDir(
      commonDir,
      input.reviewUuid,
      input.role ?? "head",
      commit,
    ),
    commit,
  };
}

async function materializeReviewPinnedCheckout(input: {
  rootPath: string;
  checkoutPath: string;
  commit: string;
}): Promise<void> {
  const { checkoutPath } = input;
  if (await isWorktreeAt(input.rootPath, checkoutPath, input.commit)) {
    return;
  }
  // jj materializes conflict markers into the git export of a conflicted
  // revision, so a checkout of it would silently contain marker text instead
  // of code — and the graph would index that. Refuse with the remedy instead.
  if (await jjRevisionIsConflicted(input.rootPath, input.commit)) {
    throw new Error(
      `Review cannot pin conflicted revision ${input.commit.slice(0, 12)}: the jj change has unresolved conflicts. Resolve them (jj resolve), then scaffold again.`,
    );
  }
  // A stale registration (e.g. a manually gutted or deleted directory) blocks
  // re-adding the same path: drop both the registration and any leftover
  // directory before recreating the worktree. The tree is recreated bare, so
  // its prepare marker must not survive into the new directory's lifetime.
  await git(input.rootPath, ["worktree", "remove", "--force", checkoutPath], {
    allowFailure: true,
  });
  await git(input.rootPath, ["worktree", "prune"], { allowFailure: true });
  rmSync(checkoutPath, { recursive: true, force: true });
  await removeReviewPrepareArtifacts(checkoutPath);
  await mkdir(path.dirname(checkoutPath), { recursive: true });
  await git(input.rootPath, [
    "worktree",
    "add",
    "--detach",
    checkoutPath,
    input.commit,
  ]);
}

// Remove one review's pinned checkout — and only that: the path must lie
// under the dev-fast worktrees dir, so checkouts for other concurrent reviews
// (and anything else on disk) are never touched. Returns whether a checkout
// was actually removed.
export async function removeReviewPinnedCheckout(input: {
  rootPath: string;
  reviewUuid: string;
  checkoutPath: string;
}): Promise<boolean> {
  const commonDir = await gitCommonDir(input.rootPath);
  if (!commonDir) return false;
  const target = path.resolve(input.checkoutPath);
  if (
    !isInsideDirectory(
      target,
      reviewManagedCheckoutRoot(commonDir, input.reviewUuid),
    )
  ) {
    return false;
  }
  const existed = existsSync(target);
  await git(input.rootPath, ["worktree", "remove", "--force", target], {
    allowFailure: true,
  });
  await git(input.rootPath, ["worktree", "prune"], { allowFailure: true });
  rmSync(target, { recursive: true, force: true });
  await removeReviewPrepareArtifacts(target);
  return existed;
}

/** Remove all persistent checkouts for one deleted Review. */
export async function removeReviewManagedCheckouts(input: {
  rootPath: string;
  reviewUuid: string;
}): Promise<number> {
  const commonDir = await gitCommonDir(input.rootPath);
  if (!commonDir) return 0;
  const reviewRoot = reviewManagedCheckoutRoot(commonDir, input.reviewUuid);
  const worktrees = await listRegisteredWorktrees(input.rootPath);
  let removed = 0;
  for (const worktree of worktrees) {
    if (!isInsideDirectory(worktree.worktreePath, reviewRoot)) continue;
    await git(
      input.rootPath,
      ["worktree", "remove", "--force", worktree.worktreePath],
      { allowFailure: true },
    );
    removed += 1;
  }
  await git(input.rootPath, ["worktree", "prune"], { allowFailure: true });
  await rm(reviewRoot, { recursive: true, force: true });
  return removed;
}

/** Remove commit-owned checkouts from releases before Review ownership. */
export async function removeLegacyReviewCheckouts(input: {
  rootPath: string;
  onBlocker?: (message: string) => void;
}): Promise<number> {
  const commonDir = await gitCommonDir(input.rootPath);
  if (!commonDir) return 0;
  const legacyRoot = legacyReviewWorktreesDir(commonDir);
  const worktrees = await listRegisteredWorktrees(input.rootPath);
  let removed = 0;
  for (const worktree of worktrees) {
    if (!isInsideDirectory(worktree.worktreePath, legacyRoot)) continue;
    if (!isManagedLegacyReviewWorktree(worktree, legacyRoot)) {
      input.onBlocker?.(
        `Legacy checkout ${worktree.worktreePath} was not removed because it does not match the managed commit checkout layout.`,
      );
      continue;
    }
    // The path is a registered, commit-owned checkout inside our legacy
    // namespace. Force is safe because users cannot write through Review.
    const removal = await git(
      input.rootPath,
      ["worktree", "remove", "--force", worktree.worktreePath],
      { allowFailure: true },
    );
    if (!removal.ok) {
      const detail = removal.stderr.trim() || removal.stdout.trim();
      input.onBlocker?.(
        `Legacy checkout ${worktree.worktreePath} could not be removed${detail ? `: ${detail}` : "."}`,
      );
      continue;
    }
    removed += 1;
  }
  const prune = await git(input.rootPath, ["worktree", "prune"], {
    allowFailure: true,
  });
  if (!prune.ok) {
    const detail = prune.stderr.trim() || prune.stdout.trim();
    input.onBlocker?.(
      `Legacy checkout registrations were not pruned${detail ? `: ${detail}` : "."}`,
    );
  }
  // Remove only an empty container. Keep any unregistered files for manual
  // inspection instead of deleting them recursively.
  await rmdir(legacyRoot).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY") throw error;
  });
  return removed;
}

/** Infer the owning Review from any path inside its managed checkout. */
export async function reviewUuidForManagedCheckout(
  cwd: string,
): Promise<string | null> {
  const commonDir = await gitCommonDir(cwd).catch(() => null);
  if (!commonDir) return null;
  const relative = path.relative(
    reviewManagedCheckoutsDir(commonDir),
    path.resolve(cwd),
  );
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return null;
  }
  const [reviewUuid, role, commit] = relative.split(path.sep);
  if (!reviewUuid || !isReviewUuid(reviewUuid)) return null;
  if (role !== "head" && role !== "base") return null;
  if (!commit) return null;
  return reviewUuid;
}

// Resolve a pinned ref to a commit. Prefer the jj-first local-vcs
// resolution (worktree-aware for HEAD/@ and branch names); fall back to git
// against the shared git dir for refs only the backing store knows, like the
// pinned refs/dev-fast/reviews/pr-N/head in a non-colocated jj workspace.
async function resolveReviewPinnedCommit(
  rootPath: string,
  ref: string,
): Promise<string | null> {
  const resolved = await resolveRevision(rootPath, ref).catch(() => null);
  if (resolved) return resolved.commit;
  const fromGitDir = await git(
    rootPath,
    ["rev-parse", "--verify", `${ref}^{commit}`],
    { allowFailure: true },
  ).catch(() => null);
  if (!fromGitDir?.ok) return null;
  return fromGitDir.stdout.trim() || null;
}

// A checkout is reusable only when git still registers a worktree at that
// path, its HEAD is the wanted commit, and the directory has not been gutted
// on disk (its .git link is the marker git itself relies on).
async function isWorktreeAt(
  rootPath: string,
  checkoutPath: string,
  commit: string,
): Promise<boolean> {
  if (!existsSync(path.join(checkoutPath, ".git"))) return false;
  const list = await git(rootPath, ["worktree", "list", "--porcelain"], {
    allowFailure: true,
  }).catch(() => null);
  if (!list?.ok) return false;
  return parseWorktreeList(list.stdout).some(
    (entry) =>
      path.resolve(entry.worktreePath) === path.resolve(checkoutPath) &&
      entry.headCommit === commit,
  );
}

function parseWorktreeList(
  output: string,
): Array<{ worktreePath: string; headCommit: string | null }> {
  const entries: Array<{ worktreePath: string; headCommit: string | null }> =
    [];
  for (const block of output.split(/\n\n+/)) {
    let worktreePath: string | null = null;
    let headCommit: string | null = null;
    for (const line of block.split("\n")) {
      if (line.startsWith("worktree ")) {
        worktreePath = line.slice("worktree ".length);
      } else if (line.startsWith("HEAD ")) {
        headCommit = line.slice("HEAD ".length);
      }
    }
    if (worktreePath) entries.push({ worktreePath, headCommit });
  }
  return entries;
}

async function listRegisteredWorktrees(
  rootPath: string,
): Promise<Array<{ worktreePath: string; headCommit: string | null }>> {
  const listed = await git(rootPath, ["worktree", "list", "--porcelain"], {
    allowFailure: true,
  }).catch(() => null);
  return listed?.ok ? parseWorktreeList(listed.stdout) : [];
}

function isManagedLegacyReviewWorktree(
  worktree: { worktreePath: string; headCommit: string | null },
  legacyRoot: string,
): boolean {
  const relative = path.relative(
    path.resolve(legacyRoot),
    path.resolve(worktree.worktreePath),
  );
  if (relative.includes(path.sep) || !/^[0-9a-f]{12}$/iu.test(relative)) {
    return false;
  }
  return worktree.headCommit?.startsWith(relative.toLowerCase()) ?? false;
}

function isReviewUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    value,
  );
}
