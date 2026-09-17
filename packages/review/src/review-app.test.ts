import { describe, expect, it, vi } from "vitest";

import { runReviewAppPick } from "./review-app";

const input = {
  cwd: "/repo",
  stdin: { isTTY: true } as NodeJS.ReadStream,
  stdout: process.stdout,
};

const runtime = {
  launch: async () => ({
    event: "app" as const,
    action: "launch" as const,
    state: "running" as const,
    instanceId: "desktop",
  }),
  readReviewDesktopDiscovery: async () => ({
    version: 3 as const,
    instanceId: "desktop",
    url: "http://127.0.0.1:5570",
    token: "secret",
    appPid: 1,
    serverPid: 2,
    startedAt: 3,
  }),
  resolveReviewRoot: async () => "/repo",
};

describe("native Review picker", () => {
  it("opens an explicit review through the authenticated JSON API", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) =>
      Response.json(
        init?.method === "POST"
          ? { ok: true }
          : { reviewId: "review", title: "Native" },
      ),
    );

    expect(
      await runReviewAppPick(
        { ...input, reviewUuid: "review" },
        { ...runtime, fetch },
      ),
    ).toEqual({
      event: "app",
      action: "pick",
      reviewUuid: "review",
      title: "Native",
    });
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      "http://127.0.0.1:5570/reviews-api/review",
      "http://127.0.0.1:5570/reviews-api/review/open",
    ]);
    expect(
      new Headers(fetch.mock.calls[1]?.[1]?.headers).get("x-review-token"),
    ).toBe("secret");
  });
  it("offers only undismissed reviews from the current repository and handles cancellation", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json([
        {
          reviewId: "native",
          title: "Native",
          repositoryPath: "/repo",
          createdAt: "2026-09-16",
          viewedAt: null,
          dismissedAt: null,
        },
        {
          reviewId: "dismissed",
          repositoryPath: "/repo",
          dismissedAt: "2026-09-16",
        },
        { reviewId: "other", repositoryPath: "/elsewhere" },
      ]),
    );

    const pickReview = vi.fn<typeof import("./review-app-picker").pickReview>(
      async () => null,
    );

    expect(
      await runReviewAppPick(input, { ...runtime, fetch, pickReview }),
    ).toBeNull();
    expect(pickReview.mock.calls[0]?.[0]).toEqual([
      {
        uuid: "native",
        title: "Native",
        status: "new",
        lastPublishedAt: "2026-09-16",
      },
    ]);
    expect(fetch).toHaveBeenCalledOnce();
  });
  it("surfaces a missing native review without trying a different store", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ error: "Not found" }, { status: 404 }),
    );

    await expect(
      runReviewAppPick(
        { ...input, reviewUuid: "missing" },
        { ...runtime, fetch },
      ),
    ).rejects.toThrow("Not found");
    expect(fetch).toHaveBeenCalledOnce();
  });
});
