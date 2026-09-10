import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  initLegacyReviewRepo,
  sealLegacyReviewCommit,
} from "./fixtures/legacy-reviews/legacy-review-git";
import { LEGACY_PUBLISH_CANDIDATE_MESSAGE } from "./legacy-review-import";
import { listReviewDocumentVersions } from "./review-document-versions";
import type { StoredReview } from "./review-home";
import {
  ensureReviewRegistration,
  insertPublicationInTransaction,
  withReviewStateTransaction,
} from "./review-state-db";
import { cleanupTempDirs, reviewHome } from "./review-test-utils";

afterEach(cleanupTempDirs);

const UUID = "11111111-1111-4111-8111-111111111111";

describe("listReviewDocumentVersions", () => {
  it("lists document publications newest first and marks the presented one", async () => {
    const home = await reviewHome();
    const dir = path.join(home, "reviews", UUID);
    await mkdir(dir, { recursive: true });
    ensureReviewRegistration(dir, home);
    const first = insertDocumentPublication(home, dir, {
      publicationId: "a".repeat(40),
      createdAt: "2026-09-01T00:00:00.000Z",
    });
    insertMapPublication(home, dir);
    const second = insertDocumentPublication(home, dir, {
      publicationId: "b".repeat(40),
      createdAt: "2026-09-02T00:00:00.000Z",
    });

    const versions = await listReviewDocumentVersions(
      storedReview(dir, second),
    );

    expect(versions).toEqual([
      {
        revision: second,
        sealedAt: Date.parse("2026-09-02T00:00:00.000Z"),
        isCurrent: true,
      },
      {
        revision: first,
        sealedAt: Date.parse("2026-09-01T00:00:00.000Z"),
        isCurrent: false,
      },
    ]);
  });

  it("returns [] when the review has no presented publication", async () => {
    const home = await reviewHome();
    const dir = path.join(home, "reviews", UUID);
    await mkdir(dir, { recursive: true });
    await expect(
      listReviewDocumentVersions({ dir, review: {} } as never),
    ).resolves.toEqual([]);
  });

  it("falls back to the private Git history for a review with no rows", async () => {
    const home = await reviewHome();
    const dir = path.join(home, "reviews", UUID);
    await mkdir(dir, { recursive: true });
    await initLegacyReviewRepo(dir);
    await writeFile(path.join(dir, "review.mdx"), "# v1\n");
    const v1 = await sealLegacyReviewCommit(
      dir,
      LEGACY_PUBLISH_CANDIDATE_MESSAGE,
    );
    await writeFile(path.join(dir, "map.json"), "{}");
    await sealLegacyReviewCommit(dir, "Publish Review software map");
    await writeFile(path.join(dir, "review.mdx"), "# v2\n");
    const v2 = await sealLegacyReviewCommit(
      dir,
      LEGACY_PUBLISH_CANDIDATE_MESSAGE,
    );
    await writeFile(path.join(dir, "review.mdx"), "# v3 never promoted\n");
    await sealLegacyReviewCommit(dir, LEGACY_PUBLISH_CANDIDATE_MESSAGE);

    const versions = await listReviewDocumentVersions(storedReview(dir, v2));

    expect(versions.map((version) => version.revision)).toEqual([v2, v1]);
    expect(versions[0]?.isCurrent).toBe(true);
    expect(versions[0]?.sealedAt).toBeGreaterThan(1_000_000_000_000);
  });
});

function storedReview(dir: string, presented: string): StoredReview {
  return { dir, review: { presentedDocumentRevision: presented } } as never;
}

function insertDocumentPublication(
  home: string,
  dir: string,
  input: { publicationId: string; createdAt: string },
): string {
  withReviewStateTransaction(home, (tx) =>
    insertPublicationInTransaction(tx, dir, {
      publicationId: input.publicationId,
      kind: "document",
      record: { kind: "document", createdAt: input.createdAt },
      createdAt: input.createdAt,
      operation: "publish",
      artifactHash: null,
      previousPublicationId: null,
    }),
  );
  return input.publicationId;
}

/** A map row must not appear in the document listing. */
function insertMapPublication(home: string, dir: string): void {
  withReviewStateTransaction(home, (tx) =>
    insertPublicationInTransaction(tx, dir, {
      publicationId: "c".repeat(40),
      kind: "map",
      record: { kind: "map", createdAt: "2026-09-01T12:00:00.000Z" },
      createdAt: "2026-09-01T12:00:00.000Z",
      operation: "map-publish",
      artifactHash: null,
      previousPublicationId: null,
    }),
  );
}
