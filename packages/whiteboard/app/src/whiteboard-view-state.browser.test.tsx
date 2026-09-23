import {
  type ReactNode,
  type RefObject,
  act,
  createElement,
  useRef,
} from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AnchorRef } from "../../src/authoring";
import { WhiteboardSessionProvider } from "./host/whiteboard-session";
import type { GuidedTour } from "./whiteboard-panel-model";
import { createWhiteboardPanelStore } from "./whiteboard-panel-store";
import { testWhiteboardSession } from "./whiteboard-session-test-utils";
import { writeWhiteboardUiState } from "./whiteboard-ui-state";
import {
  WhiteboardViewStateProvider,
  clearPersistedWhiteboardViewState,
  createWhiteboardTourRestoreClaim,
  readPersistedWhiteboardViewState,
  useTourPersist,
  useTourRestore,
  useWhiteboardViewStateSync,
  whiteboardViewStateKey,
} from "./whiteboard-view-state";

type TestWhiteboardSession = ReturnType<typeof testWhiteboardSession>;

let root: ReturnType<typeof createRoot> | undefined;

let nextFrame = 1;

let frames = new Map<number, FrameRequestCallback>();

let resizeObservers = new Set<{ trigger(): void; disconnect(): void }>();

let observedElements = new Set<Element>();

beforeEach(() => {
  vi.useFakeTimers();
  window.localStorage.clear();
  nextFrame = 1;
  frames = new Map();
  resizeObservers = new Set();
  observedElements = new Set();
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
    observe(target: Element): void {
      observedElements.add(target);
    }
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
    const session = testWhiteboardSession();
    storeState(session, { scrollTop: 100 });
    const harness = renderViewState({ session });

    act(() => {
      harness.element.scrollTop = 300;
      harness.element.dispatchEvent(new Event("scroll"));
    });
    flushNextFrame();
    expect(readPersistedWhiteboardViewState(session.config).scrollTop).toBe(
      300,
    );

    // The next scroll frame has not persisted yet when a live edit arrives.
    act(() => {
      harness.element.scrollTop = 350;
      harness.element.dispatchEvent(new Event("scroll"));
    });
    harness.renderSession({ ...session });
    expect(harness.element.scrollTop).toBe(350);
    flushNextFrame();
    expect(readPersistedWhiteboardViewState(session.config).scrollTop).toBe(
      350,
    );
  });

  it("clears transient state when a review input is recreated", () => {
    const session = testWhiteboardSession();
    storeState(session, {
      scrollTop: 320,
      panel: { kind: "tour", tourId: "flow", activeAnchor: "second" },
    });

    clearPersistedWhiteboardViewState(session.config);

    expect(readPersistedWhiteboardViewState(session.config)).toEqual({});
  });

  it("flushes the final scroll position when cleanup cancels a pending frame", () => {
    const session = testWhiteboardSession();
    const harness = renderViewState({ session });

    act(() => {
      harness.element.scrollTop = 180;
      harness.element.dispatchEvent(new Event("scroll"));
    });
    expect(frames.size).toBe(1);

    unmount();

    expect(readPersistedWhiteboardViewState(session.config)).toEqual({
      scrollTop: 180,
    });
    expect(frames.size).toBe(0);
  });

  it("retries restoration while content grows, then restores the target", () => {
    const session = testWhiteboardSession();
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
    const session = testWhiteboardSession();
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

  it("watches the region's laid-out children for growth, not every descendant", () => {
    const session = testWhiteboardSession();
    storeState(session, { scrollTop: 320 });

    const harness = renderViewState({
      session,
      metrics: { scrollHeight: 200, clientHeight: 200 },
      children: [
        createElement(
          "div",
          { key: "view", style: { display: "contents" } },
          createElement("nav", null, "toc"),
          createElement(
            "article",
            null,
            createElement("section", null, createElement("p", null, "peek")),
          ),
        ),
        createElement("aside", { key: "aside" }, "panel"),
      ],
    });

    const region = harness.element;

    expect(observedElements).toEqual(
      new Set([
        region,
        region.querySelector("nav")!,
        region.querySelector("article")!,
        region.querySelector("aside")!,
      ]),
    );
  });

  it("does not persist an intermediate programmatic scroll during restoration", () => {
    const session = testWhiteboardSession();
    const metrics = { scrollHeight: 200, clientHeight: 200 };
    storeState(session, { scrollTop: 320 });
    const harness = renderViewState({ session, metrics });

    act(() => {
      harness.element.scrollTop = 0;
      harness.element.dispatchEvent(new Event("scroll"));
    });
    flushNextFrame();

    expect(readPersistedWhiteboardViewState(session.config).scrollTop).toBe(
      320,
    );
  });

  it.each(["wheel", "pointerdown", "touchstart"])(
    "permanently aborts pending restoration on %s input",
    (eventType) => {
      const session = testWhiteboardSession();
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
    const session = testWhiteboardSession();
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
    const session = testWhiteboardSession();
    const metrics = { scrollHeight: 200, clientHeight: 200 };
    storeState(session, { scrollTop: 320 });
    const harness = renderViewState({ session, metrics });

    act(() => harness.element.dispatchEvent(new Event("scroll")));
    metrics.scrollHeight = 700;
    triggerResize();

    expect(harness.element.scrollTop).toBe(320);
  });

  it("does not write fallback state on a fresh mount", () => {
    const session = testWhiteboardSession();
    renderViewState({ session });

    unmount();

    expect(
      window.localStorage.getItem(whiteboardViewStateKey(session.config)),
    ).toBe(null);
  });

  it("persists only resumable panel modes", () => {
    const session = testWhiteboardSession();
    const store = createWhiteboardPanelStore();
    renderViewState({ session, store });

    act(() =>
      store.getState().openPeek({
        kind: "peek",
        content: { kind: "inline-code", text: "start();" },
      }),
    );
    expect(
      readPersistedWhiteboardViewState(session.config).panel,
    ).toBeUndefined();

    act(() => store.getState().openTour(tour, "second"));
    expect(readPersistedWhiteboardViewState(session.config).panel).toEqual({
      kind: "tour",
      tourId: "flow",
      activeAnchor: "second",
    });
  });

  it("ignores a persisted Threads panel from an older build", () => {
    const legacySession = testWhiteboardSession({
      sessionId: "legacy-threads",
    });

    const legacyStore = createWhiteboardPanelStore();
    storeState(legacySession, {
      panel: { kind: "threads" },
    });
    renderViewState({ session: legacySession, store: legacyStore });

    expect(legacyStore.getState().active).toBeNull();
    expect(readPersistedWhiteboardViewState(legacySession.config).panel).toBe(
      undefined,
    );
  });

  it("keeps a stored tour until the diagram that owns it mounts", () => {
    const session = testWhiteboardSession();
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
          <WhiteboardSessionProvider session={session}>
            <TourHarness owners={owners} />
          </WhiteboardSessionProvider>,
        );
      });

    // A diagram that does not own the stored tour mounts first (and closed).
    render([otherTour]);
    expect(container.querySelector("[data-tour=other]")?.textContent).toBe("");
    expect(
      readPersistedWhiteboardViewState(session.config).overlayTour,
    ).toEqual({
      tourId: "flow",
      activeAnchor: "second",
    });

    // The owner mounts later, claims the restore, and keeps persisting it.
    render([otherTour, tour]);
    expect(container.querySelector("[data-tour=flow]")?.textContent).toBe(
      "second",
    );
    expect(
      readPersistedWhiteboardViewState(session.config).overlayTour,
    ).toEqual({
      tourId: "flow",
      activeAnchor: "second",
    });
  });

  it("lets the matching tour owner claim a restore exactly once", () => {
    const claim = createWhiteboardTourRestoreClaim({
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
    const session = testWhiteboardSession();

    for (const view of ["review", "map", "diff"] as const) {
      storeState(session, { activeView: view });
      expect(readPersistedWhiteboardViewState(session.config).activeView).toBe(
        view,
      );
    }

    storeState(session, { activeView: "files" });
    expect(
      readPersistedWhiteboardViewState(session.config).activeView,
    ).toBeUndefined();
  });

  it("keys state by review identity", () => {
    const first = testWhiteboardSession({ sessionId: "session-a" });

    const second = testWhiteboardSession({ sessionId: "session-b" });

    expect(whiteboardViewStateKey(first.config)).not.toBe(
      whiteboardViewStateKey(second.config),
    );
    expect(whiteboardViewStateKey(first.config)).toContain("session-a");
    expect(whiteboardViewStateKey(second.config)).toContain("session-b");
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
  store = createWhiteboardPanelStore(),
  metrics = { scrollHeight: 1_000, clientHeight: 200 },
  children,
}: {
  session: TestWhiteboardSession;
  store?: ReturnType<typeof createWhiteboardPanelStore>;
  metrics?: { scrollHeight: number; clientHeight: number };
  children?: ReactNode;
}) {
  const container = document.createElement("div");
  document.body.append(container);
  let element: HTMLDivElement | null = null;
  root = createRoot(container);

  const renderSession = (next: TestWhiteboardSession) =>
    act(() => {
      root?.render(
        <WhiteboardSessionProvider session={next}>
          <ViewStateHarness
            store={store}
            metrics={metrics}
            captureElement={(value: HTMLDivElement) => {
              element = value;
            }}
          >
            {children}
          </ViewStateHarness>
        </WhiteboardSessionProvider>,
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

  const sync = useWhiteboardViewStateSync({
    scrollRegionRef: scrollRegionRef as RefObject<HTMLElement | null>,
    panelStore: createWhiteboardPanelStore(),
  });

  return (
    <WhiteboardViewStateProvider
      tourRestore={sync.tourRestore}
      persistOverlayTour={sync.persistOverlayTour}
    >
      <div ref={scrollRegionRef}>
        {owners.map((owner) => (
          <TourOwner key={owner.id} tour={owner} />
        ))}
      </div>
    </WhiteboardViewStateProvider>
  );
}

function ViewStateHarness({
  store,
  metrics,
  captureElement,
  children,
}: {
  store: ReturnType<typeof createWhiteboardPanelStore>;
  metrics: { scrollHeight: number; clientHeight: number };
  captureElement(element: HTMLDivElement): void;
  children?: ReactNode;
}) {
  const scrollRegionRef = useRef<HTMLDivElement | null>(null);
  const scrollTop = useRef(0);
  useWhiteboardViewStateSync({
    scrollRegionRef: scrollRegionRef as RefObject<HTMLElement | null>,
    panelStore: store,
  });

  return createElement(
    "div",
    {
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
    },
    children,
  );
}

function storeState(
  session: TestWhiteboardSession,
  state: Parameters<typeof writeWhiteboardUiState>[2],
) {
  writeWhiteboardUiState(
    "session",
    whiteboardViewStateKey(session.config),
    state,
  );
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
