// @vitest-environment jsdom

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
    (
      globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT?: boolean;
      }
    ).IS_REACT_ACT_ENVIRONMENT = true;
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

  it("loads a terminal outcome and resolved refs through the canvas bridge", async () => {
    vi.stubGlobal("fetch", undefined);

    const statusSession = testReviewSession(
      {},
      {
        request: async () =>
          new Response(
            JSON.stringify({
              session: {
                reviewStatus: "accepted",
                resolvedBaseRef: "base-sha",
                headRef: "head-sha",
              },
            }),
            { headers: { "content-type": "application/json" } },
          ),
      },
    );

    await renderProvider(statusSession);

    expect(requireReview()).toMatchObject({
      submissionOutcome: "approved",
      resolvedBaseRef: "base-sha",
      resolvedHeadRef: "head-sha",
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
