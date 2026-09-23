import { existsSync, rmSync } from "node:fs";
import { mkdir, rm, rmdir } from "node:fs/promises";
import path from "node:path";

import {
  git,
  gitCommonDir,
  jjRevisionIsConflicted,
  resolveRevision,
} from "@dev.fast/local-vcs";
import { withFileLock } from "@dev.fast/trace-core";

import {
  type WhiteboardCheckoutRole,
  legacyWhiteboardWorktreesDir,
  whiteboardManagedCheckoutDir,
  whiteboardManagedCheckoutRoot,
  whiteboardManagedCheckoutsDir,
} from "./whiteboard-checkout-paths";
import { removeWhiteboardPrepareArtifacts } from "./whiteboard-prepare.js";

// A review renders the pinned code on the canvas, but file reads against the
// user's working tree see whatever is checked out there — including edits
// made after the pin. Materialize any pinned commit (the head, the base) as a
// detached, reusable git worktree beside the other dev-fast state in the
// shared git dir so review sessions and graph builds read immutable bytes,
// even when the working copy currently sits at the pinned commit. Returns the
// checkout path, or null when the ref cannot be resolved to a commit or the
// repo has no shared git dir.
export async function ensureWhiteboardPinnedCheckout(input: {
  rootPath: string;
  ref: string;
  sessionId: string;
  role?: WhiteboardCheckoutRole;
}): Promise<string | null> {
  const target = await resolveWhiteboardPinnedCheckout({
    ...input,
    role: input.role ?? "head",
  });

  if (!target) return null;

  const prepared = await withFileLock(
    `${target.checkoutPath}.prepare-lock`,
    {
      retryMs: 20,
      timeoutMs: 30_000,
      staleMs: 120_000,
      heartbeatMs: 5_000,
      unownedGraceMs: 1_000,
    },
    () =>
      materializeWhiteboardPinnedCheckout({
        rootPath: input.rootPath,
        ...target,
      }),
  );

  if (!prepared.acquired)
    throw new Error(
      `Pinned checkout ${target.commit} is busy; retry the operation.`,
    );

  return target.checkoutPath;
}

async function resolveWhiteboardPinnedCheckout(input: {
  rootPath: string;
  ref: string;
  sessionId: string;
  role: WhiteboardCheckoutRole;
}): Promise<{ checkoutPath: string; commit: string } | null> {
  const commit = await resolveWhiteboardPinnedCommit(input.rootPath, input.ref);

  if (!commit) return null;
  const commonDir = await gitCommonDir(input.rootPath);

  if (!commonDir) return null;

  return {
    checkoutPath: whiteboardManagedCheckoutDir(
      commonDir,
      input.sessionId,
      input.role ?? "head",
      commit,
    ),
    commit,
  };
}

async function materializeWhiteboardPinnedCheckout(input: {
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
      `Review cannot pin conflicted revision ${input.commit.slice(0, 12)}: the jj change has unresolved conflicts. Resolve them (jj resolve), then re-pin the review.`,
    );
  }

  // A stale registration (e.g. a manually gutted or deleted directory) blocks
  // re-adding the same path: drop both the registration and any leftover
  // directory before recreating the worktree.
  await git(input.rootPath, ["worktree", "remove", "--force", checkoutPath], {
    allowFailure: true,
  });
  await git(input.rootPath, ["worktree", "prune"], { allowFailure: true });
  rmSync(checkoutPath, { recursive: true, force: true });
  await removeWhiteboardPrepareArtifacts(checkoutPath);
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
export async function removeWhiteboardPinnedCheckout(input: {
  rootPath: string;
  sessionId: string;
  checkoutPath: string;
}): Promise<boolean> {
  const commonDir = await gitCommonDir(input.rootPath);

  if (!commonDir) return false;
  const target = path.resolve(input.checkoutPath);

  if (
    !isInsideDirectory(
      target,
      whiteboardManagedCheckoutRoot(commonDir, input.sessionId),
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
  await removeWhiteboardPrepareArtifacts(target);

  return existed;
}

/** Remove all persistent checkouts for one deleted Review. */
export async function removeWhiteboardManagedCheckouts(input: {
  rootPath: string;
  sessionId: string;
}): Promise<number> {
  const commonDir = await gitCommonDir(input.rootPath);

  if (!commonDir) return 0;

  const whiteboardRoot = whiteboardManagedCheckoutRoot(
    commonDir,
    input.sessionId,
  );

  const worktrees = await listRegisteredWorktrees(input.rootPath);
  let removed = 0;

  for (const worktree of worktrees) {
    if (!isInsideDirectory(worktree.worktreePath, whiteboardRoot)) continue;
    await git(
      input.rootPath,
      ["worktree", "remove", "--force", worktree.worktreePath],
      { allowFailure: true },
    );
    removed += 1;
  }

  await git(input.rootPath, ["worktree", "prune"], { allowFailure: true });
  await rm(whiteboardRoot, { recursive: true, force: true });

  return removed;
}

/** Remove commit-owned checkouts from releases before Review ownership. */
export async function removeLegacyWhiteboardCheckouts(input: {
  rootPath: string;
  onBlocker?: (message: string) => void;
}): Promise<number> {
  const commonDir = await gitCommonDir(input.rootPath);

  if (!commonDir) return 0;
  const legacyRoot = legacyWhiteboardWorktreesDir(commonDir);
  const worktrees = await listRegisteredWorktrees(input.rootPath);
  let removed = 0;

  for (const worktree of worktrees) {
    if (!isInsideDirectory(worktree.worktreePath, legacyRoot)) continue;

    if (!isManagedLegacyWhiteboardWorktree(worktree, legacyRoot)) {
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
export async function whiteboardUuidForManagedCheckout(
  cwd: string,
): Promise<string | null> {
  const commonDir = await gitCommonDir(cwd).catch(() => null);

  if (!commonDir) return null;

  const relative = path.relative(
    whiteboardManagedCheckoutsDir(commonDir),
    path.resolve(cwd),
  );

  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return null;
  }

  const [sessionId, role, commit] = relative.split(path.sep);

  if (!sessionId || !isWhiteboardUuid(sessionId)) return null;

  if (role !== "head" && role !== "base") return null;

  if (!commit) return null;

  return sessionId;
}

// Resolve a pinned ref to a commit. Prefer the jj-first local-vcs
// resolution (worktree-aware for HEAD/@ and branch names); fall back to git
// against the shared git dir for refs only the backing store knows, like the
// pinned refs/dev-fast/reviews/pr-N/head in a non-colocated jj workspace.
async function resolveWhiteboardPinnedCommit(
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

function isManagedLegacyWhiteboardWorktree(
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

function isWhiteboardUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    value,
  );
}

function isInsideDirectory(filePath: string, directory: string): boolean {
  const relative = path.relative(directory, filePath);

  return (
    Boolean(relative) &&
    !relative.startsWith("..") &&
    !path.isAbsolute(relative)
  );
}
