import { WHITEBOARD_CANVAS_RESUME_EVENT } from "@dev.fast/whiteboard-protocol";
import { type ReactNode, act, useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AnchorRef } from "../../src/authoring";
import { WhiteboardDebugSettingsProvider } from "./debug-settings";
import { WhiteboardSessionProvider } from "./host/whiteboard-session";
import { WhiteboardPanelHost } from "./whiteboard-components";
import { WhiteboardProvider } from "./whiteboard-context";
import {
  WhiteboardPanelProvider,
  useSuppressPanelMotionOnCanvasResume,
  useWhiteboardPanel,
} from "./whiteboard-panel";
import type { GuidedTour } from "./whiteboard-panel-model";
import { testWhiteboardSession } from "./whiteboard-session-test-utils";

let root: ReturnType<typeof createRoot> | undefined;

const session = testWhiteboardSession();

function renderWithSession(node: ReactNode) {
  root!.render(
    <WhiteboardSessionProvider session={session}>
      {node}
    </WhiteboardSessionProvider>,
  );
}

beforeEach(() => {
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
        <WhiteboardDebugSettingsProvider>
          <WhiteboardProvider>
            <WhiteboardPanelProvider>
              <OpenReplacingPanel />
              <WhiteboardPanelHost />
            </WhiteboardPanelProvider>
          </WhiteboardProvider>
        </WhiteboardDebugSettingsProvider>,
      );
      await Promise.resolve();
    });

    expect(container.querySelectorAll(".side-panel")).toHaveLength(1);
    expect(container.querySelectorAll(".whiteboard-panel-body")).toHaveLength(
      1,
    );
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
    expect(container.querySelectorAll(".whiteboard-panel-body")).toHaveLength(
      0,
    );
  });

  it("marks a restored panel so its entrance motion can be suppressed", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      renderWithSession(
        <WhiteboardDebugSettingsProvider>
          <WhiteboardProvider>
            <WhiteboardPanelProvider>
              <RestoreTourPanel />
              <WhiteboardPanelHost />
            </WhiteboardPanelProvider>
          </WhiteboardProvider>
        </WhiteboardDebugSettingsProvider>,
      );
      await Promise.resolve();
    });

    expect(container.querySelector(".side-panel--restored")).not.toBeNull();
  });

  it("suppresses panel motion when the cached canvas resumes", async () => {
    const canvas = document.createElement("div");
    canvas.className = "whiteboard-canvas-root";
    const container = document.createElement("div");
    canvas.append(container);
    document.body.append(canvas);
    root = createRoot(container);

    await act(async () => {
      renderWithSession(
        <WhiteboardDebugSettingsProvider>
          <WhiteboardProvider>
            <WhiteboardPanelProvider>
              <OpenTourPanel />
              <ResumeMotionListener />
              <WhiteboardPanelHost />
            </WhiteboardPanelProvider>
          </WhiteboardProvider>
        </WhiteboardDebugSettingsProvider>,
      );
      await Promise.resolve();
    });

    expect(container.querySelector(".side-panel--restored")).toBeNull();

    await act(async () => {
      canvas.dispatchEvent(new Event(WHITEBOARD_CANVAS_RESUME_EVENT));
    });

    expect(container.querySelector(".side-panel--restored")).not.toBeNull();
  });

  it("activates the tour stop that crosses the panel reading line", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      renderWithSession(
        <WhiteboardDebugSettingsProvider>
          <WhiteboardProvider>
            <WhiteboardPanelProvider>
              <OpenTourPanel />
              <ActiveTourAnchor />
              <WhiteboardPanelHost />
            </WhiteboardPanelProvider>
          </WhiteboardProvider>
        </WhiteboardDebugSettingsProvider>,
      );
      await Promise.resolve();
    });

    const scrollTo = vi.mocked(HTMLElement.prototype.scrollTo);
    scrollTo.mockClear();

    const body = container.querySelector<HTMLElement>(
      ".whiteboard-panel-body",
    )!;

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
        <WhiteboardDebugSettingsProvider>
          <WhiteboardProvider>
            <WhiteboardPanelProvider>
              <OpenTourPanel />
              <ActiveTourAnchor />
              <WhiteboardPanelHost />
            </WhiteboardPanelProvider>
          </WhiteboardProvider>
        </WhiteboardDebugSettingsProvider>,
      );
      await Promise.resolve();
    });

    const body = container.querySelector<HTMLElement>(
      ".whiteboard-panel-body",
    )!;

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
  const openPeek = useWhiteboardPanel((state) => state.openPeek);
  const openTour = useWhiteboardPanel((state) => state.openTour);
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
  const openTour = useWhiteboardPanel((state) => state.openTour);
  useEffect(() => openTour(tourFixture(), "first"), [openTour]);

  return null;
}

function RestoreTourPanel() {
  const restoreTour = useWhiteboardPanel((state) => state.restoreTour);
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
  const activeAnchor = useWhiteboardPanel((state) =>
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
