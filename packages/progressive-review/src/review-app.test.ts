import {
  REVIEW_DESKTOP_DISCOVERY_VERSION,
  REVIEW_SCHEMA_VERSION,
  type ReviewDesktopDiscovery,
} from "@dev.fast/review-protocol";
import { describe, expect, it, vi } from "vitest";

import { runReviewApp } from "./review-app";

function fakeTty(): NodeJS.ReadStream {
  return { isTTY: true } as NodeJS.ReadStream;
}
import type { StoredReview } from "./review-home";

const discovery: ReviewDesktopDiscovery = {
  version: REVIEW_DESKTOP_DISCOVERY_VERSION,
  instanceId: "desktop-1",
  url: "http://127.0.0.1:5570",
  appPid: 1,
  serverPid: 2,
  token: "desktop-secret",
  startedAt: 3,
};

describe("review app", () => {
  it("opens the requested Review through Desktop without exposing private handles", async () => {
    const older = storedReview("older", "2026-07-29T09:00:00.000Z");
    const selected = storedReview("latest", "2026-07-29T10:00:00.000Z");
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({
        sessionId: "session-1",
        url: `${discovery.url}/sessions/session-1`,
      }),
    );

    await expect(
      runReviewApp(
        {
          cwd: "/repo",
          stdin: fakeTty(),
          stdout: process.stdout,
          reviewUuid: selected.review.uuid,
        },
        {
          launch: async () => ({
            event: "app",
            action: "launch",
            state: "running",
            instanceId: discovery.instanceId,
          }),
          resolveReviewRoot: async () => "/repo",
          listReviews: async () => ({
            reviews: [older, selected],
            errors: [],
          }),
          readReviewDesktopDiscovery: async () => discovery,
          fetch,
        },
      ),
    ).resolves.toEqual({
      event: "app",
      action: "pick",
      reviewUuid: selected.review.uuid,
      title: selected.review.title,
    });
    expect(fetch).toHaveBeenCalledWith(
      `${discovery.url}/reviews/${selected.review.uuid}/open`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-review-token": discovery.token,
        },
        body: "{}",
      },
    );
  });

  it("selects an explicit Review UUID", async () => {
    const selected = storedReview("selected", null);
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ sessionId: "session-2" }),
    );

    await expect(
      runReviewApp(
        {
          cwd: "/repo",
          stdin: fakeTty(),
          stdout: process.stdout,
          reviewUuid: selected.review.uuid,
          view: "diff",
        },
        {
          launch: async () => ({
            event: "app",
            action: "launch",
            state: "running",
            instanceId: discovery.instanceId,
          }),
          resolveReviewRoot: async () => "/repo",
          listReviews: async () => ({
            reviews: [storedReview("other", null), selected],
            errors: [],
          }),
          readReviewDesktopDiscovery: async () => discovery,
          fetch,
        },
      ),
    ).resolves.toEqual({
      event: "app",
      action: "pick",
      reviewUuid: selected.review.uuid,
      title: selected.review.title,
    });
    expect(fetch).toHaveBeenCalledWith(
      `${discovery.url}/reviews/${selected.review.uuid}/open`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-review-token": discovery.token,
        },
        body: JSON.stringify({ view: "diff" }),
      },
    );
  });

  it("requires a TTY only for the interactive picker", async () => {
    await expect(
      runReviewApp(
        {
          cwd: "/repo",
          stdin: { isTTY: false } as NodeJS.ReadStream,
          stdout: process.stdout,
        },
        {
          launch: async () => ({
            event: "app",
            action: "launch",
            state: "running",
            instanceId: discovery.instanceId,
          }),
          resolveReviewRoot: async () => "/repo",
          listReviews: async () => ({
            reviews: [storedReview("published", null)],
            errors: [],
          }),
        },
      ),
    ).rejects.toThrow(
      "review app pick needs a terminal without --review. Pass --review <uuid> or run it in a terminal.",
    );
  });
});

function storedReview(
  suffix: string,
  lastPublishedAt: string | null,
): StoredReview {
  const uuid = `${suffix.padEnd(8, "0").slice(0, 8)}-0000-4000-8000-000000000000`;
  return {
    dir: `/reviews/${uuid}`,
    review: {
      schemaVersion: REVIEW_SCHEMA_VERSION,
      uuid,
      repoKey: "repo",
      worktreePath: "/repo",
      baseRef: "main",
      baseCommit: "base",
      sourceCommit: "head",
      sourceIdentity: { kind: "git-branch", name: "feature" },
      title: suffix,
      sourceSession: "disabled:review",
      status: "awaiting-review",
      presentedDocumentRevision: "published-revision",
      presentedSoftwareMapRevision: null,
      createdAt: "2026-07-29T08:00:00.000Z",
      lastPublishedAt,
    },
  };
}
