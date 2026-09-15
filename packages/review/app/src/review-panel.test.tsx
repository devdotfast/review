// @vitest-environment jsdom

import { REVIEW_CANVAS_RESUME_EVENT } from "@dev.fast/review-protocol";
import { type ReactNode, act, useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AnchorRef } from "../../src/authoring";
import { ReviewDebugSettingsProvider } from "./debug-settings";
import { ReviewSessionProvider } from "./host/review-session";
import { ReviewPanelHost } from "./review-components";
import { ReviewProvider } from "./review-context";
import {
  ReviewPanelProvider,
  useReviewPanel,
  useSuppressPanelMotionOnCanvasResume,
} from "./review-panel";
import type { GuidedTour } from "./review-panel-model";
import { testReviewSession } from "./review-session-test-utils";

let root: ReturnType<typeof createRoot> | undefined;

const session = testReviewSession();

function renderWithSession(node: ReactNode) {
  root!.render(
    <ReviewSessionProvider session={session}>{node}</ReviewSessionProvider>,
  );
}

beforeEach(() => {
  (
    globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({}))),
  );
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    value: vi.fn<(options?: ScrollToOptions | number, y?: number) => void>(),
  });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);

    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn<(handle: number) => void>());
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Review panel host", () => {
  it("replaces the active panel when a document peek opens", async () => {
    const addEventListener = vi.spyOn(document, "addEventListener");
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      renderWithSession(
        <ReviewDebugSettingsProvider>
          <ReviewProvider>
            <ReviewPanelProvider>
              <OpenReplacingPanel />
              <ReviewPanelHost />
            </ReviewPanelProvider>
          </ReviewProvider>
        </ReviewDebugSettingsProvider>,
      );
      await Promise.resolve();
    });

    expect(container.querySelectorAll(".side-panel")).toHaveLength(1);
    expect(container.querySelectorAll(".review-panel-body")).toHaveLength(1);
    expect(
      container.querySelectorAll(".side-panel-sheet-resizer"),
    ).toHaveLength(1);
    expect(container.textContent).not.toContain("Guided tour");
    expect(container.textContent).toContain("Startup detail");
    expect(
      addEventListener.mock.calls.filter(([type]) => type === "keydown"),
    ).toHaveLength(1);

    await act(async () => {
      container.querySelector<HTMLButtonElement>(".side-panel-close")!.click();
    });

    expect(container.querySelectorAll(".side-panel")).toHaveLength(0);
    expect(container.querySelectorAll(".review-panel-body")).toHaveLength(0);
  });

  it("marks a restored panel so its entrance motion can be suppressed", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      renderWithSession(
        <ReviewDebugSettingsProvider>
          <ReviewProvider>
            <ReviewPanelProvider>
              <RestoreTourPanel />
              <ReviewPanelHost />
            </ReviewPanelProvider>
          </ReviewProvider>
        </ReviewDebugSettingsProvider>,
      );
      await Promise.resolve();
    });

    expect(container.querySelector(".side-panel--restored")).not.toBeNull();
  });

  it("suppresses panel motion when the cached canvas resumes", async () => {
    const canvas = document.createElement("div");
    canvas.className = "review-canvas-root";
    const container = document.createElement("div");
    canvas.append(container);
    document.body.append(canvas);
    root = createRoot(container);

    await act(async () => {
      renderWithSession(
        <ReviewDebugSettingsProvider>
          <ReviewProvider>
            <ReviewPanelProvider>
              <OpenTourPanel />
              <ResumeMotionListener />
              <ReviewPanelHost />
            </ReviewPanelProvider>
          </ReviewProvider>
        </ReviewDebugSettingsProvider>,
      );
      await Promise.resolve();
    });

    expect(container.querySelector(".side-panel--restored")).toBeNull();

    await act(async () => {
      canvas.dispatchEvent(new Event(REVIEW_CANVAS_RESUME_EVENT));
    });

    expect(container.querySelector(".side-panel--restored")).not.toBeNull();
  });

  it("activates the tour stop that crosses the panel reading line", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      renderWithSession(
        <ReviewDebugSettingsProvider>
          <ReviewProvider>
            <ReviewPanelProvider>
              <OpenTourPanel />
              <ActiveTourAnchor />
              <ReviewPanelHost />
            </ReviewPanelProvider>
          </ReviewProvider>
        </ReviewDebugSettingsProvider>,
      );
      await Promise.resolve();
    });

    const scrollTo = vi.mocked(HTMLElement.prototype.scrollTo);
    scrollTo.mockClear();
    const body = container.querySelector<HTMLElement>(".review-panel-body")!;

    const [firstStop, secondStop] = [
      ...container.querySelectorAll<HTMLElement>(".tour-stop"),
    ];

    vi.spyOn(body, "getBoundingClientRect").mockReturnValue(
      domRect({ top: 100, bottom: 600, height: 500 }),
    );
    vi.spyOn(firstStop!, "getBoundingClientRect").mockReturnValue(
      domRect({ top: -160, bottom: 80, height: 240 }),
    );
    vi.spyOn(secondStop!, "getBoundingClientRect").mockReturnValue(
      domRect({ top: 112, bottom: 352, height: 240 }),
    );

    await act(async () => {
      body.dispatchEvent(new Event("scroll", { bubbles: true }));
    });

    expect(
      container.querySelector("[data-active-tour-anchor]")?.textContent,
    ).toBe("second");
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("keeps tour navigation outside the scroller and reveals selected stops", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      renderWithSession(
        <ReviewDebugSettingsProvider>
          <ReviewProvider>
            <ReviewPanelProvider>
              <OpenTourPanel />
              <ActiveTourAnchor />
              <ReviewPanelHost />
            </ReviewPanelProvider>
          </ReviewProvider>
        </ReviewDebugSettingsProvider>,
      );
      await Promise.resolve();
    });

    const body = container.querySelector<HTMLElement>(".review-panel-body")!;

    const floatingFooter = container.querySelector<HTMLElement>(
      ".tour-floating-footer",
    )!;

    expect(body.contains(floatingFooter)).toBe(false);
    expect(floatingFooter.textContent).toContain("1 more steps");

    await act(async () => {
      floatingFooter
        .querySelector<HTMLButtonElement>(".tour-pill--intro")!
        .click();
    });

    expect(
      container.querySelector("[data-active-tour-anchor]")?.textContent,
    ).toBe("second");
    expect(floatingFooter.querySelector(".tour-pill-count")?.textContent).toBe(
      "2/2",
    );
    expect(
      floatingFooter.querySelector<HTMLButtonElement>(
        '[aria-label="Next step"]',
      )?.disabled,
    ).toBe(true);

    await act(async () => {
      floatingFooter
        .querySelector<HTMLButtonElement>('[aria-label="Previous step"]')!
        .click();
    });

    expect(
      container.querySelector("[data-active-tour-anchor]")?.textContent,
    ).toBe("first");
    expect(floatingFooter.querySelector(".tour-pill-count")?.textContent).toBe(
      "1/2",
    );
    expect(
      floatingFooter.querySelector<HTMLButtonElement>(
        '[aria-label="Previous step"]',
      )?.disabled,
    ).toBe(true);
    expect(HTMLElement.prototype.scrollTo).toHaveBeenCalled();
  });
});

function OpenReplacingPanel() {
  const openPeek = useReviewPanel((state) => state.openPeek);
  const openTour = useReviewPanel((state) => state.openTour);
  useEffect(() => {
    openTour(tourFixture(), "first");
    openPeek({
      kind: "peek",
      anchor: { id: "startup", title: "Startup detail" } as AnchorRef,
      content: { kind: "inline-code", text: "start();" },
    });
  }, [openPeek, openTour]);

  return null;
}

function OpenTourPanel() {
  const openTour = useReviewPanel((state) => state.openTour);
  useEffect(() => openTour(tourFixture(), "first"), [openTour]);

  return null;
}

function RestoreTourPanel() {
  const restoreTour = useReviewPanel((state) => state.restoreTour);
  useEffect(() => restoreTour(tourFixture(), "first"), [restoreTour]);

  return null;
}

function tourFixture(): GuidedTour {
  const first = { id: "first", title: "First" } as AnchorRef;
  const second = { id: "second", title: "Second" } as AnchorRef;

  return {
    id: "tour",
    stops: [
      {
        anchor: first,
        label: "First",
        content: { kind: "inline-code", text: "first();" },
      },
      {
        anchor: second,
        label: "Second",
        content: { kind: "inline-code", text: "second();" },
      },
    ],
  };
}

function ResumeMotionListener() {
  const appRef = useRef<HTMLDivElement | null>(null);
  useSuppressPanelMotionOnCanvasResume(appRef);

  return <div ref={appRef} />;
}

function ActiveTourAnchor() {
  const activeAnchor = useReviewPanel((state) =>
    state.active?.kind === "tour" ? state.active.activeAnchor : "",
  );

  return <output data-active-tour-anchor>{activeAnchor}</output>;
}

function domRect(overrides: Partial<DOMRect> = {}): DOMRect {
  return {
    x: 0,
    y: 0,
    width: 320,
    height: 0,
    top: 0,
    right: 320,
    bottom: 0,
    left: 0,
    toJSON: () => ({}),
    ...overrides,
  };
}
