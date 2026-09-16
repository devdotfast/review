import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import { resolvePublishReview } from "./publish-preparation";
import { createReviewDir } from "./review-home";

const execFilePromise = promisify(execFile);

describe("resolvePublishReview", () => {
  const cleanupPaths: string[] = [];

  afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(
      cleanupPaths
        .splice(0)
        .map((target) => rm(target, { recursive: true, force: true })),
    );
  });

  it("reports unreadable records during implicit selection while allowing a healthy explicit UUID", async () => {
    const repo = await createGitRepository(cleanupPaths);

    const home = await mkdtemp(
      path.join(os.tmpdir(), "review-publish-unreadable-"),
    );

    cleanupPaths.push(home);
    vi.stubEnv("DEV_REVIEW_HOME", home);

    const healthy = await createReviewDir({
      worktreePath: repo.rootPath,
      baseRef: "main",
      baseCommit: repo.baseCommit,
    });

    const corrupt = await createReviewDir({
      worktreePath: repo.rootPath,
      baseRef: "main",
      baseCommit: repo.baseCommit,
    });

    await writeFile(path.join(corrupt.dir, "review.json"), "{");
    await expect(
      resolvePublishReview(repo.rootPath, undefined),
    ).rejects.toThrow(corrupt.dir);
    await expect(
      resolvePublishReview(repo.rootPath, healthy.review.uuid),
    ).resolves.toMatchObject({ review: { uuid: healthy.review.uuid } });
    await expect(
      resolvePublishReview(home, healthy.review.uuid),
    ).rejects.toThrow(/Active review not found/);
  });
});

async function createGitRepository(cleanupPaths: string[]): Promise<{
  rootPath: string;
  baseCommit: string;
}> {
  const rootPath = await mkdtemp(
    path.join(os.tmpdir(), "review-publish-source-"),
  );

  cleanupPaths.push(rootPath);
  await git(rootPath, ["init", "-b", "main"]);
  await git(rootPath, ["config", "user.email", "review@example.test"]);
  await git(rootPath, ["config", "user.name", "Review Test"]);
  await writeFile(path.join(rootPath, "README.md"), "base\n", "utf8");
  await git(rootPath, ["add", "."]);
  await git(rootPath, ["commit", "-m", "base"]);
  const baseCommit = await git(rootPath, ["rev-parse", "HEAD"]);

  return { rootPath, baseCommit };
}

async function git(rootPath: string, args: string[]): Promise<string> {
  const { stdout } = await execFilePromise("git", ["-C", rootPath, ...args], {
    encoding: "utf8",
  });

  return stdout.trim();
}
