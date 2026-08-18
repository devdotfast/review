import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ensureReviewPinnedCheckout,
  removeReviewPinnedCheckout,
} from "./review-head-checkout";
import { reviewPrepareMarkerPath } from "./review-prepare";
import { reviewManagedCheckoutDir } from "./review-storage";

const TEST_REVIEW_UUID = "00000000-0000-4000-8000-00000000dddd";

describe("ensureReviewPinnedCheckout", () => {
  const cleanupPaths: string[] = [];

  afterEach(async () => {
    await Promise.all(
      cleanupPaths
        .splice(0)
        .map((target) => rm(target, { recursive: true, force: true })),
    );
  });

  it("materializes a detached checkout of the pinned head", async () => {
    const repo = await createRepoWithFeature(cleanupPaths);

    const checkoutPath = await ensureReviewPinnedCheckout({
      rootPath: repo.rootPath,
      ref: repo.headCommit,
      reviewUuid: TEST_REVIEW_UUID,
    });

    expect(checkoutPath).toBe(
      reviewManagedCheckoutDir(
        repo.commonDir,
        TEST_REVIEW_UUID,
        "head",
        repo.headCommit,
      ),
    );
    expect(checkoutPath).toContain(
      path.join(repo.commonDir, "dev-fast", "reviews", TEST_REVIEW_UUID),
    );
    expect(
      readFileSync(path.join(checkoutPath ?? "", "README.md"), "utf8"),
    ).toBe("head\n");
    expect(gitOutput(checkoutPath ?? "", ["rev-parse", "HEAD"])).toBe(
      repo.headCommit,
    );
    // The user's own working tree stays untouched on main.
    expect(readFileSync(path.join(repo.rootPath, "README.md"), "utf8")).toBe(
      "base\n",
    );
  });

  it("reuses the existing checkout on a second start", async () => {
    const repo = await createRepoWithFeature(cleanupPaths);
    const first = await ensureReviewPinnedCheckout({
      rootPath: repo.rootPath,
      ref: repo.headCommit,
      reviewUuid: TEST_REVIEW_UUID,
    });
    const marker = path.join(first ?? "", "reused-marker.txt");
    await writeFile(marker, "still here\n", "utf8");

    const second = await ensureReviewPinnedCheckout({
      rootPath: repo.rootPath,
      ref: repo.headCommit,
      reviewUuid: TEST_REVIEW_UUID,
    });

    // Same path, and the directory was not recreated.
    expect(second).toBe(first);
    expect(readFileSync(marker, "utf8")).toBe("still here\n");
  });

  it("materializes a checkout even when the pinned head is the working copy commit", async () => {
    const repo = await createRepoWithFeature(cleanupPaths);
    const workingCopyCommit = gitOutput(repo.rootPath, ["rev-parse", "HEAD"]);

    const checkoutPath = await ensureReviewPinnedCheckout({
      rootPath: repo.rootPath,
      ref: workingCopyCommit,
      reviewUuid: TEST_REVIEW_UUID,
    });

    expect(checkoutPath).not.toBeNull();
    expect(existsSync(path.join(checkoutPath!, ".git"))).toBe(true);
  });

  it("recreates a checkout whose directory was gutted on disk", async () => {
    const repo = await createRepoWithFeature(cleanupPaths);
    const first = await ensureReviewPinnedCheckout({
      rootPath: repo.rootPath,
      ref: repo.headCommit,
      reviewUuid: TEST_REVIEW_UUID,
    });
    // Simulate a manual `rm -rf` of the checkout: git still registers the
    // worktree, but the directory is gone.
    rmSync(first ?? "", { recursive: true, force: true });

    const second = await ensureReviewPinnedCheckout({
      rootPath: repo.rootPath,
      ref: repo.headCommit,
      reviewUuid: TEST_REVIEW_UUID,
    });

    expect(second).toBe(first);
    expect(readFileSync(path.join(second ?? "", "README.md"), "utf8")).toBe(
      "head\n",
    );
    expect(gitOutput(second ?? "", ["rev-parse", "HEAD"])).toBe(
      repo.headCommit,
    );
  });

  it("drops the prepare marker when a gutted checkout is recreated", async () => {
    const repo = await createRepoWithFeature(cleanupPaths);
    const first = await ensureReviewPinnedCheckout({
      rootPath: repo.rootPath,
      ref: repo.headCommit,
      reviewUuid: TEST_REVIEW_UUID,
    });
    await writeFile(
      reviewPrepareMarkerPath(first ?? ""),
      JSON.stringify({ commandsHash: "cafecafecafecafe", preparedAt: 1 }),
      "utf8",
    );
    rmSync(first ?? "", { recursive: true, force: true });

    await ensureReviewPinnedCheckout({
      rootPath: repo.rootPath,
      ref: repo.headCommit,
      reviewUuid: TEST_REVIEW_UUID,
    });

    // The recreated tree is bare; a surviving marker would silently skip
    // devfast.prepare for it.
    expect(existsSync(reviewPrepareMarkerPath(first ?? ""))).toBe(false);
  });

  it("refuses to materialize a conflicted jj revision", async () => {
    if (!commandExists("jj")) return;
    const rootPath = await mkdtemp(path.join(os.tmpdir(), "head-checkout-cf-"));
    cleanupPaths.push(rootPath);
    execFileSync("jj", ["git", "init", "."], {
      cwd: rootPath,
      stdio: "ignore",
    });
    await writeFile(path.join(rootPath, "file.txt"), "base\n", "utf8");
    execJj(rootPath, ["commit", "-m", "base"]);
    const baseChange = jjOutput(rootPath, [
      "log",
      "--no-graph",
      "-r",
      "@-",
      "-T",
      "change_id",
    ]);
    await writeFile(path.join(rootPath, "file.txt"), "left\n", "utf8");
    execJj(rootPath, ["commit", "-m", "left"]);
    const leftChange = jjOutput(rootPath, [
      "log",
      "--no-graph",
      "-r",
      "@-",
      "-T",
      "change_id",
    ]);
    // A sibling edit of the same line, rebased onto "left", conflicts.
    execJj(rootPath, ["new", baseChange]);
    await writeFile(path.join(rootPath, "file.txt"), "right\n", "utf8");
    execJj(rootPath, ["describe", "-m", "right"]);
    execJj(rootPath, ["rebase", "-r", "@", "-d", leftChange]);
    const conflictedCommit = jjOutput(rootPath, [
      "log",
      "--no-graph",
      "-r",
      "@",
      "-T",
      "commit_id",
    ]);

    await expect(
      ensureReviewPinnedCheckout({
        rootPath,
        ref: conflictedCommit,
        reviewUuid: TEST_REVIEW_UUID,
      }),
    ).rejects.toThrow(/conflicted revision/);
  });

  it("materializes from the backing store of a non-colocated jj workspace", async () => {
    if (!commandExists("jj")) return;
    const rootPath = await mkdtemp(path.join(os.tmpdir(), "head-checkout-jj-"));
    cleanupPaths.push(rootPath);
    execFileSync("jj", ["git", "init", "--no-colocate", "."], {
      cwd: rootPath,
      stdio: "ignore",
    });
    await writeFile(path.join(rootPath, "README.md"), "pinned\n", "utf8");
    execFileSync("jj", ["-R", rootPath, "commit", "-m", "pinned head"], {
      stdio: "ignore",
    });
    await writeFile(path.join(rootPath, "README.md"), "working copy\n", "utf8");
    const pinnedCommit = execFileSync(
      "jj",
      ["-R", rootPath, "log", "--no-graph", "-r", "@-", "-T", "commit_id"],
      { encoding: "utf8" },
    ).trim();
    const commonDir = execFileSync("jj", ["-R", rootPath, "git", "root"], {
      encoding: "utf8",
    }).trim();

    const checkoutPath = await ensureReviewPinnedCheckout({
      rootPath,
      ref: pinnedCommit,
      reviewUuid: TEST_REVIEW_UUID,
    });

    expect(checkoutPath).toBe(
      reviewManagedCheckoutDir(
        commonDir,
        TEST_REVIEW_UUID,
        "head",
        pinnedCommit,
      ),
    );
    expect(
      readFileSync(path.join(checkoutPath ?? "", "README.md"), "utf8"),
    ).toBe("pinned\n");
    // The jj working copy keeps its own (different) content.
    expect(readFileSync(path.join(rootPath, "README.md"), "utf8")).toBe(
      "working copy\n",
    );
  });
});

describe("removeReviewPinnedCheckout", () => {
  const cleanupPaths: string[] = [];

  afterEach(async () => {
    await Promise.all(
      cleanupPaths
        .splice(0)
        .map((target) => rm(target, { recursive: true, force: true })),
    );
  });

  it("removes only the review's own checkout, leaving concurrent ones", async () => {
    const repo = await createRepoWithFeature(cleanupPaths);
    execGit(repo.rootPath, ["checkout", "-b", "feature-2", "main"]);
    await writeFile(path.join(repo.rootPath, "README.md"), "head-2\n", "utf8");
    execGit(repo.rootPath, ["commit", "-am", "head 2"]);
    const otherCommit = gitOutput(repo.rootPath, ["rev-parse", "HEAD"]);
    execGit(repo.rootPath, ["checkout", "main"]);

    const first = await ensureReviewPinnedCheckout({
      rootPath: repo.rootPath,
      ref: repo.headCommit,
      reviewUuid: TEST_REVIEW_UUID,
    });
    const other = await ensureReviewPinnedCheckout({
      rootPath: repo.rootPath,
      ref: otherCommit,
      reviewUuid: TEST_REVIEW_UUID,
    });

    await writeFile(
      reviewPrepareMarkerPath(first ?? ""),
      JSON.stringify({ commandsHash: "cafecafecafecafe", preparedAt: 1 }),
      "utf8",
    );
    await expect(
      removeReviewPinnedCheckout({
        rootPath: repo.rootPath,
        reviewUuid: TEST_REVIEW_UUID,
        checkoutPath: first ?? "",
      }),
    ).resolves.toBe(true);

    expect(existsSync(first ?? "")).toBe(false);
    // The prepare marker dies with its tree.
    expect(existsSync(reviewPrepareMarkerPath(first ?? ""))).toBe(false);
    expect(readFileSync(path.join(other ?? "", "README.md"), "utf8")).toBe(
      "head-2\n",
    );
    const worktrees = gitOutput(repo.rootPath, [
      "worktree",
      "list",
      "--porcelain",
    ]);
    expect(worktrees).not.toContain(first ?? "");
    expect(worktrees).toContain(other ?? "");
  });

  it("refuses paths outside the dev-fast worktrees dir", async () => {
    const repo = await createRepoWithFeature(cleanupPaths);

    await expect(
      removeReviewPinnedCheckout({
        rootPath: repo.rootPath,
        reviewUuid: TEST_REVIEW_UUID,
        checkoutPath: repo.rootPath,
      }),
    ).resolves.toBe(false);

    expect(readFileSync(path.join(repo.rootPath, "README.md"), "utf8")).toBe(
      "base\n",
    );
  });
});

async function createRepoWithFeature(cleanupPaths: string[]): Promise<{
  rootPath: string;
  commonDir: string;
  headCommit: string;
}> {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), "head-checkout-git-"));
  cleanupPaths.push(rootPath);
  execGit(rootPath, ["init"]);
  execGit(rootPath, ["config", "user.email", "review@example.com"]);
  execGit(rootPath, ["config", "user.name", "Review Test"]);
  await writeFile(path.join(rootPath, "README.md"), "base\n", "utf8");
  execGit(rootPath, ["add", "README.md"]);
  execGit(rootPath, ["commit", "-m", "base"]);
  execGit(rootPath, ["branch", "-M", "main"]);
  execGit(rootPath, ["checkout", "-b", "feature"]);
  await writeFile(path.join(rootPath, "README.md"), "head\n", "utf8");
  execGit(rootPath, ["commit", "-am", "head"]);
  const headCommit = gitOutput(rootPath, ["rev-parse", "HEAD"]);
  execGit(rootPath, ["checkout", "main"]);
  const commonDir = gitOutput(rootPath, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  return { rootPath, commonDir, headCommit };
}

function commandExists(command: string): boolean {
  try {
    execFileSync("sh", ["-c", `command -v ${command}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function execGit(rootPath: string, args: string[]): void {
  execFileSync("git", args, { cwd: rootPath, stdio: "ignore" });
}

function execJj(rootPath: string, args: string[]): void {
  execFileSync("jj", ["-R", rootPath, ...args], { stdio: "ignore" });
}

function jjOutput(rootPath: string, args: string[]): string {
  return execFileSync("jj", ["-R", rootPath, ...args], {
    encoding: "utf8",
  }).trim();
}

function gitOutput(rootPath: string, args: string[]): string {
  return execFileSync("git", args, { cwd: rootPath, encoding: "utf8" }).trim();
}
