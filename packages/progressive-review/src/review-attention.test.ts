import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  REVIEW_SCHEMA_VERSION,
  type ReviewRecord,
} from "@dev.fast/review-protocol";
import { afterEach, describe, expect, it } from "vitest";

import {
  dismissReview,
  isReviewReapable,
  markReviewViewed,
  resetReviewAttention,
  restoreReview,
  reviewReapsAt,
  selectReapableReviews,
} from "./review-attention";
import type { StoredReview } from "./review-home";

const DISMISSED_AT = "2026-01-01T00:00:00.000Z";

describe("review attention deadlines", () => {
  it("has no deadline while the review is not dismissed", () => {
    expect(reviewReapsAt({ dismissedAt: null }, 30)).toBeNull();
  });

  it("has no deadline when retention is off", () => {
    expect(reviewReapsAt({ dismissedAt: DISMISSED_AT }, null)).toBeNull();
  });

  it("counts the retention days from the dismissal", () => {
    expect(reviewReapsAt({ dismissedAt: DISMISSED_AT }, 30)).toBe(
      "2026-01-31T00:00:00.000Z",
    );
  });

  it("has no deadline when the stamp is unreadable", () => {
    expect(reviewReapsAt({ dismissedAt: "not a date" }, 30)).toBeNull();
  });

  it("becomes reapable on the deadline, not before", () => {
    const review = { dismissedAt: DISMISSED_AT };
    expect(isReviewReapable(review, 30, new Date("2026-01-30T23:59:59Z"))).toBe(
      false,
    );
    expect(isReviewReapable(review, 30, new Date("2026-01-31T00:00:00Z"))).toBe(
      true,
    );
  });
});

describe("selecting reapable reviews", () => {
  const overdue = storedReview("overdue", { dismissedAt: DISMISSED_AT });
  const active = storedReview("active", { dismissedAt: null });
  const now = new Date("2026-03-01T00:00:00Z");

  it("selects only the dismissed reviews past their deadline", () => {
    expect(selectReapableReviews([overdue, active], 30, now)).toEqual([
      overdue,
    ]);
  });

  it("selects nothing when retention is off", () => {
    expect(selectReapableReviews([overdue, active], null, now)).toEqual([]);
  });
});

describe("review attention stamps", () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      directories
        .splice(0)
        .map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  async function makeReview(
    patch: Partial<ReviewRecord> = {},
  ): Promise<StoredReview> {
    const dir = await mkdtemp(path.join(os.tmpdir(), "review-attention-"));
    directories.push(dir);
    const stored = {
      dir,
      review: {
        ...storedReview("3b241101-e2bb-4255-8caf-4136c566a962", patch).review,
      },
    };
    await writeFile(
      path.join(dir, "review.json"),
      JSON.stringify(stored.review),
    );
    return stored;
  }

  async function readStamps(
    stored: StoredReview,
  ): Promise<Pick<ReviewRecord, "viewedAt" | "dismissedAt">> {
    const raw: ReviewRecord = JSON.parse(
      await readFile(path.join(stored.dir, "review.json"), "utf8"),
    );
    return { viewedAt: raw.viewedAt, dismissedAt: raw.dismissedAt };
  }

  it("stamps the first view and keeps it on a later view", async () => {
    const stored = await makeReview();
    const first = await markReviewViewed(stored, new Date("2026-02-01Z"));
    expect(first.review.viewedAt).toBe("2026-02-01T00:00:00.000Z");
    expect(await readStamps(first)).toMatchObject({
      viewedAt: "2026-02-01T00:00:00.000Z",
    });

    const second = await markReviewViewed(first, new Date("2026-02-09Z"));
    expect(second).toBe(first);
  });

  it("stamps a dismissal once", async () => {
    const stored = await makeReview();
    const dismissed = await dismissReview(stored, new Date("2026-02-01Z"));
    expect(dismissed.review.dismissedAt).toBe("2026-02-01T00:00:00.000Z");

    const again = await dismissReview(dismissed, new Date("2026-02-09Z"));
    expect(again).toBe(dismissed);
  });

  it("clears the dismissal on a restore", async () => {
    const stored = await makeReview();
    const dismissed = await dismissReview(stored, new Date("2026-02-01Z"));
    const restored = await restoreReview(dismissed);
    expect(restored.review.dismissedAt).toBeNull();
    expect(await readStamps(restored)).toMatchObject({ dismissedAt: null });

    expect(await restoreReview(restored)).toBe(restored);
  });

  it("clears both stamps when a publish resets the attention", async () => {
    const stored = await makeReview();
    const viewed = await markReviewViewed(stored, new Date("2026-02-01Z"));
    const dismissed = await dismissReview(viewed, new Date("2026-02-02Z"));

    const reset = await resetReviewAttention(dismissed);
    expect(await readStamps(reset)).toEqual({
      viewedAt: null,
      dismissedAt: null,
    });

    expect(await resetReviewAttention(reset)).toBe(reset);
  });
});

function storedReview(
  uuid: string,
  patch: Partial<ReviewRecord> = {},
): StoredReview {
  return {
    dir: path.join(os.tmpdir(), `review-attention-${uuid}`),
    review: {
      schemaVersion: REVIEW_SCHEMA_VERSION,
      uuid,
      repoKey: "repo",
      worktreePath: "/tmp/worktree",
      baseRef: "main",
      baseCommit: "0".repeat(40),
      sourceCommit: null,
      sourceIdentity: null,
      pullRequestNumber: null,
      pullRequestUrl: null,
      title: "Attention",
      sourceSession: "disabled:review",
      status: "draft",
      presentedDocumentRevision: null,
      presentedSoftwareMapRevision: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      lastPublishedAt: null,
      ...patch,
    },
  };
}
