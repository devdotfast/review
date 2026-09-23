import { describe, expect, it, vi } from "vitest";

import {
  type RunGitHubApi,
  resolveWhiteboardStackLayers,
} from "./whiteboard-stack";

const publishedWhiteboard = (input: {
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

describe("resolveWhiteboardStackLayers", () => {
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

    const whiteboardA = publishedWhiteboard({
      uuid: "11111111-1111-4111-8111-111111111111",
      repoKey: "https://github.com/o/r",
      pullRequestNumber: 10,
      title: "Review A",
    });

    const whiteboardB = publishedWhiteboard({
      uuid: "22222222-2222-4222-8222-222222222222",
      repoKey: "https://github.com/o/r",
      pullRequestNumber: 20,
      title: "Review B",
    });

    await expect(
      resolveWhiteboardStackLayers(
        {
          pullRequestUrl: "https://github.com/o/r/pull/20",
        },
        [whiteboardA, whiteboardB],
        run,
      ),
    ).resolves.toEqual([
      {
        branch: "a",
        pullRequestNumber: 10,
        pullRequestUrl: "https://github.com/o/r/pull/10",
        sessionId: whiteboardA.uuid,
        whiteboardTitle: "Review A",
        relation: "earlier",
      },
      {
        branch: "b",
        pullRequestNumber: 20,
        pullRequestUrl: "https://github.com/o/r/pull/20",
        sessionId: whiteboardB.uuid,
        whiteboardTitle: "Review B",
        relation: "current",
      },
      {
        branch: "c",
        pullRequestNumber: 30,
        pullRequestUrl: "https://github.com/o/r/pull/30",
        sessionId: null,
        whiteboardTitle: null,
        relation: "later",
      },
      {
        branch: "d",
        pullRequestNumber: 40,
        pullRequestUrl: "https://github.com/o/r/pull/40",
        sessionId: null,
        whiteboardTitle: null,
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
      resolveWhiteboardStackLayers(subject, [], async () => {
        throw new Error("GitHub is unavailable");
      }),
    ).resolves.toEqual([]);
    await expect(
      resolveWhiteboardStackLayers(subject, [], async () => "{}"),
    ).resolves.toEqual([]);
  });
  it("does not invoke GitHub for a review without a canonical PR binding", async () => {
    const run = vi.fn<RunGitHubApi>();

    for (const pullRequestUrl of [
      undefined,
      "https://example.com/o/r/pull/20",
    ]) {
      expect(
        await resolveWhiteboardStackLayers({ pullRequestUrl }, [], run),
      ).toEqual([]);
    }

    expect(run).not.toHaveBeenCalled();
  });

  it("returns no layers for a standalone PR or a stack that does not contain it", async () => {
    const subject = { pullRequestUrl: "https://github.com/o/r/pull/20" };
    expect(
      await resolveWhiteboardStackLayers(subject, [], async () => "[]"),
    ).toEqual([]);
    expect(
      await resolveWhiteboardStackLayers(subject, [], async () =>
        JSON.stringify([
          { pull_requests: [{ number: 10, head: { ref: "unrelated" } }] },
        ]),
      ),
    ).toEqual([]);
  });

  it("does not attach reviews of the same PR number in another repository", async () => {
    const result = await resolveWhiteboardStackLayers(
      { pullRequestUrl: "https://github.com/o/r/pull/20" },
      [
        publishedWhiteboard({
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
        sessionId: null,
        whiteboardTitle: null,
        relation: "current",
      },
    ]);
  });
});
