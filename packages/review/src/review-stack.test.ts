import { describe, expect, it, vi } from "vitest";

import { type RunGitHubApi, resolveReviewStackLayers } from "./review-stack";

const publishedReview = (input: {
  uuid: string;
  repoKey: string;
  pullRequestNumber: number;
  title: string;
}) => ({
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
    const run = vi.fn<RunGitHubApi>(async () =>
      JSON.stringify([
        {
          pull_requests: [
            { number: 10, head: { ref: "a" } },
            { number: 20, head: { ref: "b" } },
            { number: 30, head: { ref: "c" } },
            { number: 40, head: { ref: "d" } },
          ],
        },
      ]),
    );

    const reviewA = publishedReview({
      uuid: "11111111-1111-4111-8111-111111111111",
      repoKey: "https://github.com/o/r",
      pullRequestNumber: 10,
      title: "Review A",
    });

    const reviewB = publishedReview({
      uuid: "22222222-2222-4222-8222-222222222222",
      repoKey: "https://github.com/o/r",
      pullRequestNumber: 20,
      title: "Review B",
    });

    await expect(
      resolveReviewStackLayers(
        {
          pullRequestUrl: "https://github.com/o/r/pull/20",
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
    expect(run).toHaveBeenCalledWith("repos/o/r/stacks?pull_request=20");
  });

  it("fails closed when stack discovery is unavailable or malformed", async () => {
    const subject = {
      pullRequestUrl: "https://github.com/o/r/pull/30",
    };

    await expect(
      resolveReviewStackLayers(subject, [], async () => {
        throw new Error("GitHub is unavailable");
      }),
    ).resolves.toEqual([]);
    await expect(
      resolveReviewStackLayers(subject, [], async () => "{}"),
    ).resolves.toEqual([]);
  });
  it("does not invoke GitHub for a review without a canonical PR binding", async () => {
    const run = vi.fn<RunGitHubApi>();

    for (const pullRequestUrl of [
      undefined,
      "https://example.com/o/r/pull/20",
    ]) {
      expect(
        await resolveReviewStackLayers({ pullRequestUrl }, [], run),
      ).toEqual([]);
    }

    expect(run).not.toHaveBeenCalled();
  });

  it("returns no layers for a standalone PR or a stack that does not contain it", async () => {
    const subject = { pullRequestUrl: "https://github.com/o/r/pull/20" };
    expect(
      await resolveReviewStackLayers(subject, [], async () => "[]"),
    ).toEqual([]);
    expect(
      await resolveReviewStackLayers(subject, [], async () =>
        JSON.stringify([
          { pull_requests: [{ number: 10, head: { ref: "unrelated" } }] },
        ]),
      ),
    ).toEqual([]);
  });

  it("does not attach reviews of the same PR number in another repository", async () => {
    const result = await resolveReviewStackLayers(
      { pullRequestUrl: "https://github.com/o/r/pull/20" },
      [
        publishedReview({
          uuid: "other",
          title: "Other repo",
          repoKey: "https://github.com/o/other",
          pullRequestNumber: 20,
        }),
      ],
      async () =>
        JSON.stringify([
          { pull_requests: [{ number: 20, head: { ref: "feature" } }] },
        ]),
    );

    expect(result).toEqual([
      {
        branch: "feature",
        pullRequestNumber: 20,
        pullRequestUrl: "https://github.com/o/r/pull/20",
        reviewUuid: null,
        reviewTitle: null,
        relation: "current",
      },
    ]);
  });
});
