import type { ReviewDescriptor } from "@dev.fast/review-protocol";
import { describe, expect, it, vi } from "vitest";

import { type RunGhStackView, resolveReviewStackLayers } from "./review-stack";

const publishedReview = (input: {
  uuid: string;
  repoKey: string;
  pullRequestNumber: number;
  title: string;
}): ReviewDescriptor => ({
  ...input,
  status: "awaiting-review",
  worktreePath: "/repo",
  sourceBranch: "feature",
  presentedDocumentRevision: "a".repeat(40),
  presentedSoftwareMapRevision: null,
  lastPublishedAt: "2026-09-01T00:00:00.000Z",
  available: true,
});

describe("resolveReviewStackLayers", () => {
  it("returns PR layers on both sides of the reviewed PR and matches local reviews", async () => {
    const run = vi.fn<RunGhStackView>(async () =>
      JSON.stringify({
        trunk: "main",
        currentBranch: "b",
        branches: [
          {
            name: "a",
            pr: { number: 10, url: "https://github.com/o/r/pull/10" },
          },
          {
            name: "b",
            pr: { number: 20, url: "https://github.com/o/r/pull/20" },
          },
          {
            name: "c",
            pr: { number: 30, url: "https://github.com/o/r/pull/30" },
          },
          {
            name: "d",
            pr: { number: 40, url: "https://github.com/o/r/pull/40" },
          },
        ],
      }),
    );
    const reviewA = publishedReview({
      uuid: "11111111-1111-4111-8111-111111111111",
      repoKey: "github.com/o/r",
      pullRequestNumber: 10,
      title: "Review A",
    });
    const reviewB = publishedReview({
      uuid: "22222222-2222-4222-8222-222222222222",
      repoKey: "github.com/o/r",
      pullRequestNumber: 20,
      title: "Review B",
    });

    await expect(
      resolveReviewStackLayers(
        {
          repoKey: "github.com/o/r",
          worktreePath: "/repo",
          pullRequestNumber: 20,
        },
        [reviewA, reviewB],
        run,
      ),
    ).resolves.toEqual([
      {
        branch: "a",
        pullRequestNumber: 10,
        pullRequestUrl: "https://github.com/o/r/pull/10",
        reviewUuid: reviewA.uuid,
        reviewTitle: "Review A",
        relation: "earlier",
      },
      {
        branch: "b",
        pullRequestNumber: 20,
        pullRequestUrl: "https://github.com/o/r/pull/20",
        reviewUuid: reviewB.uuid,
        reviewTitle: "Review B",
        relation: "current",
      },
      {
        branch: "c",
        pullRequestNumber: 30,
        pullRequestUrl: "https://github.com/o/r/pull/30",
        reviewUuid: null,
        reviewTitle: null,
        relation: "later",
      },
      {
        branch: "d",
        pullRequestNumber: 40,
        pullRequestUrl: "https://github.com/o/r/pull/40",
        reviewUuid: null,
        reviewTitle: null,
        relation: "later",
      },
    ]);
    expect(run).toHaveBeenCalledWith("/repo");
  });

  it("fails closed when stack discovery is unavailable or malformed", async () => {
    const subject = {
      repoKey: "github.com/o/r",
      worktreePath: "/repo",
      pullRequestNumber: 30,
    };
    await expect(
      resolveReviewStackLayers(subject, [], async () => {
        throw new Error("not in a stack");
      }),
    ).resolves.toEqual([]);
    await expect(
      resolveReviewStackLayers(subject, [], async () => "{}"),
    ).resolves.toEqual([]);
  });
});
