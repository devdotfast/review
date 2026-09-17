import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveReviewRepositoryIdentity } from "./repository-identity";
import {
  scratchGitRepo,
  syntheticLegacyReview,
} from "./review-import/import-test-utils";
import { resolveReviewInfo } from "./review-info-resolver";
import {
  cleanupTempDirs,
  gitRepository,
  reviewHome,
} from "./review-test-utils";
import { resolveReviewRoot } from "./runtime";

const execFilePromise = promisify(execFile);

const FIXTURE = "schema4-bug-report-dialog";

afterEach(async () => {
  await cleanupTempDirs();
});

describe("review info", () => {
  it("returns an empty list without creating a review", async () => {
    const root = await gitRepository();
    const home = await reviewHome();

    await expect(
      resolveReviewInfo({
        cwd: root,
      }),
    ).resolves.toEqual({
      event: "info",
      reviews: [],
    });
    await expect(
      readFile(path.join(home, "reviews"), "utf8"),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("lists a worktree review when the checkout does not match its change", async () => {
    const repo = await scratchGitRepo();
    await git(repo.root, ["checkout", "-q", "-b", "feature"]);
    await git(repo.root, ["commit", "-q", "--allow-empty", "-m", "feature"]);
    const featureCommit = await git(repo.root, ["rev-parse", "HEAD"]);
    await git(repo.root, ["checkout", "-q", "main"]);
    const worktreePath = await resolveReviewRoot(repo.root);

    const { home, record } = await syntheticLegacyReview(
      FIXTURE,
      { ...repo, head: featureCommit },
      {
        overrides: {
          worktreePath,
          sourceIdentity: { kind: "git-branch", name: "feature" },
        },
      },
    );

    vi.stubEnv("DEV_REVIEW_HOME", home);

    await expect(resolveReviewInfo({ cwd: repo.root })).resolves.toMatchObject({
      reviews: [{ uuid: record.uuid, inSync: false, matchesCheckout: false }],
    });

    await git(repo.root, ["checkout", "-q", "feature"]);
    await expect(resolveReviewInfo({ cwd: repo.root })).resolves.toMatchObject({
      reviews: [{ uuid: record.uuid, inSync: true, matchesCheckout: true }],
    });
  });

  it("hides terminal reviews from default info but lists them with --all", async () => {
    const repo = await scratchGitRepo();
    const worktreePath = await resolveReviewRoot(repo.root);
    const repository = await resolveReviewRepositoryIdentity(worktreePath);

    const { home, record } = await syntheticLegacyReview(FIXTURE, repo, {
      overrides: {
        worktreePath,
        repoKey: repository.repositoryId,
        status: "rejected",
      },
    });

    vi.stubEnv("DEV_REVIEW_HOME", home);

    await expect(resolveReviewInfo({ cwd: repo.root })).resolves.toMatchObject({
      reviews: [],
    });
    await expect(
      resolveReviewInfo({ cwd: repo.root, all: true }),
    ).resolves.toMatchObject({
      reviews: [{ uuid: record.uuid, status: "rejected" }],
    });
    await expect(
      resolveReviewInfo({
        cwd: path.join(home, "outside-repository"),
        reviewUuid: record.uuid,
      }),
    ).resolves.toMatchObject({
      reviews: [{ uuid: record.uuid, status: "rejected" }],
    });
  });
});

async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await execFilePromise("git", ["-C", root, ...args], {
    encoding: "utf8",
  });

  return stdout.trim();
}
