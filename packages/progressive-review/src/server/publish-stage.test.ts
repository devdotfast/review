import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { createReviewDir, sealReviewCandidate } from "../review-home";
import { materializePublishRevision } from "./publish-stage";

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
        materializePublishRevision({ review, revision: ".." }),
      ).rejects.toThrow("Review revision is invalid");
      await expect(
        materializePublishRevision({ review, revision: "." }),
      ).rejects.toThrow("Review revision is invalid");
    } finally {
      vi.unstubAllEnvs();
      await rm(home, { recursive: true, force: true });
      await rm(source, { recursive: true, force: true });
    }
  });
});
