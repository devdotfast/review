import { describe, expect, it } from "vitest";

import type { AnchorRef } from "../../src/authoring";
import type { GuidedTour, ReviewPeekContent } from "./review-panel-model";
import { createReviewPanelStore } from "./review-panel-store";

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
  it("replaces the active panel instead of layering panels", () => {
    const store = createReviewPanelStore();

    store.getState().openPeek({ kind: "peek", anchor, content });
    expect(store.getState().active).toEqual({
      kind: "peek",
      anchor,
      content,
    });

    store.getState().openTour(tour, anchor.id);
    expect(store.getState().active).toMatchObject({
      kind: "tour",
      tour,
      activeAnchor: anchor.id,
    });
  });

  it("closes the active panel without revealing an earlier panel", () => {
    const store = createReviewPanelStore();

    store.getState().openTour(tour, anchor.id);
    store.getState().openPeek({ kind: "peek", anchor, content });
    expect(store.getState().active?.kind).toBe("peek");

    store.getState().close();
    expect(store.getState().active).toBeNull();
  });

  it("distinguishes explicit tour reveals from focus-only activation", () => {
    const store = createReviewPanelStore();
    store.getState().openTour(tour, anchor.id);
    const initial = store.getState().active;
    expect(initial?.kind).toBe("tour");
    const initialReveal = initial?.kind === "tour" ? initial.revealRequest : -1;

    store
      .getState()
      .activateTourAnchor("focused-without-reveal", { reveal: false });
    expect(store.getState().active).toMatchObject({
      activeAnchor: "focused-without-reveal",
      revealRequest: initialReveal,
    });

    store.getState().activateTourAnchor("explicit-next", { reveal: true });
    expect(store.getState().active).toMatchObject({
      activeAnchor: "explicit-next",
      revealRequest: initialReveal + 1,
    });
  });

  it("suppresses restored panel motion until the next live interaction", () => {
    const store = createReviewPanelStore();

    store.getState().restoreTour(tour, anchor.id);
    expect(store.getState().motion).toBe("restored");

    store.getState().activateTourAnchor("explicit-next", { reveal: true });
    expect(store.getState().motion).toBe("live");
  });

  it("suppresses a live panel when its cached canvas resumes", () => {
    const store = createReviewPanelStore();

    store.getState().openPeek({ kind: "peek", anchor, content });
    expect(store.getState().motion).toBe("live");

    store.getState().suppressMotion();
    expect(store.getState().motion).toBe("restored");

    store.getState().close();
    expect(store.getState().motion).toBe("live");
  });
});
