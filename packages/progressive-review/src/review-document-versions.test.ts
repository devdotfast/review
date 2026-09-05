import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  REVIEW_PUBLISH_CANDIDATE_MESSAGE,
  appendPromotedDocumentRevision,
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

const sha = (char: string) => char.repeat(40);

describe("listReviewDocumentVersions", () => {
  it("lists promoted revisions only, marks current, and drops unpromoted seals", async () => {
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
    // A later sealed candidate that never reaches promotion (an unpromoted tip).
    await writeFile(
      path.join(dir, "review.mdx"),
      "# v3 sealed, never promoted\n",
    );
    const v3 = await reviewVcs.seal(dir, REVIEW_PUBLISH_CANDIDATE_MESSAGE);

    const review = {
      dir,
      review: {
        presentedDocumentRevision: v2,
        promotedDocumentRevisions: [v2, v1],
      },
    } as never;
    const versions = await listReviewDocumentVersions(review);

    expect(versions.map((version) => version.revision)).toEqual([v2, v1]);
    expect(versions[0]?.isCurrent).toBe(true);
    expect(versions[1]?.isCurrent).toBe(false);
    expect(versions.map((version) => version.revision)).not.toContain(v3);
    expect(versions[0]?.sealedAt).toBeGreaterThan(1_000_000_000_000);
  });

  it("excludes a sealed orphan left by a failed publish that is interior to history", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "review-versions-"));
    tempRoots.push(root);
    const dir = path.join(root, "review");
    await mkdir(dir, { recursive: true });
    await reviewVcs.init(dir);
    await writeFile(path.join(dir, "review.mdx"), "# v1 promoted\n");
    const v1 = await reviewVcs.seal(dir, REVIEW_PUBLISH_CANDIDATE_MESSAGE);
    // A failed publish seals this candidate but never promotes it; a later
    // successful publish of v2 makes it interior to the promoted history.
    await writeFile(path.join(dir, "review.mdx"), "# orphan, never promoted\n");
    const orphan = await reviewVcs.seal(dir, REVIEW_PUBLISH_CANDIDATE_MESSAGE);
    await writeFile(path.join(dir, "review.mdx"), "# v2 promoted\n");
    const v2 = await reviewVcs.seal(dir, REVIEW_PUBLISH_CANDIDATE_MESSAGE);

    const review = {
      dir,
      review: {
        presentedDocumentRevision: v2,
        promotedDocumentRevisions: [v2, v1],
      },
    } as never;
    const versions = await listReviewDocumentVersions(review);

    expect(versions.map((version) => version.revision)).toEqual([v2, v1]);
    expect(versions.map((version) => version.revision)).not.toContain(orphan);
    expect(versions[0]?.isCurrent).toBe(true);
    expect(versions[1]?.isCurrent).toBe(false);
  });

  it("falls back to the presented revision when promoted history is unrecorded, excluding orphan seals", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "review-versions-"));
    tempRoots.push(root);
    const dir = path.join(root, "review");
    await mkdir(dir, { recursive: true });
    await reviewVcs.init(dir);
    // A review promoted before `promotedDocumentRevisions` was recorded: a
    // failed publish left an orphan, then a successful publish set the current.
    await writeFile(path.join(dir, "review.mdx"), "# orphan, never promoted\n");
    const orphan = await reviewVcs.seal(dir, REVIEW_PUBLISH_CANDIDATE_MESSAGE);
    await writeFile(path.join(dir, "review.mdx"), "# current promoted\n");
    const current = await reviewVcs.seal(dir, REVIEW_PUBLISH_CANDIDATE_MESSAGE);

    const review = {
      dir,
      review: { presentedDocumentRevision: current },
    } as never;
    const versions = await listReviewDocumentVersions(review);

    expect(versions.map((version) => version.revision)).toEqual([current]);
    expect(versions.map((version) => version.revision)).not.toContain(orphan);
    expect(versions[0]?.isCurrent).toBe(true);
  });

  it("returns [] when the review has no presented revision", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "review-versions-"));
    tempRoots.push(root);
    const review = { dir: root, review: {} } as never;
    await expect(listReviewDocumentVersions(review)).resolves.toEqual([]);
  });
});

describe("appendPromotedDocumentRevision", () => {
  it("appends a newly promoted revision to a recorded history without duplicates", () => {
    const stored = {
      dir: "",
      review: {
        presentedDocumentRevision: sha("a"),
        promotedDocumentRevisions: [sha("a"), sha("b")],
      },
    } as never;
    expect(appendPromotedDocumentRevision(stored, sha("c"))).toEqual([
      sha("a"),
      sha("b"),
      sha("c"),
    ]);
    // Re-promoting an already-recorded revision does not duplicate it.
    expect(appendPromotedDocumentRevision(stored, sha("b"))).toEqual([
      sha("a"),
      sha("b"),
    ]);
  });

  it("seeds the history from the previously-presented revision when it is unrecorded", () => {
    const stored = {
      dir: "",
      review: { presentedDocumentRevision: sha("a") },
    } as never;
    // A review promoted before the field existed keeps its prior published
    // version alongside the newly promoted one.
    expect(appendPromotedDocumentRevision(stored, sha("b"))).toEqual([
      sha("a"),
      sha("b"),
    ]);
  });

  it("records just the new revision for a review that had no prior promotion", () => {
    const stored = {
      dir: "",
      review: { presentedDocumentRevision: null },
    } as never;
    expect(appendPromotedDocumentRevision(stored, sha("b"))).toEqual([
      sha("b"),
    ]);
    // The previously-presented revision equal to the new one is not duplicated.
    const same = {
      dir: "",
      review: { presentedDocumentRevision: sha("b") },
    } as never;
    expect(appendPromotedDocumentRevision(same, sha("b"))).toEqual([sha("b")]);
  });

  it("does not mutate the input stored review", () => {
    const recorded = [sha("a"), sha("b")];
    const stored = {
      dir: "",
      review: {
        presentedDocumentRevision: sha("a"),
        promotedDocumentRevisions: recorded,
      },
    } as never;
    appendPromotedDocumentRevision(stored, sha("c"));
    expect(recorded).toEqual([sha("a"), sha("b")]);
  });
});
