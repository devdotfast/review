import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { createReviewDir, sealReviewCandidate } from "../review-home";
import { findPublishReview, materializePublishRevision } from "./publish-stage";

describe("publish revision stage", () => {
  it("materializes a review Git revision into its build staging directory", async () => {
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
      const revision = await sealReviewCandidate(review.dir, "test revision");

      const found = await findPublishReview(review.review.uuid);
      expect(found?.dir).toBe(review.dir);
      const destination = await materializePublishRevision({
        review,
        revision,
      });

      await expect(
        readFile(path.join(destination, "data.ts"), "utf8"),
      ).resolves.toBe("export const data = 1;\n");
      await writeFile(path.join(destination, "data.ts"), "live\n");
      await expect(
        materializePublishRevision({ review, revision }),
      ).resolves.toBe(destination);
      await expect(
        readFile(path.join(destination, "data.ts"), "utf8"),
      ).resolves.toBe("live\n");
      await expect(
        findPublishReview("00000000-0000-0000-0000-000000000000"),
      ).resolves.toBeNull();
      await expect(
        materializePublishRevision({ review, revision: ".." }),
      ).rejects.toThrow("Review revision is invalid");
      await expect(
        materializePublishRevision({ review, revision: "." }),
      ).rejects.toThrow("Review revision is invalid");
      const corruptDir = path.join(home, "reviews", "corrupt");
      await mkdir(corruptDir, { recursive: true });
      await writeFile(path.join(corruptDir, "review.json"), "{");
      await expect(
        findPublishReview(review.review.uuid),
      ).resolves.toMatchObject({
        dir: review.dir,
      });
    } finally {
      vi.unstubAllEnvs();
      await rm(home, { recursive: true, force: true });
      await rm(source, { recursive: true, force: true });
    }
  });
});
