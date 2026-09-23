import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import { createReviewDir, readStoredReview } from "./review-home";
import { withReviewMutationLock } from "./review-mutation-lock";

const roots: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

it("reports loader and open contention as busy and allows migration after release", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "review-busy-read-"));
  roots.push(home);
  vi.stubEnv("DEV_WHITEBOARD_HOME", home);
  await writeFile(
    path.join(home, "preferences.json"),
    JSON.stringify({ dismissedRetentionDays: null }),
  );
  const root = path.join(home, "source");
  await mkdir(root);

  const git = (args: string[]) =>
    execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();

  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "review@example.test"]);
  git(["config", "user.name", "Review Test"]);
  await writeFile(path.join(root, "README.md"), "# Source\n");
  git(["add", "."]);
  git(["commit", "-qm", "source"]);
  const sourceCommit = git(["rev-parse", "HEAD"]);

  const review = await createReviewDir({
    worktreePath: root,
    baseRef: "main",
    baseCommit: sourceCommit,
    sourceCommit,
    sourceIdentity: { kind: "git-branch", name: "main" },
  });

  const recordPath = path.join(review.dir, "review.json");
  const recordBytes = JSON.stringify({ ...review.review, schemaVersion: 4 });
  await writeFile(recordPath, recordBytes);

  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();

  const holding = withReviewMutationLock(review.dir, async () => {
    entered.resolve();
    await release.promise;
  });

  await entered.promise;

  try {
    const loaded = await readStoredReview(review.dir);

    expect(loaded).toMatchObject({
      error: {
        code: "REVIEW_BUSY",
        message: expect.stringContaining(
          "Retry after its current operation completes",
        ),
      },
    });
    expect(await readFile(recordPath, "utf8")).toBe(recordBytes);
  } finally {
    release.resolve();
    await holding;
  }

  expect(await readStoredReview(review.dir)).toMatchObject({
    review: { schemaVersion: 5 },
  });
}, 20_000);
