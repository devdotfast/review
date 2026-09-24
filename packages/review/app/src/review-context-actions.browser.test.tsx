import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ReviewSessionProvider } from "./host/review-session";
import { ReviewProvider, useReview } from "./review-context";
import { testReviewSession } from "./review-session-test-utils";

const roots: Array<ReturnType<typeof createRoot>> = [];

let review: ReturnType<typeof useReview> | null = null;

function CaptureReview() {
  review = useReview();

  return null;
}

describe("ReviewProvider session facts", () => {
  beforeEach(() => {
    review = null;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(async () => {
    await act(async () => {
      for (const root of roots.splice(0)) root.unmount();
    });
    document.body.replaceChildren();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("uses the pins from the displayed native review", async () => {
    vi.stubGlobal("fetch", undefined);

    const statusSession = testReviewSession();
    statusSession.review!.pins = { base: "base-sha", head: "head-sha" };

    await renderProvider(statusSession);

    await vi.waitFor(() => {
      expect(requireReview()).toMatchObject({
        submissionOutcome: null,
        resolvedBaseRef: "base-sha",
        resolvedHeadRef: "head-sha",
      });
    });
  });

  it("reports a topbar dismissal once the dismissal succeeds", async () => {
    const session = testReviewSession();
    const posted: unknown[] = [];
    session.fetch = async (path, init) => {
      if (path === "/telemetry/event")
        posted.push(JSON.parse(String(init?.body)));

      return new Response("{}");
    };

    session.review!.dismiss = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(undefined);

    await renderProvider(session);

    await expect(requireReview().dismissReview()).rejects.toThrow("offline");
    expect(posted).toEqual([]);

    await act(() => requireReview().dismissReview());
    expect(posted).toMatchObject([
      { name: "review_dismissed", properties: { via: "review_topbar" } },
    ]);
  });
});

async function renderProvider(
  reviewSession: ReturnType<typeof testReviewSession>,
) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(
      <ReviewSessionProvider session={reviewSession}>
        <ReviewProvider>
          <CaptureReview />
        </ReviewProvider>
      </ReviewSessionProvider>,
    );
    await Promise.resolve();
    await Promise.resolve();
  });
}

function requireReview(): ReturnType<typeof useReview> {
  if (!review) throw new Error("Review context was not captured");

  return review;
}
