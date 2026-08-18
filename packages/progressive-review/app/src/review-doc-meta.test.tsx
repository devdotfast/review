// @vitest-environment jsdom

import { act } from "react";
import { type Root, hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ReviewSessionProvider } from "./host/review-session";
import { ReviewDocumentMetaLine } from "./review-doc-meta";
import {
  type ReviewInitialData,
  ReviewInitialDataContext,
} from "./review-initial-data-context";
import { testReviewSession } from "./review-session-test-utils";

const initialData: ReviewInitialData = {
  comments: {},
  sessionResolvedBaseRef: null,
  documentMeta: { updatedAtMs: Date.UTC(2026, 6, 22, 12, 0) },
  diffStats: { files: [{ additions: 2, deletions: 1 }] },
  softwareMapResolvedData: [],
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
});
