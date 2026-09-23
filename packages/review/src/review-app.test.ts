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
    const fetch = desktopFetch();

    expect(
      await runReviewAppPick(
        { ...input, sessionId: "review" },
        { ...runtime, fetch },
      ),
    ).toEqual({
      event: "app",
      action: "pick",
      sessionId: "review",
      title: "Native",
    });
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
      "http://127.0.0.1:5570/health",
      "http://127.0.0.1:5570/sessions-api/review?full=true",
      "http://127.0.0.1:5570/sessions-api/review/open",
    ]);
    expect(
      new Headers(fetch.mock.calls[2]?.[1]?.headers).get("x-review-token"),
    ).toBe("secret");
  });
  it("asks for the snapshot the id lookup needs, not the block index", async () => {
    // Unversioned reads answer block descriptors, not the summary.
    const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
      if (String(url).endsWith("/health")) return healthyResponse();

      if (init?.method === "POST") return Response.json({ ok: true });

      return String(url).includes("full=true")
        ? Response.json({ sessionId: "review", version: 1, title: "Native" })
        : Response.json([{ id: "block-1", type: "markdown", label: "Native" }]);
    });

    expect(
      await runReviewAppPick(
        { ...input, sessionId: "review" },
        { ...runtime, fetch },
      ),
    ).toEqual({
      event: "app",
      action: "pick",
      sessionId: "review",
      title: "Native",
    });
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
      "http://127.0.0.1:5570/health",
      "http://127.0.0.1:5570/sessions-api/review?full=true",
      "http://127.0.0.1:5570/sessions-api/review/open",
    ]);
  });
  it("offers only undismissed reviews from the current repository and handles cancellation", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (url) =>
      String(url).endsWith("/health")
        ? healthyResponse()
        : Response.json([
            {
              sessionId: "native",
              title: "Native",
              repositoryPath: "/repo",
              createdAt: "2026-09-16",
              viewedAt: null,
              dismissedAt: null,
            },
            {
              sessionId: "dismissed",
              repositoryPath: "/repo",
              dismissedAt: "2026-09-16",
            },
            { sessionId: "other", repositoryPath: "/elsewhere" },
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
        { ...input, sessionId: "missing" },
        { ...runtime, fetch },
      ),
    ).rejects.toThrow("Not found");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("launches Desktop when no pointer exists yet, then opens the review", async () => {
    const launch = vi.fn<typeof runtime.launch>(runtime.launch);
    let reads = 0;

    const fetch = vi.fn<typeof globalThis.fetch>(async (url) =>
      String(url).endsWith("/health")
        ? healthyResponse()
        : Response.json({ sessionId: "review", title: "Native" }),
    );

    expect(
      await runReviewAppPick(
        { ...input, sessionId: "review" },
        {
          ...runtime,
          launch,
          readReviewDesktopDiscovery: async () =>
            reads++ === 0 ? null : runtime.readReviewDesktopDiscovery(),
          fetch,
        },
      ),
    ).toEqual({
      event: "app",
      action: "pick",
      sessionId: "review",
      title: "Native",
    });
    expect(launch).toHaveBeenCalledOnce();
  });

  it("reports an unusable pointer instead of launching a second Desktop", async () => {
    const launch = vi.fn<typeof runtime.launch>(runtime.launch);

    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ ok: true }),
    );

    await expect(
      runReviewAppPick(
        { ...input, sessionId: "review" },
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
        { ...input, sessionId: "review" },
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

  it("focuses a running Desktop after opening when asked", async () => {
    const fetch = desktopFetch();

    await runReviewAppPick(
      { ...input, sessionId: "review", focus: true },
      { ...runtime, fetch },
    );
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
      "http://127.0.0.1:5570/health",
      "http://127.0.0.1:5570/sessions-api/review?full=true",
      "http://127.0.0.1:5570/sessions-api/review/open",
      "http://127.0.0.1:5570/app/focus",
    ]);
    expect(
      new Headers(fetch.mock.calls[3]?.[1]?.headers).get("x-review-token"),
    ).toBe("secret");
  });

  it("forwards focus to the launcher when no Desktop is running", async () => {
    const launch = vi.fn<typeof runtime.launch>(async () => ({
      event: "app",
      action: "launch",
      state: "running",
      instanceId: "desktop",
    }));

    let launched = false;

    const fetch = desktopFetch();

    await runReviewAppPick(
      { ...input, sessionId: "review", focus: true },
      {
        ...runtime,
        launch,
        readReviewDesktopDiscovery: async () => {
          if (launched) return runtime.readReviewDesktopDiscovery();
          launched = true;

          return null;
        },
        fetch,
      },
    );
    expect(launch).toHaveBeenCalledWith({ focus: true });
    expect(fetch.mock.calls.map(([url]) => String(url))).not.toContain(
      "http://127.0.0.1:5570/app/focus",
    );
  });
});

/** Healthy Desktop: answers the summary read, accepts every post. */
function desktopFetch() {
  return vi.fn<typeof globalThis.fetch>(async (url, init) =>
    String(url).endsWith("/health")
      ? healthyResponse()
      : Response.json(
          init?.method === "POST"
            ? { ok: true }
            : { sessionId: "review", title: "Native" },
        ),
  );
}

function healthyResponse(): Response {
  return Response.json({
    ok: true,
    instanceId: "desktop",
    desktopAttached: true,
  });
}
