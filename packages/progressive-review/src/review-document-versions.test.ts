import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  REVIEW_PUBLISH_CANDIDATE_MESSAGE,
  listReviewDocumentVersions,
} from "./review-document-versions";
import { reviewVcs } from "./review-vcs";

const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

describe("listReviewDocumentVersions", () => {
  it("lists document publishes only, marks current, drops unpresented tips", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "review-versions-"));
    tempRoots.push(root);
    const dir = path.join(root, "review");
    await mkdir(dir, { recursive: true });
    await reviewVcs.init(dir);
    await writeFile(path.join(dir, "review.mdx"), "# v1\n");
    const v1 = await reviewVcs.seal(dir, REVIEW_PUBLISH_CANDIDATE_MESSAGE);
    await writeFile(path.join(dir, "map.json"), "{}");
    await reviewVcs.seal(dir, "Publish Review software map");
    await writeFile(path.join(dir, "review.mdx"), "# v2\n");
    const v2 = await reviewVcs.seal(dir, REVIEW_PUBLISH_CANDIDATE_MESSAGE);
    await writeFile(
      path.join(dir, "review.mdx"),
      "# v3 sealed, never promoted\n",
    );
    await reviewVcs.seal(dir, REVIEW_PUBLISH_CANDIDATE_MESSAGE);

    const review = {
      dir,
      review: { presentedDocumentRevision: v2 },
    } as never;
    const versions = await listReviewDocumentVersions(review);

    expect(versions.map((version) => version.revision)).toEqual([v2, v1]);
    expect(versions[0]?.isCurrent).toBe(true);
    expect(versions[1]?.isCurrent).toBe(false);
    expect(versions[0]?.sealedAt).toBeGreaterThan(1_000_000_000_000);
  });

  it("returns [] when the review has no presented revision", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "review-versions-"));
    tempRoots.push(root);
    const review = { dir: root, review: {} } as never;
    await expect(listReviewDocumentVersions(review)).resolves.toEqual([]);
  });
});
