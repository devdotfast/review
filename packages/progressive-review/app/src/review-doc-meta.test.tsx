// @vitest-environment jsdom

import type { ReviewCanvasBridge } from "@dev.fast/review-protocol";
import { act } from "react";
import { type Root, createRoot, hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ReviewSessionProvider,
  createReviewSession,
} from "./host/review-session";
import { ReviewDocumentMetaLine } from "./review-doc-meta";
import {
  type ReviewInitialData,
  ReviewInitialDataContext,
} from "./review-initial-data-context";
import {
  testReviewBridge,
  testReviewSession,
} from "./review-session-test-utils";

const initialData: ReviewInitialData = {
  comments: {},
  sessionResolvedBaseRef: null,
  documentMeta: { updatedAtMs: Date.UTC(2026, 6, 22, 12, 0) },
  diffStats: { files: [{ additions: 2, deletions: 1 }] },
  softwareMapResolvedData: [],
};
const stackInitialData: ReviewInitialData = {
  ...initialData,
  documentMeta: { pullRequestNumber: 20 },
};

let root: Root | null = null;
const session = testReviewSession();

describe("ReviewDocumentMetaLine", () => {
  beforeEach(() => {
    (
      globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT?: boolean;
      }
    ).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(async () => {
    if (root) {
      await act(async () => root?.unmount());
      root = null;
    }
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it("hydrates when the relative update time changes after SSR", async () => {
    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(Date.UTC(2026, 6, 22, 12, 1));
    const tree = (
      <ReviewSessionProvider session={session}>
        <ReviewInitialDataContext.Provider value={initialData}>
          <ReviewDocumentMetaLine />
        </ReviewInitialDataContext.Provider>
      </ReviewSessionProvider>
    );
    const serverHtml = renderToString(tree);
    const container = document.createElement("div");
    container.innerHTML = serverHtml;
    document.body.append(container);

    now.mockReturnValue(Date.UTC(2026, 6, 22, 12, 5));
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    await act(async () => {
      root = hydrateRoot(container, tree);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(
      consoleError.mock.calls.map((call) => call.map(String).join(" ")),
    ).not.toEqual(
      expect.arrayContaining([expect.stringContaining("Hydration failed")]),
    );
    expect(container.textContent).toContain("updated 5 min ago");
  });

  it("opens an available later Review in a background tab", async () => {
    const post = vi.fn<ReviewCanvasBridge["post"]>(async () => ({ ok: true }));
    const stackSession = createReviewSession(
      testReviewBridge(
        {},
        {
          request: async (url) => {
            expect(url).toContain("/stack");
            return Response.json({
              layers: [
                {
                  branch: "feature-b",
                  relation: "current",
                  pullRequestNumber: 20,
                  pullRequestUrl: "https://github.com/o/r/pull/20",
                  reviewUuid: "22222222-2222-4222-8222-222222222222",
                  reviewTitle: "Review B",
                },
                {
                  branch: "feature-c",
                  relation: "later",
                  pullRequestNumber: 30,
                  pullRequestUrl: "https://github.com/o/r/pull/30",
                  reviewUuid: "11111111-1111-4111-8111-111111111111",
                  reviewTitle: "Review C",
                },
                {
                  branch: "feature-d",
                  relation: "later",
                  pullRequestNumber: 40,
                  pullRequestUrl: "https://github.com/o/r/pull/40",
                  reviewUuid: null,
                  reviewTitle: null,
                },
              ],
            });
          },
          post,
        },
      ),
    );
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <ReviewSessionProvider session={stackSession}>
          <ReviewInitialDataContext.Provider value={stackInitialData}>
            <ReviewDocumentMetaLine />
          </ReviewInitialDataContext.Provider>
        </ReviewSessionProvider>,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(container.textContent).toContain("1 of 3");
    expect(container.textContent).toContain("current");
    expect(
      [...container.querySelectorAll(".review-stack-position-marker")].map(
        (marker) => marker.textContent,
      ),
    ).toEqual(["1", "2", "3"]);
    const unavailable = container.querySelector<HTMLButtonElement>(
      ".review-stack-menu button:disabled",
    );
    expect(unavailable?.textContent).toContain("PR #40");
    expect(unavailable?.textContent).toContain("No Review");
    const layer = container.querySelector<HTMLButtonElement>(
      '.review-stack-menu button[data-relation="later"]',
    );
    expect(layer?.textContent).toContain("PR #30");
    await act(async () => {
      layer?.dispatchEvent(
        new MouseEvent("click", { bubbles: true, metaKey: true }),
      );
    });
    expect(post).toHaveBeenCalledWith({
      name: "openReview",
      args: {
        reviewUuid: "11111111-1111-4111-8111-111111111111",
        active: false,
      },
    });
    await act(async () => {
      unavailable?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(post).toHaveBeenCalledTimes(1);
  });
});
