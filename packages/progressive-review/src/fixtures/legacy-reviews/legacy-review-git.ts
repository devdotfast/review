import fs from "node:fs";

import * as git from "isomorphic-git";

/**
 * Test-only reproduction of `reviewVcs.init`/`seal` (`../../review-vcs.ts`).
 * Fixtures use this instead of the production writers so Task 13 can delete
 * `reviewVcs.init`/`seal` without breaking every test that only needs a
 * Git-era review directory to read back through `reviewVcs.log`/`resolve`/
 * `materialize` — none of which this module touches.
 */
const REVIEW_BRANCH = "refs/heads/main";
const REVIEW_AUTHOR = {
  name: "dev.fast Review",
  email: "review@dev.fast",
};

export async function initLegacyReviewRepo(dir: string): Promise<void> {
  await git.init({ fs, dir, defaultBranch: "main" });
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
