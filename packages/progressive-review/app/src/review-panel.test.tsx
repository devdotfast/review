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
  useReviewPanelStore,
  useSuppressPanelMotionOnCanvasResume,
} from "./review-panel";
import type { ReviewPanelStore } from "./review-panel-store";
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
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/comments")) {
        return new Response(JSON.stringify({ comments: {} }));
      }
      return new Response(JSON.stringify({}));
    }),
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
  it("hides the new ask action for a historical review", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/comments")) {
          return new Response(JSON.stringify({ comments: {} }));
        }
        if (url.includes("/__progressive-review/session")) {
          return new Response(
            JSON.stringify({
              session: { historicalRevision: "a".repeat(40) },
            }),
          );
        }
        return new Response(JSON.stringify({}));
      }),
    );
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      renderWithSession(
        <ReviewDebugSettingsProvider>
          <ReviewProvider>
            <ReviewPanelProvider>
              <OpenThreadsPanel />
              <ReviewPanelHost />
            </ReviewPanelProvider>
          </ReviewProvider>
        </ReviewDebugSettingsProvider>,
      );
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Threads");
    await vi.waitFor(() => {
      expect(container.querySelector(".threads-new-ask")).toBeNull();
    });
  });

  it("stays closed when the agent terminal takes over during Ask now", async () => {
    let panelStore: ReviewPanelStore | undefined;
    const askAgent = vi.spyOn(session.bridge.comments, "askAgent");
    askAgent.mockImplementation(async () => {
      // The desktop fires agentTerminalOpening before the ask resolves.
      panelStore!.getState().closeForAgentTerminal();
    });
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      renderWithSession(
        <ReviewDebugSettingsProvider>
          <ReviewProvider>
            <ReviewPanelProvider>
              <CaptureStore onStore={(store) => (panelStore = store)} />
              <OpenNewAskPanel />
              <ReviewPanelHost />
            </ReviewPanelProvider>
          </ReviewProvider>
        </ReviewDebugSettingsProvider>,
      );
      await Promise.resolve();
    });

    const textarea = container.querySelector<HTMLTextAreaElement>(
      ".thread-compose textarea",
    );
    expect(textarea).not.toBeNull();
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )!.set!;
      setValue.call(textarea, "hi");
      textarea!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      container
        .querySelector<HTMLFormElement>(".thread-compose")!
        .requestSubmit();
      await Promise.resolve();
    });

    expect(askAgent).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => {
      expect(panelStore!.getState().active).toBeNull();
      expect(container.querySelectorAll(".side-panel")).toHaveLength(0);
    });
  });

  it("replaces Threads when a document peek opens", async () => {
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
    expect(container.textContent).not.toContain("Threads");
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

  it("preserves Threads across a document reload", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      renderWithSession(
        <ReviewDebugSettingsProvider>
          <ReviewProvider>
            <ReviewPanelProvider detailRevision="document-1">
              <OpenThreadsPanel />
              <ReviewPanelHost />
            </ReviewPanelProvider>
          </ReviewProvider>
        </ReviewDebugSettingsProvider>,
      );
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Threads");

    await act(async () => {
      renderWithSession(
        <ReviewDebugSettingsProvider>
          <ReviewProvider>
            <ReviewPanelProvider detailRevision="document-2">
              <OpenThreadsPanel />
              <ReviewPanelHost />
            </ReviewPanelProvider>
          </ReviewProvider>
        </ReviewDebugSettingsProvider>,
      );
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Threads");

    await act(async () => {
      container.querySelector<HTMLButtonElement>(".side-panel-close")!.click();
    });

    expect(container.querySelectorAll(".side-panel")).toHaveLength(0);
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
              <RestoreThreadsPanel />
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
              <OpenThreadsPanel />
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
  const openThreads = useReviewPanel((state) => state.openThreads);
  useEffect(() => {
    openThreads();
    openPeek({
      kind: "peek",
      anchor: { id: "startup", title: "Startup detail" } as AnchorRef,
      content: { kind: "inline-code", text: "start();" },
    });
  }, [openPeek, openThreads]);
  return null;
}

function OpenThreadsPanel() {
  const openThreads = useReviewPanel((state) => state.openThreads);
  useEffect(() => openThreads(), [openThreads]);
  return null;
}

function OpenNewAskPanel() {
  const openThreads = useReviewPanel((state) => state.openThreads);
  useEffect(() => openThreads({ kind: "new-ask" }), [openThreads]);
  return null;
}

function CaptureStore({
  onStore,
}: {
  onStore: (store: ReviewPanelStore) => void;
}) {
  onStore(useReviewPanelStore());
  return null;
}

function OpenTourPanel() {
  const openTour = useReviewPanel((state) => state.openTour);
  useEffect(() => {
    const first = { id: "first", title: "First" } as AnchorRef;
    const second = { id: "second", title: "Second" } as AnchorRef;
    openTour(
      {
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
      },
      first.id,
    );
  }, [openTour]);
  return null;
}

function RestoreThreadsPanel() {
  const restoreThreads = useReviewPanel((state) => state.restoreThreads);
  useEffect(() => restoreThreads(), [restoreThreads]);
  return null;
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
