import { writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { cleanupTempDirs, tempDir } from "../../review-test-utils";
import { reviewVcs } from "../../review-vcs";
import {
  initLegacyReviewRepo,
  sealLegacyReviewCommit,
} from "./legacy-review-git";

afterEach(cleanupTempDirs);

describe("legacy review Git fixture sealer", () => {
  it("produces commits reviewVcs.log/resolve/materialize can read back", async () => {
    const dir = await tempDir("legacy-review-git-");
    await initLegacyReviewRepo(dir);
    await writeFile(path.join(dir, "review.mdx"), "# v1\n");
    const first = await sealLegacyReviewCommit(dir, "Legacy document v1");
    await writeFile(path.join(dir, "review.mdx"), "# v2\n");
    const second = await sealLegacyReviewCommit(dir, "Legacy document v2");

    const log = await reviewVcs.log(dir);
    expect(log.map((entry) => entry.oid)).toEqual([second, first]);
    expect(log.map((entry) => entry.message)).toEqual([
      "Legacy document v2",
      "Legacy document v1",
    ]);

    expect(await reviewVcs.resolve(dir, second)).toBe(second);

    const materialized = await tempDir("legacy-review-git-materialized-");
    await reviewVcs.materialize(dir, first, materialized);
    expect(
      await import("node:fs/promises").then((fs) =>
        fs.readFile(path.join(materialized, "review.mdx"), "utf8"),
      ),
    ).toBe("# v1\n");
  });

  it("reproduces reviewVcs.init/seal's author, branch, and single-parent shape", async () => {
    const dir = await tempDir("legacy-review-git-shape-");
    await initLegacyReviewRepo(dir);
    await writeFile(path.join(dir, "a.txt"), "a\n");
    const parent = await sealLegacyReviewCommit(dir, "First", {
      timestamp: 1_700_000_000,
    });
    await writeFile(path.join(dir, "b.txt"), "b\n");
    const child = await sealLegacyReviewCommit(dir, "Second", {
      timestamp: 1_700_000_100,
    });

    const log = await reviewVcs.log(dir);
    expect(log).toEqual([
      { oid: child, message: "Second", timestamp: 1_700_000_100 },
      { oid: parent, message: "First", timestamp: 1_700_000_000 },
    ]);

    const git = await import("isomorphic-git");
    const fs = await import("node:fs");
    const commit = await git.readCommit({ fs, dir, oid: child });
    expect(commit.commit.author).toMatchObject({
      name: "dev.fast Review",
      email: "review@dev.fast",
    });
    expect(commit.commit.committer).toMatchObject({
      name: "dev.fast Review",
      email: "review@dev.fast",
    });
    expect(commit.commit.parent).toEqual([parent]);
    expect(await git.resolveRef({ fs, dir, ref: "refs/heads/main" })).toBe(
      child,
    );
  });
});
