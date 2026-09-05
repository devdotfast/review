import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { REVIEW_SCHEMA_VERSION } from "@dev.fast/review-protocol";
import { afterEach, describe, expect, it } from "vitest";

import {
  resolveReviewSessionBaseCommit,
  resolveReviewSourceTarget,
} from "./review-worktree-target";
import { writePrivateJsonAtomic } from "./server/desktop-paths";

interface ReviewRecordFixture {
  worktreePath: string;
  baseCommit: string;
  sourceCommit?: string | null;
}

const cleanupPaths: string[] = [];

afterEach(async () => {
  const paths = cleanupPaths.splice(0);
  for (const candidate of paths) {
    await rm(candidate, { recursive: true, force: true });
  }
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function gitQuiet(cwd: string, args: string[]) {
  execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "ignore", "ignore"],
  });
}

async function createGitRepo(prefix: string): Promise<string> {
  const rawRootPath = await mkdtemp(path.join(tmpdir(), prefix));
  const rootPath = await realpath(rawRootPath);
  cleanupPaths.push(rootPath);
  gitQuiet(rootPath, ["init", "-b", "main"]);
  gitQuiet(rootPath, ["config", "user.email", "review@example.com"]);
  gitQuiet(rootPath, ["config", "user.name", "Review Test"]);
  return rootPath;
}

async function writeReviewRecord(
  reviewRootPath: string,
  fixture: ReviewRecordFixture,
): Promise<void> {
  cleanupPaths.push(reviewRootPath);
  await writePrivateJsonAtomic(path.join(reviewRootPath, "review.json"), {
    schemaVersion: REVIEW_SCHEMA_VERSION,
    uuid: randomUUID(),
    repoKey: "test-repo",
    worktreePath: fixture.worktreePath,
    baseRef: "main",
    baseCommit: fixture.baseCommit,
    sourceCommit: fixture.sourceCommit ?? null,
    sourceIdentity: null,
    title: "Test review",
    sourceSession: "test-session",
    status: "awaiting-review",
    presentedDocumentRevision: null,
    presentedSoftwareMapRevision: null,
    createdAt: new Date(0).toISOString(),
    lastPublishedAt: null,
  });
}

describe("resolveReviewSessionBaseCommit", () => {
  it("returns null instead of throwing when the pinned base commit is unreachable", async () => {
    const gitRoot = await createGitRepo("review-worktree-target-unreachable-");
    // Seed main so `git checkout main` is valid after deleting the doomed branch.
    git(gitRoot, ["commit", "--allow-empty", "-q", "-m", "main"]);
    git(gitRoot, ["checkout", "-q", "-b", "doomed"]);
    git(gitRoot, ["commit", "--allow-empty", "-q", "-m", "doomed base"]);
    const doomed = git(gitRoot, ["rev-parse", "HEAD"]);
    git(gitRoot, ["checkout", "-q", "main"]);
    // Drop every reference and prune the object so rev-parse can no longer
    // resolve the SHA.
    gitQuiet(gitRoot, ["branch", "-q", "-D", "doomed"]);
    gitQuiet(gitRoot, ["reflog", "expire", "--expire=now", "--all"]);
    gitQuiet(gitRoot, ["gc", "-q", "--prune=now"]);
    const reviewRootPath = await mkdtemp(
      path.join(tmpdir(), "review-worktree-target-record-"),
    );
    await writeReviewRecord(reviewRootPath, {
      worktreePath: gitRoot,
      baseCommit: doomed,
    });

    const resolved = await resolveReviewSessionBaseCommit({ reviewRootPath });

    expect(resolved).toBeNull();
  });
});

// Regression guard: the throwing `resolveRevisionCommit` helper used by the
// worktree-materialization paths must still throw on an unreachable commit.
// The session-base fix narrows the null-tolerant behavior to
// `resolveReviewSessionBaseCommit` only; it must not relax the fatal paths.
describe("resolveReviewSourceTarget (materialization still throws)", () => {
  it("throws when the pinned head commit is unreachable", async () => {
    const gitRoot = await createGitRepo("review-worktree-target-source-");
    git(gitRoot, ["commit", "--allow-empty", "-q", "-m", "main"]);
    git(gitRoot, ["checkout", "-q", "-b", "doomed"]);
    git(gitRoot, ["commit", "--allow-empty", "-q", "-m", "doomed head"]);
    const doomed = git(gitRoot, ["rev-parse", "HEAD"]);
    git(gitRoot, ["checkout", "-q", "main"]);
    gitQuiet(gitRoot, ["branch", "-q", "-D", "doomed"]);
    gitQuiet(gitRoot, ["reflog", "expire", "--expire=now", "--all"]);
    gitQuiet(gitRoot, ["gc", "-q", "--prune=now"]);
    const reviewRootPath = await mkdtemp(
      path.join(tmpdir(), "review-worktree-target-record-"),
    );
    await writeReviewRecord(reviewRootPath, {
      worktreePath: gitRoot,
      baseCommit: git(gitRoot, ["rev-parse", "HEAD"]),
      sourceCommit: doomed,
    });

    await expect(resolveReviewSourceTarget({ reviewRootPath })).rejects.toThrow(
      /Revision does not exist/,
    );
  });
});
