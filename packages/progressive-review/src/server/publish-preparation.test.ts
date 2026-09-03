import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createReviewDir, readReviewRecord } from "../review-home";
import { prepareReviewPublish } from "./publish-preparation";

const execFilePromise = promisify(execFile);

describe("prepareReviewPublish", () => {
  const cleanupPaths: string[] = [];

  afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(
      cleanupPaths
        .splice(0)
        .map((target) => rm(target, { recursive: true, force: true })),
    );
  });

  it("prepares a publish from a checkout unrelated to the pinned head", async () => {
    const repo = await createDivergedGitRepository(cleanupPaths);
    const reviewHome = await mkdtemp(
      path.join(os.tmpdir(), "review-publish-home-"),
    );
    cleanupPaths.push(reviewHome);
    vi.stubEnv("DEV_REVIEW_HOME", reviewHome);
    const review = await createReviewDir({
      worktreePath: repo.rootPath,
      baseRef: repo.baseCommit,
      baseCommit: repo.baseCommit,
      sourceCommit: repo.featureCommit,
      sourceIdentity: { kind: "git-branch", name: repo.featureCommit },
    });

    const prepared = await prepareReviewPublish({
      cwd: repo.rootPath,
      reviewUuid: review.review.uuid,
    });
    expect(prepared.sourceCommit).toBe(repo.featureCommit);
    expect(prepared).not.toHaveProperty("warnings");
  });

  it("prepares without warnings when the pinned head is checked out exactly", async () => {
    const repo = await createDivergedGitRepository(cleanupPaths);
    const reviewHome = await mkdtemp(
      path.join(os.tmpdir(), "review-publish-home-"),
    );
    cleanupPaths.push(reviewHome);
    vi.stubEnv("DEV_REVIEW_HOME", reviewHome);
    const review = await createReviewDir({
      worktreePath: repo.rootPath,
      baseRef: repo.baseCommit,
      baseCommit: repo.baseCommit,
      sourceCommit: repo.baseCommit,
      sourceIdentity: { kind: "git-branch", name: repo.baseCommit },
    });

    const prepared = await prepareReviewPublish({
      cwd: repo.rootPath,
      reviewUuid: review.review.uuid,
    });

    expect(prepared.sourceCommit).toBe(repo.baseCommit);
    expect(prepared).not.toHaveProperty("warnings");
  });

  it("prepares without warnings when the checkout descends from the pinned head", async () => {
    const repo = await createDivergedGitRepository(cleanupPaths);
    await writeFile(path.join(repo.rootPath, "main.txt"), "descendant\n");
    await git(repo.rootPath, ["add", "."]);
    await git(repo.rootPath, ["commit", "-m", "descendant"]);
    const checkoutCommit = await git(repo.rootPath, ["rev-parse", "HEAD"]);
    const reviewHome = await mkdtemp(
      path.join(os.tmpdir(), "review-publish-home-"),
    );
    cleanupPaths.push(reviewHome);
    vi.stubEnv("DEV_REVIEW_HOME", reviewHome);
    const review = await createReviewDir({
      worktreePath: repo.rootPath,
      baseRef: repo.baseCommit,
      baseCommit: repo.baseCommit,
      sourceCommit: repo.baseCommit,
      sourceIdentity: { kind: "git-branch", name: repo.baseCommit },
    });

    const prepared = await prepareReviewPublish({
      cwd: repo.rootPath,
      reviewUuid: review.review.uuid,
    });
    expect(prepared).toMatchObject({
      sourceBranch: repo.baseCommit,
      sourceCommit: repo.baseCommit,
    });
    expect(prepared).not.toHaveProperty("warnings");
    expect(prepared.sourceCommit).not.toBe(checkoutCommit);
  });

  it("keeps the stored pins when the branch and base move, and warns to update", async () => {
    const repo = await createDivergedGitRepository(cleanupPaths);
    const reviewHome = await mkdtemp(
      path.join(os.tmpdir(), "review-publish-home-"),
    );
    cleanupPaths.push(reviewHome);
    vi.stubEnv("DEV_REVIEW_HOME", reviewHome);
    const review = await createReviewDir({
      worktreePath: repo.rootPath,
      baseRef: "main",
      baseCommit: repo.baseCommit,
      sourceCommit: repo.featureCommit,
      sourceIdentity: { kind: "git-branch", name: "feature" },
    });
    await writeFile(path.join(repo.rootPath, "main.txt"), "base moved\n");
    await git(repo.rootPath, ["add", "."]);
    await git(repo.rootPath, ["commit", "-m", "base moved"]);
    const movedBase = await git(repo.rootPath, ["rev-parse", "HEAD"]);
    await git(repo.rootPath, ["checkout", "feature"]);
    await writeFile(
      path.join(repo.rootPath, "README.md"),
      "feature moved\n",
      "utf8",
    );
    await git(repo.rootPath, ["commit", "-am", "feature moved"]);
    const movedHead = await git(repo.rootPath, ["rev-parse", "HEAD"]);

    const prepared = await prepareReviewPublish({
      cwd: repo.rootPath,
      reviewUuid: review.review.uuid,
    });

    expect(prepared.review.review.baseCommit).toBe(repo.baseCommit);
    expect(prepared.review.review.baseCommit).not.toBe(movedBase);
    expect(prepared.review.review.sourceCommit).toBe(repo.featureCommit);
    expect(prepared.sourceCommit).toBe(repo.featureCommit);
    expect(prepared.sourceCommit).not.toBe(movedHead);
    expect(prepared.warnings).toEqual([
      "Pinned commits are behind feature. Run `review scaffold --update` and publish again to present the latest commits.",
    ]);
    const stored = readReviewRecord(review.dir);
    expect(stored.baseCommit).toBe(repo.baseCommit);
    expect(stored.sourceCommit).toBe(repo.featureCommit);
  });

  it("rejects a publish when the pinned base commit no longer exists", async () => {
    const repo = await createDivergedGitRepository(cleanupPaths);
    const reviewHome = await mkdtemp(
      path.join(os.tmpdir(), "review-publish-home-"),
    );
    cleanupPaths.push(reviewHome);
    vi.stubEnv("DEV_REVIEW_HOME", reviewHome);
    const missingBase = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
    const review = await createReviewDir({
      worktreePath: repo.rootPath,
      baseRef: repo.baseCommit,
      baseCommit: missingBase,
      sourceCommit: repo.baseCommit,
      sourceIdentity: { kind: "git-branch", name: repo.baseCommit },
    });

    await expect(
      prepareReviewPublish({
        cwd: repo.rootPath,
        reviewUuid: review.review.uuid,
      }),
    ).rejects.toThrow(/base commit no longer exists/);
  });

  it("does not warn about stale pins for a positional binding", async () => {
    const repo = await createDivergedGitRepository(cleanupPaths);
    const reviewHome = await mkdtemp(
      path.join(os.tmpdir(), "review-publish-home-"),
    );
    cleanupPaths.push(reviewHome);
    vi.stubEnv("DEV_REVIEW_HOME", reviewHome);
    const review = await createReviewDir({
      worktreePath: repo.rootPath,
      baseRef: repo.baseCommit,
      baseCommit: repo.baseCommit,
      sourceCommit: repo.baseCommit,
      sourceIdentity: { kind: "git-branch", name: "HEAD" },
    });

    const prepared = await prepareReviewPublish({
      cwd: repo.rootPath,
      reviewUuid: review.review.uuid,
    });
    expect(prepared.sourceCommit).toBe(repo.baseCommit);
    expect(prepared).not.toHaveProperty("warnings");
  });

  it("presents the pins even when the bound head no longer resolves", async () => {
    const repo = await createDivergedGitRepository(cleanupPaths);
    const reviewHome = await mkdtemp(
      path.join(os.tmpdir(), "review-publish-home-"),
    );
    cleanupPaths.push(reviewHome);
    vi.stubEnv("DEV_REVIEW_HOME", reviewHome);
    const review = await createReviewDir({
      worktreePath: repo.rootPath,
      baseRef: repo.baseCommit,
      baseCommit: repo.baseCommit,
      sourceCommit: repo.baseCommit,
      sourceIdentity: { kind: "git-branch", name: "missing-head" },
    });

    const prepared = await prepareReviewPublish({
      cwd: repo.rootPath,
      reviewUuid: review.review.uuid,
    });
    expect(prepared.sourceCommit).toBe(repo.baseCommit);
    expect(prepared).not.toHaveProperty("warnings");
  });
});

async function createDivergedGitRepository(cleanupPaths: string[]): Promise<{
  rootPath: string;
  baseCommit: string;
  featureCommit: string;
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
  await git(rootPath, ["checkout", "-b", "feature"]);
  await writeFile(path.join(rootPath, "README.md"), "feature\n", "utf8");
  await git(rootPath, ["commit", "-am", "feature"]);
  const featureCommit = await git(rootPath, ["rev-parse", "HEAD"]);
  await git(rootPath, ["checkout", "main"]);
  return { rootPath, baseCommit, featureCommit };
}

async function git(rootPath: string, args: string[]): Promise<string> {
  const { stdout } = await execFilePromise("git", ["-C", rootPath, ...args], {
    encoding: "utf8",
  });
  return stdout.trim();
}
