// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

import { ReviewSessionProvider } from "./host/review-session";
import { ReviewProvider, useReview } from "./review-context";
import { ReviewRootsProvider } from "./review-root-context";
import { testReviewSession } from "./review-session-test-utils";
import { stableHash } from "./target-fingerprint";
import { ThreadAnnotations } from "./thread-annotations";

it("saves and focuses a comment without scrolling before its location is measured", async () => {
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++frameId, callback);

    return frameId;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );

  const scroll =
    vi.fn<
      (element: Element, options?: boolean | ScrollIntoViewOptions) => void
    >();

  const previousScroll = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = function (options) {
    scroll(this, options);
  };

  const article = document.createElement("article");
  article.className = "review-document";
  article.innerHTML = "<p>Selected text</p>";
  const app = document.createElement("div");
  app.append(article);
  document.body.append(app);
  const mount = document.createElement("div");
  article.append(mount);
  const root = createRoot(mount);
  const articleRef = { current: article };

  const session = testReviewSession(
    {},
    { request: async () => Response.json({}) },
  );

  let review: ReturnType<typeof useReview> | undefined;

  function ReadState() {
    review = useReview();

    return null;
  }

  try {
    await act(async () =>
      root.render(
        <ReviewSessionProvider session={session}>
          <ReviewRootsProvider
            roots={{
              appRef: { current: app },
              shellRef: articleRef,
              scrollRegionRef: articleRef,
              articleRef,
            }}
          >
            <ReviewProvider>
              <ReadState />
              <ThreadAnnotations articleRef={articleRef} />
            </ReviewProvider>
          </ReviewRootsProvider>
        </ReviewSessionProvider>,
      ),
    );
    await act(async () =>
      review!.openCommentDraft({
        body: "",
        intent: "comment",
        draftSurface: "document",
        target: {
          kind: "text",
          surface: {
            type: "document",
            documentHash: stableHash("Selected text"),
          },
          selection: {
            start: 0,
            length: 13,
            quote: "Selected text",
            hash: stableHash("Selected text"),
          },
        },
      }),
    );

    const textarea = document.querySelector<HTMLTextAreaElement>(
      ".thread-popover textarea",
    )!;

    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )!.set!.call(textarea, "Saved feedback");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    scroll.mockClear();
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>(
          ".thread-popover .thread-compose-verb-primary",
        )!
        .click(),
    );
    expect(
      [...session.bridge.comments.getSnapshot().localComments.values()][0]
        ?.inputs[0]?.body,
    ).toBe("Saved feedback");
    expect(review!.draftTarget).toBeNull();
    expect(review!.focusedThreadId).toBeTruthy();
    // The save completes before the browser has measured the new comment.
    expect(frames.size).toBeGreaterThan(0);
    expect(scroll).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    app.remove();
    Element.prototype.scrollIntoView = previousScroll;
    vi.unstubAllGlobals();
  }
});
