import { describe, expect, it } from "vitest";

import type { AnchorRef } from "../../src/authoring";
import type { GuidedTour, ReviewPeekContent } from "./review-components";
import {
  createReviewPanelStore,
  selectActiveReviewPanel,
} from "./review-panel-store";

const anchor = {
  id: "startup",
  title: "Startup",
} as AnchorRef;
const content: ReviewPeekContent = {
  kind: "inline-code",
  text: "start();",
};
const tour: GuidedTour = {
  id: "flow",
  stops: [{ anchor, label: "Startup", content }],
};

describe("Review panel store", () => {
  it("replaces peek and tour details without disturbing a thread layer", () => {
    const store = createReviewPanelStore();

    store.getState().openPeek(anchor, content);
    expect(store.getState().detail).toEqual({
      kind: "peek",
      anchor,
      content,
    });

    store.getState().openThreads();
    store.getState().openTour(tour, anchor.id);

    expect(store.getState().thread).toEqual({ kind: "threads" });
    expect(store.getState().detail).toMatchObject({
      kind: "tour",
      tour,
      activeAnchor: anchor.id,
    });
  });

  it("closes a thread layer back to its underlying detail", () => {
    const store = createReviewPanelStore();

    store.getState().openTour(tour, anchor.id);
    store.getState().openThreads();
    store.getState().openCommentThread("thread-1");

    expect(selectActiveReviewPanel(store.getState())).toEqual({
      kind: "commentThread",
      threadId: "thread-1",
    });

    store.getState().closeActive();

    expect(store.getState().thread).toBeNull();
    expect(selectActiveReviewPanel(store.getState())).toMatchObject({
      kind: "tour",
      tour,
      activeAnchor: anchor.id,
    });
  });

  it("returns comment thread details to the Threads list", () => {
    const store = createReviewPanelStore();

    store.getState().openCommentThread("comment-1");
    store.getState().showThreads();
    expect(store.getState().thread).toEqual({ kind: "threads" });
  });

  it("opens a clean document-level Ask chat", () => {
    const store = createReviewPanelStore();

    store.getState().openThreads();
    store.getState().openNewAsk();

    expect(store.getState().thread).toEqual({ kind: "new-ask" });
    store.getState().showThreads();
    expect(store.getState().thread).toEqual({ kind: "threads" });
  });

  it("distinguishes explicit tour reveals from focus-only activation", () => {
    const store = createReviewPanelStore();
    store.getState().openTour(tour, anchor.id);
    const initial = store.getState().detail;
    expect(initial?.kind).toBe("tour");
    const initialReveal = initial?.kind === "tour" ? initial.revealRequest : -1;

    store
      .getState()
      .activateTourAnchor("focused-without-reveal", { reveal: false });
    expect(store.getState().detail).toMatchObject({
      activeAnchor: "focused-without-reveal",
      revealRequest: initialReveal,
    });

    store.getState().activateTourAnchor("explicit-next", { reveal: true });
    expect(store.getState().detail).toMatchObject({
      activeAnchor: "explicit-next",
      revealRequest: initialReveal + 1,
    });
  });

  it("clears detail independently and resets both layers", () => {
    const store = createReviewPanelStore();

    store.getState().openPeek(anchor, content);
    store.getState().openThreads();
    store.getState().closeDetail();
    expect(store.getState().detail).toBeNull();
    expect(store.getState().thread).toEqual({ kind: "threads" });

    store.getState().openTour(tour, anchor.id);
    store.getState().reset();
    expect(store.getState().detail).toBeNull();
    expect(store.getState().thread).toBeNull();
  });

  it("suppresses restored panel motion until the next live interaction", () => {
    const store = createReviewPanelStore();

    store.getState().restoreThreads();
    expect(store.getState().motion).toBe("restored");

    store.getState().closeActive();
    expect(store.getState().motion).toBe("live");

    store.getState().restoreTour(tour, anchor.id);
    expect(store.getState().motion).toBe("restored");

    store.getState().activateTourAnchor("explicit-next", { reveal: true });
    expect(store.getState().motion).toBe("live");
  });

  it("suppresses a live panel when its cached canvas resumes", () => {
    const store = createReviewPanelStore();

    store.getState().openThreads();
    expect(store.getState().motion).toBe("live");

    store.getState().suppressMotion();
    expect(store.getState().motion).toBe("restored");

    store.getState().closeActive();
    expect(store.getState().motion).toBe("live");
  });
});
