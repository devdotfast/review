import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { createReviewDir, sealReviewCandidate } from "../review-home";
import { materializePublishRevision } from "./publish-stage";

// Compute a Git loose-object path for the blob that stores `content`, so the
// test can simulate a mid-walk read failure by removing exactly that object
// (then restoring it) without mocking the filesystem or isomorphic-git.
function gitBlobObjectPath(dir: string, content: Buffer): string {
  const header = Buffer.from(`blob ${content.length}\0`);
  const oid = createHash("sha1")
    .update(Buffer.concat([header, content]))
    .digest("hex");
  return path.join(dir, ".git", "objects", oid.slice(0, 2), oid.slice(2));
}

describe("publish revision stage — partial-build poisoning (end-to-end)", () => {
  it("rebuilds a build left partial by a mid-walk blob-read failure instead of serving it as cached", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "review-publish-home-"));
    const source = await mkdtemp(
      path.join(os.tmpdir(), "review-publish-source-"),
    );
    vi.stubEnv("DEV_REVIEW_HOME", home);
    try {
      const review = await createReviewDir({
        worktreePath: source,
        baseRef: "HEAD",
        baseCommit: "base-commit",
      });
      await writeFile(
        path.join(review.dir, "data.ts"),
        "export const data = 1;\n",
      );
      const reviewJson = '{"presentedSoftwareMapRevision":null}\n';
      await writeFile(path.join(review.dir, "review.json"), reviewJson);
      const revision = await sealReviewCandidate(review.dir, "test revision");

      // A clean build succeeds and populates the cache key.
      const buildDir = await materializePublishRevision({ review, revision });

      // Simulate a mid-walk failure: remove the loose git object for the
      // `review.json` blob so `git.walk`'s `entry.content()` rejects while
      // the tree is being written. This is the cache-poisoning trigger — an
      // interrupted write after the staging directory has been created but
      // before the walk completes.
      const objectPath = gitBlobObjectPath(review.dir, Buffer.from(reviewJson));
      expect(existsSync(objectPath)).toBe(true);
      const savedObject = await readFile(objectPath);
      await rm(buildDir, { recursive: true, force: true });
      await rm(objectPath, { force: true });

      await expect(
        materializePublishRevision({ review, revision }),
      ).rejects.toThrow(/Could not find/);

      // FIX: the interrupted write left no partial tree under the cache key
      // (no directory for the existence-only cache check to trust), and no
      // staging tree was orphaned.
      await expect(stat(buildDir)).rejects.toThrow(/ENOENT/);
      await expect(stat(`${buildDir}.partial`)).rejects.toThrow(/ENOENT/);

      // Restoring the blob and re-requesting rebuilds the sealed revision in
      // full from the commit, rather than returning a partial cached build.
      await writeFile(objectPath, savedObject);
      await expect(
        materializePublishRevision({ review, revision }),
      ).resolves.toBe(buildDir);
      await expect(
        readFile(path.join(buildDir, "review.json"), "utf8"),
      ).resolves.toBe(reviewJson);
      await expect(
        readFile(path.join(buildDir, "data.ts"), "utf8"),
      ).resolves.toBe("export const data = 1;\n");
      await expect(stat(`${buildDir}.partial`)).rejects.toThrow(/ENOENT/);
    } finally {
      vi.unstubAllEnvs();
      await rm(home, { recursive: true, force: true });
      await rm(source, { recursive: true, force: true });
    }
  });
});
