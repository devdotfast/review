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
    sessionId: "current",
    repositoryPath: "/repo",
    version: 3,
    pins: { base: "a", head: "b" },
    dismissedAt: null,
  };

  const dismissed = {
    ...current,
    sessionId: "dismissed",
    dismissedAt: "today",
  };

  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json([
        current,
        dismissed,
        { ...current, sessionId: "other", repositoryPath: "/other" },
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
    (await runReviewInfo({ cwd: "/repo", sessionId: "dismissed" }, runtime))
      .reviews,
  ).toEqual([dismissed]);
  await expect(
    runReviewInfo({ cwd: "/repo", sessionId: "missing" }, runtime),
  ).rejects.toThrow("Review not found");
});

it("lists the catalog at the mounted route, not a trailing-slash child", async () => {
  const review = {
    sessionId: "current",
    repositoryPath: "/repo",
    version: 3,
    pins: { base: "a", head: "b" },
    dismissedAt: null,
  };

  // Hono matches the "/sessions-api" mount strictly, so "/sessions-api/" 404s.
  const fetch = vi.fn<typeof globalThis.fetch>(async (url) =>
    String(url) === "http://127.0.0.1:5570/sessions-api"
      ? Response.json([review])
      : Response.json({ error: "Not found." }, { status: 404 }),
  );

  vi.stubGlobal("fetch", fetch);

  expect((await runReviewInfo({ cwd: "/repo" }, runtime)).reviews).toEqual([
    review,
  ]);
  expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
    "http://127.0.0.1:5570/sessions-api",
  ]);
});
