import { describe, expect, it, vi } from "vitest";

import { ReviewDesktopProtocolMismatchError } from "./desktop-discovery";
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
    const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) =>
      String(url).endsWith("/health")
        ? healthyResponse()
        : Response.json(
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
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
      "http://127.0.0.1:5570/health",
      "http://127.0.0.1:5570/reviews-api/review?full=true",
      "http://127.0.0.1:5570/reviews-api/review/open",
    ]);
    expect(
      new Headers(fetch.mock.calls[2]?.[1]?.headers).get("x-review-token"),
    ).toBe("secret");
  });
  it("asks for the snapshot the id lookup needs, not the block index", async () => {
    // Without `full`, GET /reviews-api/:id answers inspectSnapshot(): block
    // descriptors with no reviewId or title.
    const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
      if (String(url).endsWith("/health")) return healthyResponse();

      if (init?.method === "POST") return Response.json({ ok: true });

      return String(url).includes("full=true")
        ? Response.json({ reviewId: "review", version: 1, title: "Native" })
        : Response.json([{ id: "block-1", type: "markdown", label: "Native" }]);
    });

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
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
      "http://127.0.0.1:5570/health",
      "http://127.0.0.1:5570/reviews-api/review?full=true",
      "http://127.0.0.1:5570/reviews-api/review/open",
    ]);
  });
  it("offers only undismissed reviews from the current repository and handles cancellation", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (url) =>
      String(url).endsWith("/health")
        ? healthyResponse()
        : Response.json([
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
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("surfaces a missing native review without trying a different store", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (url) =>
      String(url).endsWith("/health")
        ? healthyResponse()
        : Response.json({ error: "Not found" }, { status: 404 }),
    );

    await expect(
      runReviewAppPick(
        { ...input, reviewUuid: "missing" },
        { ...runtime, fetch },
      ),
    ).rejects.toThrow("Not found");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("reports an unusable pointer instead of launching a second Desktop", async () => {
    const launch = vi.fn<typeof runtime.launch>(runtime.launch);

    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ ok: true }),
    );

    await expect(
      runReviewAppPick(
        { ...input, reviewUuid: "review" },
        {
          ...runtime,
          launch,
          readReviewDesktopDiscovery: async () => {
            throw new ReviewDesktopProtocolMismatchError(999);
          },
          fetch,
        },
      ),
    ).rejects.toThrow(
      "Review Desktop uses protocol 999, but this Review CLI needs protocol 3.",
    );
    expect(launch).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("names the recovery command when the pointer leads nowhere", async () => {
    const launch = vi.fn<typeof runtime.launch>(runtime.launch);

    await expect(
      runReviewAppPick(
        { ...input, reviewUuid: "review" },
        {
          ...runtime,
          launch,
          fetch: vi.fn<typeof globalThis.fetch>(async () => {
            throw new Error("connection refused");
          }),
        },
      ),
    ).rejects.toThrow(
      "Review Desktop is not ready. Run `review app launch`, then retry `review app pick`.",
    );
    expect(launch).not.toHaveBeenCalled();
  });
});

function healthyResponse(): Response {
  return Response.json({
    ok: true,
    instanceId: "desktop",
    desktopAttached: true,
  });
}
