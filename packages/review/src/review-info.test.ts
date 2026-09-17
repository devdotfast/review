import { afterEach, expect, it, vi } from "vitest";

import { runReviewInfo } from "./review-info";

const runtime = {
  requireHealthyReviewDesktop: async () => ({
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

afterEach(() => vi.unstubAllGlobals());

it("reports the native catalog with pins and versions, filtering the current repository", async () => {
  const current = {
    reviewId: "current",
    repositoryPath: "/repo",
    version: 3,
    pins: { base: "a", head: "b" },
    dismissedAt: null,
  };

  const dismissed = { ...current, reviewId: "dismissed", dismissedAt: "today" };
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json([
        current,
        dismissed,
        { ...current, reviewId: "other", repositoryPath: "/other" },
      ]),
    ),
  );
  expect(await runReviewInfo({ cwd: "/repo" }, runtime)).toEqual({
    event: "info",
    reviews: [current],
  });
  expect(
    (await runReviewInfo({ cwd: "/repo", all: true }, runtime)).reviews,
  ).toEqual([current, dismissed]);
  expect(
    (await runReviewInfo({ cwd: "/repo", reviewUuid: "dismissed" }, runtime))
      .reviews,
  ).toEqual([dismissed]);
  await expect(
    runReviewInfo({ cwd: "/repo", reviewUuid: "missing" }, runtime),
  ).rejects.toThrow("Review not found");
});
