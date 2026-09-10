import fs, { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";

import * as git from "isomorphic-git";

/**
 * Test-only reproduction of the private-Git writers Reviews once had. Nothing
 * in production seals a Review any more, so tests that need a Git-era review
 * directory to read back through `reviewVcs.log`/`resolve`/`materialize` build
 * one here — none of which this module touches.
 */
const REVIEW_BRANCH = "refs/heads/main";
const REVIEW_AUTHOR = {
  name: "dev.fast Review",
  email: "review@dev.fast",
};

/** The `.gitignore` `createReviewDir` wrote in the Git era: the thread database
 * and its sqlite sidecars, plus `.build/` materializations, had to stay out of
 * sealed revisions. */
const LEGACY_REVIEW_GITIGNORE = [
  ".build/",
  "review.db",
  "review.db-wal",
  "review.db-shm",
  "",
].join("\n");

export async function initLegacyReviewRepo(dir: string): Promise<void> {
  await git.init({ fs, dir, defaultBranch: "main" });
}

/**
 * Seals a Review directory the way the Git era did while `createReviewDir`
 * still initialized a repository: the first seal creates the repository and its
 * `.gitignore`, so a test that starts from `createReviewDir` still produces a
 * Git-era review tree to import or repair from.
 */
export async function sealLegacyReviewCandidate(
  dir: string,
  message: string,
  options: { timestamp?: number } = {},
): Promise<string> {
  if (!existsSync(path.join(dir, ".git"))) {
    await initLegacyReviewRepo(dir);
    await writeFile(
      path.join(dir, ".gitignore"),
      LEGACY_REVIEW_GITIGNORE,
      "utf8",
    );
  }
  return sealLegacyReviewCommit(dir, message, options);
}

export async function sealLegacyReviewCommit(
  dir: string,
  message: string,
  options: { timestamp?: number } = {},
): Promise<string> {
  await stageWorkingTree(dir);
  const parent = await resolveHead(dir);
  const timestamp = options.timestamp ?? Math.floor(Date.now() / 1_000);
  return git.commit({
    fs,
    dir,
    ref: REVIEW_BRANCH,
    parent: parent ? [parent] : [],
    message,
    author: { ...REVIEW_AUTHOR, timestamp },
    committer: { ...REVIEW_AUTHOR, timestamp },
  });
}

async function stageWorkingTree(dir: string): Promise<void> {
  const rows = await git.statusMatrix({ fs, dir });
  await Promise.all(
    rows.map(([filepath, , worktreeStatus]) =>
      worktreeStatus === 0
        ? git.remove({ fs, dir, filepath })
        : git.add({ fs, dir, filepath }),
    ),
  );
}

async function resolveHead(dir: string): Promise<string | null> {
  try {
    return await git.resolveRef({ fs, dir, ref: "HEAD" });
  } catch {
    return null;
  }
}
