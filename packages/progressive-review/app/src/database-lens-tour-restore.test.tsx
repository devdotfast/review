// @vitest-environment jsdom

import { type JsonObject } from "@dev.fast/review-protocol";
import { Profiler, type ReactNode, act } from "react";
import { createRoot } from "react-dom/client";
import {
  type Mock,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { DatabaseLens, DbUseCase, DbWrite } from "./database-lens";
import { ReviewDebugSettingsProvider } from "./debug-settings";
import {
  type ReviewSession,
  ReviewSessionProvider,
} from "./host/review-session";
import { ReviewProvider, useReview } from "./review-context";
import { createTestReviewDefinitionSession } from "./review-definition-test-utils";
import { ReviewPanelProvider } from "./review-panel";
import { ReviewContainerProvider } from "./review-root-context";
import { testReviewSession } from "./review-session-test-utils";
import {
  ReviewViewStateProvider,
  createReviewTourRestoreClaim,
} from "./review-view-state";
import { defineSoftwareModel } from "./software-map/model";

const LENS_TITLE = "Order storage";
const USE_CASE_ID = "create-order";
// lensId = `db:${slug(LENS_TITLE)}` = "db:order-storage"; tourId = `${lensId}-${USE_CASE_ID}`
const TOUR_ID = "db:order-storage-create-order";
const FIRST_ANCHOR = "writePending";
const SECOND_ANCHOR = "writeFulfilled";

const model = defineSoftwareModel({
  systems: {
    product: {
      dataStores: {
        orderDatabase: {
          label: "Order database",
          kind: "database",
          tables: {
            orders: {
              label: "orders",
              schema: {
                id: { type: "text", pk: true },
                status: { type: "text" },
              },
            },
          },
        },
      },
    },
  },
});

const definitions = createTestReviewDefinitionSession({ softwareMap: model });

const anchors = definitions.defineAnchors({
  writePending: {
    title: "Repository writes and queues the order",
    peek: { file: "src/orders/orders-repository.ts", fromLine: 9, toLine: 12 },
  },
  writeFulfilled: {
    title: "Worker writes the fulfilled status",
    peek: {
      file: "src/fulfillment/fulfillment-worker.ts",
      fromLine: 17,
      toLine: 19,
    },
  },
});

const actors = definitions.defineActors({
  writer: { label: "Fulfillment worker" },
});

const stores = definitions.defineSoftwareStores(model, {
  orderDatabase: { path: "product.orderDatabase" },
});

await definitions.ready();

let root: ReturnType<typeof createRoot> | null = null;
let mountContainer: HTMLDivElement;
let canvasRoot: HTMLDivElement;
let session: ReviewSession;
let persistOverlayTour: Mock<
  (open: { tourId: string; activeAnchor: string } | null) => void
>;
// Bounded render guard: the defect (missing once-only guard) makes `useCases`
// churn on every DatabaseLens render (the `stores` record is re-parsed to a new
// reference each render), so the restore effect re-fires unboundedly → an
// effect-mediated infinite loop on mount. The Profiler guard converts that
// loop into a fast, clean test failure instead of a hang. Legitimate mounts
// settle far below MAX_COMMITS_PER_TEST renders.
const MAX_COMMITS_PER_TEST = 200;
let commitCount = 0;

beforeEach(() => {
  commitCount = 0;
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  // Clear wasmUrl so the C4 layout's libavoid init loads the wasm co-located
  // next to its own module (which succeeds) instead of rejecting on a mangled
  // filesystem/URL path (which leaks an unhandled rejection through the shared
  // module registry in this node+jsdom environment).
  session = testReviewSession(
    { wasmUrl: undefined as never },
    { request: async () => jsonResponse({ ok: true }) },
  );
  window.localStorage.clear();
  // The tour panel scrolls the active stop into view; jsdom does not implement
  // either method, so stub both before mounting.
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn<() => void>(),
  });
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    value: vi.fn<() => void>(),
  });
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  class StubResizeObserver implements ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal("ResizeObserver", StubResizeObserver);
  canvasRoot = document.createElement("div");
  canvasRoot.className = "review-canvas-root";
  document.body.append(canvasRoot);
  mountContainer = document.createElement("div");
  document.body.append(mountContainer);
  persistOverlayTour =
    vi.fn<(open: { tourId: string; activeAnchor: string } | null) => void>();
  root = createRoot(mountContainer);
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
  delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  delete (HTMLElement.prototype as { scrollTo?: unknown }).scrollTo;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function LensHost() {
  // Subscribe to the review context so a context-value change (e.g. opening a
  // comment draft) re-renders this host and rebuilds a fresh <DatabaseLens>
  // children tree — mirroring how the compiled MDX re-executes on every
  // review-document re-render.
  useReview();
  return (
    <DatabaseLens title={LENS_TITLE} stores={stores} height={440}>
      <DbUseCase id={USE_CASE_ID} label="Create an order">
        <DbWrite
          from={actors.writer}
          to={stores.orderDatabase.tables!.orders.status}
          label="write pending order"
          anchor={anchors.writePending}
        />
        <DbWrite
          from={actors.writer}
          to={stores.orderDatabase.tables!.orders.status}
          label="write fulfilled status"
          anchor={anchors.writeFulfilled}
        />
      </DbUseCase>
    </DatabaseLens>
  );
}

function makeClaim(activeAnchor: string) {
  return createReviewTourRestoreClaim({ tourId: TOUR_ID, activeAnchor });
}

function render(claim: ReturnType<typeof makeClaim>) {
  act(() => {
    root!.render(
      <ReviewSessionProvider session={session}>
        <ReviewContainerProvider container={canvasRoot}>
          <ReviewDebugSettingsProvider>
            <ReviewPanelProvider>
              <ReviewProvider>
                <ReviewViewStateProvider
                  tourRestore={claim}
                  persistOverlayTour={persistOverlayTour}
                >
                  <RenderGuard>
                    <LensHost />
                  </RenderGuard>
                </ReviewViewStateProvider>
              </ReviewProvider>
            </ReviewPanelProvider>
          </ReviewDebugSettingsProvider>
        </ReviewContainerProvider>
      </ReviewSessionProvider>,
    );
  });
}

function RenderGuard({ children }: { children: ReactNode }) {
  return (
    <Profiler
      id="database-lens"
      onRender={() => {
        commitCount += 1;
        if (commitCount > MAX_COMMITS_PER_TEST) {
          throw new Error(
            `DatabaseLens committed ${commitCount} times — restore effect is looping (the once-only guard is missing).`,
          );
        }
      }}
    >
      {children}
    </Profiler>
  );
}

// Re-render the same tree (same claim, same provider state) so that only the
// <DatabaseLens> children are rebuilt to fresh element references — the exact
// "useCases is a fresh array on every parent re-render" condition.
const rerender = render;

function restoreWrites() {
  return persistOverlayTour.mock.calls
    .filter(([open]) => open && open.tourId === TOUR_ID)
    .map(([open]) => open as { tourId: string; activeAnchor: string });
}

function overlayOpen() {
  return canvasRoot.querySelector(".diagram-tour-overlay") !== null;
}

function lastAnchor() {
  return restoreWrites().at(-1)?.activeAnchor ?? null;
}

function click(selector: string, within: HTMLElement) {
  const button = within.querySelector<HTMLButtonElement>(selector);
  if (!button) throw new Error(`No element matching ${selector}`);
  act(() => button.click());
}

function clickInCanvas(selector: string) {
  click(selector, canvasRoot);
}

function clickInMount(selector: string) {
  click(selector, mountContainer);
}

function advanceToFirst() {
  clickInCanvas('[aria-label="Previous step"]');
}

function closeTour() {
  clickInCanvas('[aria-label="Close guided tour"]');
}

describe("DatabaseLens tour restore", () => {
  it("restores the persisted tour once on mount (T2, G5)", () => {
    render(makeClaim(SECOND_ANCHOR));

    expect(overlayOpen()).toBe(true);
    expect(restoreWrites()).toEqual([
      { tourId: TOUR_ID, activeAnchor: SECOND_ANCHOR },
    ]);
  });

  it("keeps the reader's advanced anchor across a pure parent re-render (T3, G1/G3)", () => {
    const claim = makeClaim(SECOND_ANCHOR);
    render(claim);
    advanceToFirst();
    expect(lastAnchor()).toBe(FIRST_ANCHOR);

    rerender(claim);

    expect(overlayOpen()).toBe(true);
    expect(lastAnchor()).toBe(FIRST_ANCHOR);
  });

  it("keeps a closed tour closed across a pure parent re-render (T4, G2)", () => {
    const claim = makeClaim(SECOND_ANCHOR);
    render(claim);
    expect(overlayOpen()).toBe(true);
    closeTour();
    expect(overlayOpen()).toBe(false);

    rerender(claim);

    expect(overlayOpen()).toBe(false);
    // A single restore write (the mount restore); close wrote null, and the
    // re-render produced no reopen. Before the fix the reopen would append a
    // second {tourId, SECOND_ANCHOR} write and reopen the overlay.
    expect(restoreWrites()).toEqual([
      { tourId: TOUR_ID, activeAnchor: SECOND_ANCHOR },
    ]);
  });

  it("does not rewind when the lens opens a comment draft after advancing (T5, G1 + trigger reachability)", () => {
    const claim = makeClaim(SECOND_ANCHOR);
    render(claim);
    advanceToFirst();
    expect(lastAnchor()).toBe(FIRST_ANCHOR);

    // openActiveUseCaseComment -> review.openCommentDraft -> draftTarget changes
    // -> the review context value changes -> LensHost re-renders with fresh
    // children. This is the trigger the bug report traces end-to-end, and it
    // originates from a control rendered inside DatabaseLens itself.
    clickInMount(".comment-hover-button");

    expect(overlayOpen()).toBe(true);
    expect(lastAnchor()).toBe(FIRST_ANCHOR);
  });

  it("does not reopen after the lens opens a comment draft on a closed tour (T6, G2 + trigger reachability)", () => {
    const claim = makeClaim(SECOND_ANCHOR);
    render(claim);
    closeTour();
    expect(overlayOpen()).toBe(false);

    clickInMount(".comment-hover-button");

    expect(overlayOpen()).toBe(false);
    expect(restoreWrites()).toEqual([
      { tourId: TOUR_ID, activeAnchor: SECOND_ANCHOR },
    ]);
  });

  it("does not restore when no persisted tour matches, and manual open still works (T7, G6/G7)", () => {
    const claim = createReviewTourRestoreClaim({
      tourId: "db:other-lens-other-usecase",
      activeAnchor: SECOND_ANCHOR,
    });
    render(claim);

    expect(overlayOpen()).toBe(false);
    expect(restoreWrites()).toEqual([]);

    clickInMount(".diagram-tour-button");
    expect(overlayOpen()).toBe(true);
    expect(lastAnchor()).toBe(FIRST_ANCHOR);
    expect(restoreWrites()).toEqual([
      { tourId: TOUR_ID, activeAnchor: FIRST_ANCHOR },
    ]);
  });

  it("re-claims a still-valid persisted tour after a full remount (T8, G8)", () => {
    render(makeClaim(SECOND_ANCHOR));
    expect(overlayOpen()).toBe(true);
    closeTour();
    expect(overlayOpen()).toBe(false);

    // A full unmount/remount with a fresh (unclaimed) restore claim re-restores,
    // proving the once-only guard is per-instance, not global.
    act(() => root!.unmount());
    root = createRoot(mountContainer);
    render(makeClaim(SECOND_ANCHOR));

    expect(overlayOpen()).toBe(true);
    // The two distinct mounts each produced a restore write at SECOND.
    expect(
      restoreWrites().filter((w) => w.activeAnchor === SECOND_ANCHOR),
    ).toHaveLength(2);
  });

  it("does not restore when the persisted anchor is no longer a stop (T9, G10)", () => {
    const claim = createReviewTourRestoreClaim({
      tourId: TOUR_ID,
      activeAnchor: "deleted-anchor",
    });
    render(claim);

    expect(overlayOpen()).toBe(false);
    expect(restoreWrites()).toEqual([]);
  });
});

function jsonResponse(body: JsonObject): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
}
