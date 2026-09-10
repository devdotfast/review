import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  initLegacyReviewRepo,
  sealLegacyReviewCommit,
} from "./fixtures/legacy-reviews/legacy-review-git";
import { cleanupTempDirs, tempDir } from "./review-test-utils";
import { reviewVcs } from "./review-vcs";

afterEach(cleanupTempDirs);

describe("reviewVcs log", () => {
  it("returns sealed commits newest first and [] before the first seal", async () => {
    const root = await tempDir("review-vcs-");
    const dir = path.join(root, "review");
    await mkdir(dir, { recursive: true });
    await initLegacyReviewRepo(dir);
    await expect(reviewVcs.log(dir)).resolves.toEqual([]);
    await writeFile(path.join(dir, "review.mdx"), "# One\n");
    const first = await sealLegacyReviewCommit(dir, "Review publish candidate");
    await writeFile(path.join(dir, "review.mdx"), "# Two\n");
    const second = await sealLegacyReviewCommit(
      dir,
      "Publish Review software map",
    );

    const entries = await reviewVcs.log(dir);

    expect(entries.map((entry) => entry.oid)).toEqual([second, first]);
    expect(entries[0]?.message).toBe("Publish Review software map");
    expect(entries[1]?.message).toBe("Review publish candidate");
    expect(entries[0]?.timestamp).toBeGreaterThan(0);
  });
});
