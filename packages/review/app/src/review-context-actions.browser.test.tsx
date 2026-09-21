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
