import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setImmediate } from "node:timers/promises";

import { afterEach, expect, it, vi } from "vitest";

import { createReviewDir } from "./review-home";
import { withReviewMutationLock } from "./review-mutation-lock";
import { sealReviewSoftwareMapPublication } from "./server/review-lifecycle";
import { bundleReviewSoftwareMap } from "./software-map-bundle";
import { defineSoftwareMap } from "./software-map-model";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

it("takes the mutation lock around software-map write and seal", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "review-map-publish-"));
  roots.push(home);
  vi.stubEnv("DEV_REVIEW_HOME", home);
  const source = path.join(home, "source");
  await mkdir(source);
  const git = (args: string[]) =>
    execFileSync("git", ["-C", source, ...args], { encoding: "utf8" }).trim();
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "review@example.test"]);
  git(["config", "user.name", "Review Test"]);
  await writeFile(path.join(source, "README.md"), "# Source\n");
  git(["add", "."]);
  git(["commit", "-qm", "source"]);
  const commit = git(["rev-parse", "HEAD"]);
  const review = await createReviewDir({
    worktreePath: source,
    baseRef: "main",
    baseCommit: commit,
    sourceCommit: commit,
    sourceIdentity: { kind: "git-branch", name: "main" },
  });
  const model = defineSoftwareMap({ systems: { app: { label: "App" } } });
  const bundle = bundleReviewSoftwareMap({
    head: model,
    base: model,
    headCommit: commit,
    baseCommit: commit,
  });
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const holding = withReviewMutationLock(review.dir, async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  let finished = false;
  const sealing = sealReviewSoftwareMapPublication({ review, bundle }).then(
    (revision) => {
      finished = true;
      return revision;
    },
  );
  for (let attempt = 0; attempt < 30; attempt++) await setImmediate();
  const bypassed = finished;
  release.resolve();
  await holding;
  await expect(sealing).resolves.toMatch(/^[a-f0-9]{40}$/);
  expect(bypassed).toBe(false);
});
