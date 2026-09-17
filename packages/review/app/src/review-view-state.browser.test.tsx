import { type RefObject, act, createElement, useRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AnchorRef } from "../../src/authoring";
import { ReviewSessionProvider } from "./host/review-session";
import type { GuidedTour } from "./review-panel-model";
import { createReviewPanelStore } from "./review-panel-store";
import { testReviewSession } from "./review-session-test-utils";
import { writeReviewUiState } from "./review-ui-state";
import {
  ReviewViewStateProvider,
  clearPersistedReviewViewState,
  createReviewTourRestoreClaim,
  readPersistedReviewViewState,
  reviewViewStateKey,
  useReviewViewStateSync,
  useTourPersist,
  useTourRestore,
} from "./review-view-state";

type TestReviewSession = ReturnType<typeof testReviewSession>;

let root: ReturnType<typeof createRoot> | undefined;

let nextFrame = 1;

let frames = new Map<number, FrameRequestCallback>();

let resizeObservers = new Set<{ trigger(): void; disconnect(): void }>();

beforeEach(() => {
  vi.useFakeTimers();
  window.localStorage.clear();
  nextFrame = 1;
  frames = new Map();
  resizeObservers = new Set();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const frame = nextFrame;
    nextFrame += 1;
    frames.set(frame, callback);

    return frame;
  });
  vi.stubGlobal("cancelAnimationFrame", (frame: number) => {
    frames.delete(frame);
  });

  class TestResizeObserver implements ResizeObserver {
    constructor(private readonly callback: ResizeObserverCallback) {
      resizeObservers.add(this);
    }
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {
      resizeObservers.delete(this);
    }
    trigger(): void {
      this.callback([], this);
    }
  }

  vi.stubGlobal("ResizeObserver", TestResizeObserver);
});

afterEach(() => {
  if (root) {
    act(() => root?.unmount());
  }

  root = undefined;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("review view state", () => {
  it("does not restart scroll restoration when live session data changes", () => {
    const session = testReviewSession();
    storeState(session, { scrollTop: 100 });
    const harness = renderViewState({ session });

    act(() => {
      harness.element.scrollTop = 300;
      harness.element.dispatchEvent(new Event("scroll"));
    });
    flushNextFrame();
    expect(readPersistedReviewViewState(session.config).scrollTop).toBe(300);

    // The next scroll frame has not persisted yet when a live edit arrives.
    act(() => {
      harness.element.scrollTop = 350;
      harness.element.dispatchEvent(new Event("scroll"));
    });
    harness.renderSession({ ...session });
    expect(harness.element.scrollTop).toBe(350);
    flushNextFrame();
    expect(readPersistedReviewViewState(session.config).scrollTop).toBe(350);
  });

  it("clears transient state when a review input is recreated", () => {
    const session = testReviewSession();
    storeState(session, {
      scrollTop: 320,
      panel: { kind: "tour", tourId: "flow", activeAnchor: "second" },
    });

    clearPersistedReviewViewState(session.config);

    expect(readPersistedReviewViewState(session.config)).toEqual({});
  });

  it("keeps the tour from legacy layered panel state", () => {
    const session = testReviewSession();
    storeState(session, {
      panel: {
        thread: { kind: "threads" },
        tour: { tourId: "flow", activeAnchor: "second" },
      },
    });

    expect(readPersistedReviewViewState(session.config).panel).toEqual({
      kind: "tour",
      tourId: "flow",
      activeAnchor: "second",
    });
  });

  it("flushes the final scroll position when cleanup cancels a pending frame", () => {
    const session = testReviewSession();
    const harness = renderViewState({ session });

    act(() => {
      harness.element.scrollTop = 180;
      harness.element.dispatchEvent(new Event("scroll"));
    });
    expect(frames.size).toBe(1);

    unmount();

    expect(readPersistedReviewViewState(session.config)).toEqual({
      scrollTop: 180,
    });
    expect(frames.size).toBe(0);
  });

  it("retries restoration while content grows, then restores the target", () => {
    const session = testReviewSession();
    const metrics = { scrollHeight: 200, clientHeight: 200 };
    storeState(session, { scrollTop: 320 });
    const harness = renderViewState({ session, metrics });

    expect(harness.element.scrollTop).toBe(0);
    expect(frames.size).toBe(0);
    expect(resizeObservers.size).toBe(1);

    metrics.scrollHeight = 700;
    triggerResize();

    expect(harness.element.scrollTop).toBe(320);
    expect(frames.size).toBe(0);
  });

  it("keeps restoring after the old animation-frame retry window", () => {
    const session = testReviewSession();
    const metrics = { scrollHeight: 200, clientHeight: 200 };
    storeState(session, { scrollTop: 320 });
    const harness = renderViewState({ session, metrics });

    expect(frames.size).toBe(0);
    expect(resizeObservers.size).toBe(1);
    metrics.scrollHeight = 700;
    triggerResize();

    expect(harness.element.scrollTop).toBe(320);
    expect(resizeObservers.size).toBe(0);
  });

  it("does not persist an intermediate programmatic scroll during restoration", () => {
    const session = testReviewSession();
    const metrics = { scrollHeight: 200, clientHeight: 200 };
    storeState(session, { scrollTop: 320 });
    const harness = renderViewState({ session, metrics });

    act(() => {
      harness.element.scrollTop = 0;
      harness.element.dispatchEvent(new Event("scroll"));
    });
    flushNextFrame();

    expect(readPersistedReviewViewState(session.config).scrollTop).toBe(320);
  });

  it.each(["wheel", "pointerdown", "touchstart"])(
    "permanently aborts pending restoration on %s input",
    (eventType) => {
      const session = testReviewSession();
      const metrics = { scrollHeight: 200, clientHeight: 200 };
      storeState(session, { scrollTop: 320 });
      const harness = renderViewState({ session, metrics });

      act(() => harness.element.dispatchEvent(new Event(eventType)));
      metrics.scrollHeight = 700;
      triggerResize();

      expect(harness.element.scrollTop).toBe(0);
    },
  );

  it("cancels pending restoration on navigation keys", () => {
    const session = testReviewSession();
    const metrics = { scrollHeight: 200, clientHeight: 200 };
    storeState(session, { scrollTop: 320 });
    const harness = renderViewState({ session, metrics });

    act(() =>
      harness.element.dispatchEvent(
        new KeyboardEvent("keydown", { key: "PageDown" }),
      ),
    );
    metrics.scrollHeight = 700;
    triggerResize();

    expect(harness.element.scrollTop).toBe(0);
  });

  it("ignores layout scroll events while restoration is pending", () => {
    const session = testReviewSession();
    const metrics = { scrollHeight: 200, clientHeight: 200 };
    storeState(session, { scrollTop: 320 });
    const harness = renderViewState({ session, metrics });

    act(() => harness.element.dispatchEvent(new Event("scroll")));
    metrics.scrollHeight = 700;
    triggerResize();

    expect(harness.element.scrollTop).toBe(320);
  });

  it("does not write fallback state on a fresh mount", () => {
    const session = testReviewSession();
    renderViewState({ session });

    unmount();

    expect(
      window.localStorage.getItem(reviewViewStateKey(session.config)),
    ).toBe(null);
  });

  it("persists only resumable panel modes", () => {
    const session = testReviewSession();
    const store = createReviewPanelStore();
    renderViewState({ session, store });

    act(() =>
      store.getState().openPeek({
        kind: "peek",
        content: { kind: "inline-code", text: "start();" },
      }),
    );
    expect(readPersistedReviewViewState(session.config).panel).toBeUndefined();

    act(() => store.getState().openTour(tour, "second"));
    expect(readPersistedReviewViewState(session.config).panel).toEqual({
      kind: "tour",
      tourId: "flow",
      activeAnchor: "second",
    });
  });

  it("ignores a persisted Threads panel from an older build", () => {
    const legacySession = testReviewSession({ sessionId: "legacy-threads" });
    const legacyStore = createReviewPanelStore();
    storeState(legacySession, {
      panel: { kind: "threads" },
    });
    renderViewState({ session: legacySession, store: legacyStore });

    expect(legacyStore.getState().active).toBeNull();
    expect(readPersistedReviewViewState(legacySession.config).panel).toBe(
      undefined,
    );
  });

  it("keeps a stored tour until the diagram that owns it mounts", () => {
    const session = testReviewSession();
    const otherTour: GuidedTour = { ...tour, id: "other" };
    storeState(session, {
      overlayTour: { tourId: "flow", activeAnchor: "second" },
    });

    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    const render = (owners: readonly GuidedTour[]) =>
      act(() => {
        root?.render(
          <ReviewSessionProvider session={session}>
            <TourHarness owners={owners} />
          </ReviewSessionProvider>,
        );
      });

    // A diagram that does not own the stored tour mounts first (and closed).
    render([otherTour]);
    expect(container.querySelector("[data-tour=other]")?.textContent).toBe("");
    expect(readPersistedReviewViewState(session.config).overlayTour).toEqual({
      tourId: "flow",
      activeAnchor: "second",
    });

    // The owner mounts later, claims the restore, and keeps persisting it.
    render([otherTour, tour]);
    expect(container.querySelector("[data-tour=flow]")?.textContent).toBe(
      "second",
    );
    expect(readPersistedReviewViewState(session.config).overlayTour).toEqual({
      tourId: "flow",
      activeAnchor: "second",
    });
  });

  it("lets the matching tour owner claim a restore exactly once", () => {
    const claim = createReviewTourRestoreClaim({
      tourId: "flow",
      activeAnchor: "second",
    });

    expect(claim.claim({ ...tour, id: "other" })).toBeNull();
    expect(claim.claim(tour)).toEqual({
      tour,
      activeAnchor: "second",
    });
    expect(claim.claim(tour)).toBeNull();
  });

  it("restores every view the switcher offers, and nothing else", () => {
    const session = testReviewSession();

    for (const view of ["review", "map", "diff"] as const) {
      storeState(session, { activeView: view });
      expect(readPersistedReviewViewState(session.config).activeView).toBe(
        view,
      );
    }

    storeState(session, { activeView: "files" });
    expect(
      readPersistedReviewViewState(session.config).activeView,
    ).toBeUndefined();
  });

  it("keys state by both session and document route", () => {
    const first = testReviewSession({
      sessionId: "session-a",
      routePath: "/first.mdx",
    });

    const second = testReviewSession({
      sessionId: "session-b",
      routePath: "/second.mdx",
    });

    expect(reviewViewStateKey(first.config)).not.toBe(
      reviewViewStateKey(second.config),
    );
    expect(reviewViewStateKey(first.config)).toContain("session-a:/first.mdx");
    expect(reviewViewStateKey(second.config)).toContain(
      "session-b:/second.mdx",
    );
  });
});

const tour: GuidedTour = {
  id: "flow",
  stops: [
    {
      anchor: { id: "first", title: "First" } as AnchorRef,
      label: "First",
      content: { kind: "inline-code", text: "first();" },
    },
    {
      anchor: { id: "second", title: "Second" } as AnchorRef,
      label: "Second",
      content: { kind: "inline-code", text: "second();" },
    },
  ],
};

function renderViewState({
  session,
  store = createReviewPanelStore(),
  metrics = { scrollHeight: 1_000, clientHeight: 200 },
}: {
  session: TestReviewSession;
  store?: ReturnType<typeof createReviewPanelStore>;
  metrics?: { scrollHeight: number; clientHeight: number };
}) {
  const container = document.createElement("div");
  document.body.append(container);
  let element: HTMLDivElement | null = null;
  root = createRoot(container);

  const renderSession = (next: TestReviewSession) =>
    act(() => {
      root?.render(
        <ReviewSessionProvider session={next}>
          <ViewStateHarness
            store={store}
            metrics={metrics}
            captureElement={(value: HTMLDivElement) => {
              element = value;
            }}
          />
        </ReviewSessionProvider>,
      );
    });

  renderSession(session);

  return { element: element!, store, renderSession };
}

function TourOwner({ tour }: { tour: GuidedTour }) {
  const restored = useTourRestore(tour);
  useTourPersist(restored?.tour ?? null, restored?.activeAnchor ?? null);

  return <span data-tour={tour.id}>{restored?.activeAnchor ?? ""}</span>;
}

function TourHarness({ owners }: { owners: readonly GuidedTour[] }) {
  const scrollRegionRef = useRef<HTMLDivElement | null>(null);

  const sync = useReviewViewStateSync({
    scrollRegionRef: scrollRegionRef as RefObject<HTMLElement | null>,
    panelStore: createReviewPanelStore(),
  });

  return (
    <ReviewViewStateProvider
      tourRestore={sync.tourRestore}
      persistOverlayTour={sync.persistOverlayTour}
    >
      <div ref={scrollRegionRef}>
        {owners.map((owner) => (
          <TourOwner key={owner.id} tour={owner} />
        ))}
      </div>
    </ReviewViewStateProvider>
  );
}

function ViewStateHarness({
  store,
  metrics,
  captureElement,
}: {
  store: ReturnType<typeof createReviewPanelStore>;
  metrics: { scrollHeight: number; clientHeight: number };
  captureElement(element: HTMLDivElement): void;
}) {
  const scrollRegionRef = useRef<HTMLDivElement | null>(null);
  const scrollTop = useRef(0);
  useReviewViewStateSync({
    scrollRegionRef: scrollRegionRef as RefObject<HTMLElement | null>,
    panelStore: store,
  });

  return createElement("div", {
    ref: (element: HTMLDivElement | null) => {
      scrollRegionRef.current = element;

      if (!element) return;
      Object.defineProperties(element, {
        scrollTop: {
          configurable: true,
          get: () => scrollTop.current,
          set: (value: number) => {
            scrollTop.current = value;
          },
        },
        scrollHeight: {
          configurable: true,
          get: () => metrics.scrollHeight,
        },
        clientHeight: {
          configurable: true,
          get: () => metrics.clientHeight,
        },
      });
      captureElement(element);
    },
    tabIndex: -1,
  });
}

function storeState(
  session: TestReviewSession,
  state: Parameters<typeof writeReviewUiState>[2],
) {
  writeReviewUiState("session", reviewViewStateKey(session.config), state);
}

function flushNextFrame(): void {
  const next = frames.entries().next().value as
    | [number, FrameRequestCallback]
    | undefined;

  if (!next) throw new Error("No animation frame is pending");
  const [frame, callback] = next;
  frames.delete(frame);
  act(() => callback(16));
}

function triggerResize(): void {
  act(() => {
    for (const observer of [...resizeObservers]) observer.trigger();
  });
}

function unmount(): void {
  act(() => root?.unmount());
  root = undefined;
}
