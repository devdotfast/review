import {
  type JsonObject,
  type JsonValue,
  isJsonObject,
  jsonNumber,
  jsonObject,
  jsonProperty,
  jsonString,
  parseJsonText,
} from "@dev.fast/review-protocol";
import type { ReactNode, RefObject } from "react";
import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type { ReviewClientConfig } from "./host/review-client";
import { useReviewSession } from "./host/review-session";
import type { GuidedTour } from "./review-panel-model";
import type { ReviewPanelState, ReviewPanelStore } from "./review-panel-store";
import {
  readReviewUiState,
  removeReviewUiState,
  reviewUiStateKey,
  writeReviewUiState,
} from "./review-ui-state";
import type { ReviewView } from "./review-view-route";

const REVIEW_VIEW_STATE_NAMESPACE = "view-state";
const SCROLL_RESTORE_DEADLINE_MS = 30_000;

export interface PersistedReviewViewState {
  scrollTop?: number;
  activeView?: ReviewView;
  panel?: PersistedReviewPanel;
  /** A fullscreen diagram tour (sequence or database lens) that was open. */
  overlayTour?: { tourId: string; activeAnchor: string };
}

export interface PersistedThreadsPanel {
  kind: "threads";
}

export interface PersistedTourPanel {
  kind: "tour";
  tourId: string;
  activeAnchor: string;
}

export type PersistedReviewPanel = PersistedThreadsPanel | PersistedTourPanel;

export interface ReviewTourRestore {
  tour: GuidedTour;
  activeAnchor: string;
}

interface ReviewTourRestoreClaim {
  claim(tours: GuidedTour | readonly GuidedTour[]): ReviewTourRestore | null;
}

interface ReviewViewStateSync {
  initialActiveView: ReviewView | undefined;
  persistActiveView(view: ReviewView): void;
  tourRestore: ReviewTourRestoreClaim;
  persistOverlayTour(
    open: { tourId: string; activeAnchor: string } | null,
  ): void;
}

interface ReviewTourStateContextValue {
  tourRestore: ReviewTourRestoreClaim;
  persistOverlayTour(
    open: { tourId: string; activeAnchor: string } | null,
  ): void;
}

const ReviewTourStateContext =
  createContext<ReviewTourStateContextValue | null>(null);

export function ReviewViewStateProvider({
  tourRestore,
  persistOverlayTour,
  children,
}: {
  tourRestore: ReviewTourRestoreClaim;
  persistOverlayTour?: (
    open: { tourId: string; activeAnchor: string } | null,
  ) => void;
  children: ReactNode;
}) {
  const value = useMemo(
    () => ({
      tourRestore,
      persistOverlayTour: persistOverlayTour ?? (() => {}),
    }),
    [persistOverlayTour, tourRestore],
  );
  return createElement(ReviewTourStateContext.Provider, { value }, children);
}

export function useReviewViewStateSync({
  scrollRegionRef,
  panelStore,
}: {
  scrollRegionRef: RefObject<HTMLElement | null>;
  panelStore: ReviewPanelStore;
}): ReviewViewStateSync {
  const session = useReviewSession();
  const key = reviewViewStateKey(session.config);
  const initialState = useMemo(
    () => readPersistedReviewViewState(session.config),
    [session],
  );
  const persistedRef = useRef(initialState);
  // Overlay tours claim first; the panel slot keeps older in-panel tours
  // restorable.
  const tourRestore = useMemo(
    () =>
      createReviewTourRestoreClaim(
        initialState.overlayTour ??
          (initialState.panel?.kind === "tour"
            ? {
                tourId: initialState.panel.tourId,
                activeAnchor: initialState.panel.activeAnchor,
              }
            : undefined),
      ),
    [initialState],
  );

  const persist = useCallback(
    (next: PersistedReviewViewState) => {
      // Normalise exactly as a stored value reads back.
      const normalized = parsePersistedReviewViewState(
        parseJsonText(JSON.stringify(next)),
      );
      if (JSON.stringify(normalized) === JSON.stringify(persistedRef.current)) {
        return;
      }
      persistedRef.current = normalized;
      writeReviewUiState("session", key, normalized);
    },
    [key],
  );

  const persistActiveView = useCallback(
    (view: ReviewView) => {
      persist({ ...persistedRef.current, activeView: view });
    },
    [persist],
  );

  const persistOverlayTour = useCallback(
    (open: { tourId: string; activeAnchor: string } | null) => {
      persist({ ...persistedRef.current, overlayTour: open ?? undefined });
    },
    [persist],
  );

  useLayoutEffect(() => {
    if (initialState.panel?.kind === "threads") {
      panelStore.getState().restoreThreads();
    }
  }, [initialState, panelStore]);

  useEffect(
    () =>
      panelStore.subscribe((state) => {
        persist({
          ...persistedRef.current,
          panel: persistedPanelState(state),
        });
      }),
    [panelStore, persist],
  );

  const scrollRestorationPending = useScrollRestoration(
    scrollRegionRef,
    initialState.scrollTop,
  );
  useScrollCapture(
    scrollRegionRef,
    persist,
    persistedRef,
    scrollRestorationPending,
  );

  return {
    initialActiveView: initialState.activeView,
    persistActiveView,
    tourRestore,
    persistOverlayTour,
  };
}

export function useTourRestore(
  tours: GuidedTour | readonly GuidedTour[],
): ReviewTourRestore | null {
  const claim = useContext(ReviewTourStateContext)?.tourRestore;
  const attemptedRef = useRef(false);
  const [restore, setRestore] = useState<ReviewTourRestore | null>(null);
  useLayoutEffect(() => {
    if (attemptedRef.current) return;
    attemptedRef.current = true;
    setRestore(claim?.claim(tours) ?? null);
  }, [claim, tours]);
  return restore;
}

/** Keeps the persisted view state in step with a fullscreen diagram tour:
 * pass the open tour and its active anchor, or null when closed. */
export function useTourPersist(
  tour: GuidedTour | null,
  activeAnchor: string | null,
): void {
  const persistOverlayTour = useContext(
    ReviewTourStateContext,
  )?.persistOverlayTour;
  useEffect(() => {
    persistOverlayTour?.(
      tour && activeAnchor ? { tourId: tour.id, activeAnchor } : null,
    );
  }, [activeAnchor, persistOverlayTour, tour]);
}

export function reviewViewStateKey(config: ReviewClientConfig): string {
  return reviewUiStateKey(config, "session", REVIEW_VIEW_STATE_NAMESPACE);
}

export function readPersistedReviewViewState(
  config: ReviewClientConfig,
): PersistedReviewViewState {
  const value = readReviewUiState<JsonValue>(
    "session",
    reviewViewStateKey(config),
  );
  return parsePersistedReviewViewState(value);
}

export function clearPersistedReviewViewState(
  config: ReviewClientConfig,
): void {
  removeReviewUiState("session", reviewViewStateKey(config));
}

export function createReviewTourRestoreClaim(
  pending: { tourId: string; activeAnchor: string } | null | undefined,
): ReviewTourRestoreClaim {
  let claimed = false;
  return {
    claim(tours) {
      if (claimed || !pending) return null;
      const candidates = (
        Array.isArray(tours) ? tours : [tours]
      ) as readonly GuidedTour[];
      const tour = candidates.find(
        (candidate) => candidate.id === pending.tourId,
      );
      if (!tour) return null;
      claimed = true;
      if (!tour.stops.some((stop) => stop.anchor.id === pending.activeAnchor)) {
        return null;
      }
      return { tour, activeAnchor: pending.activeAnchor };
    },
  };
}

function useScrollRestoration(
  scrollRegionRef: RefObject<HTMLElement | null>,
  scrollTop: number | undefined,
): RefObject<boolean> {
  const pendingRef = useRef(false);
  useLayoutEffect(() => {
    const scrollRegion = scrollRegionRef.current;
    pendingRef.current = scrollRegion !== null && scrollTop !== undefined;
    if (!scrollRegion || scrollTop === undefined) return;
    let deadline: ReturnType<typeof setTimeout> | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let aborted = false;

    const removeUserListeners = () => {
      scrollRegion.removeEventListener("wheel", abortForUserInput);
      scrollRegion.removeEventListener("pointerdown", abortForUserInput);
      scrollRegion.removeEventListener("touchstart", abortForUserInput);
      scrollRegion.removeEventListener("keydown", abortForNavigationKey);
    };
    const finish = () => {
      if (aborted) return;
      aborted = true;
      pendingRef.current = false;
      if (deadline !== null) clearTimeout(deadline);
      deadline = null;
      resizeObserver?.disconnect();
      resizeObserver = null;
      removeUserListeners();
    };
    const restore = () => {
      if (aborted) return;
      const maxScrollTop = Math.max(
        0,
        scrollRegion.scrollHeight - scrollRegion.clientHeight,
      );
      scrollRegion.scrollTop = Math.min(scrollTop, maxScrollTop);
      if (scrollTop <= maxScrollTop) {
        finish();
      }
    };
    const abortForUserInput = () => finish();
    const abortForNavigationKey = (event: Event) => {
      if (
        event instanceof KeyboardEvent &&
        [
          "ArrowDown",
          "ArrowLeft",
          "ArrowRight",
          "ArrowUp",
          "End",
          "Home",
          "PageDown",
          "PageUp",
        ].includes(event.key)
      ) {
        finish();
      }
    };

    scrollRegion.addEventListener("wheel", abortForUserInput, {
      passive: true,
    });
    scrollRegion.addEventListener("pointerdown", abortForUserInput, {
      passive: true,
    });
    scrollRegion.addEventListener("touchstart", abortForUserInput, {
      passive: true,
    });
    scrollRegion.addEventListener("keydown", abortForNavigationKey);
    resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(restore);
    if (resizeObserver) {
      resizeObserver.observe(scrollRegion);
      for (const element of scrollRegion.querySelectorAll("*")) {
        resizeObserver.observe(element);
      }
    }
    deadline = setTimeout(finish, SCROLL_RESTORE_DEADLINE_MS);
    restore();
    return () => {
      if (deadline !== null) clearTimeout(deadline);
      resizeObserver?.disconnect();
      removeUserListeners();
      pendingRef.current = false;
    };
  }, [scrollRegionRef, scrollTop]);
  return pendingRef;
}

function useScrollCapture(
  scrollRegionRef: RefObject<HTMLElement | null>,
  persist: (state: PersistedReviewViewState) => void,
  persistedRef: RefObject<PersistedReviewViewState>,
  restorationPending: RefObject<boolean>,
): void {
  useEffect(() => {
    const scrollRegion = scrollRegionRef.current;
    if (!scrollRegion) return;
    let frame: number | null = null;
    let dirty = false;
    const write = () => {
      frame = null;
      if (!dirty) return;
      dirty = false;
      if (restorationPending.current) return;
      persist({
        ...persistedRef.current,
        scrollTop: scrollRegion.scrollTop,
      });
    };
    const onScroll = () => {
      dirty = true;
      if (frame === null) frame = requestAnimationFrame(write);
    };
    scrollRegion.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      scrollRegion.removeEventListener("scroll", onScroll);
      if (frame !== null) cancelAnimationFrame(frame);
      if (dirty) write();
    };
  }, [persist, persistedRef, restorationPending, scrollRegionRef]);
}

function persistedPanelState(
  state: ReviewPanelState,
): PersistedReviewViewState["panel"] {
  if (state.active?.kind === "threads" && state.active.page.kind === "list") {
    return { kind: "threads" };
  }
  if (state.active?.kind === "tour") {
    return {
      kind: "tour",
      tourId: state.active.tour.id,
      activeAnchor: state.active.activeAnchor,
    };
  }
  return undefined;
}

function parsePersistedReviewViewState(
  value: JsonValue | null,
): PersistedReviewViewState {
  if (!isJsonObject(value)) return {};
  const state: PersistedReviewViewState = {};
  const scrollTop = jsonNumber(jsonProperty(value, "scrollTop"));
  if (scrollTop !== undefined && scrollTop >= 0) state.scrollTop = scrollTop;
  const activeView = jsonString(jsonProperty(value, "activeView"));
  if (
    activeView === "review" ||
    activeView === "commits" ||
    activeView === "map" ||
    activeView === "diff"
  ) {
    state.activeView = activeView;
  }
  const panel = parsePersistedPanel(jsonObject(jsonProperty(value, "panel")));
  if (panel) state.panel = panel;
  const overlayTour = parsePersistedTourState(
    jsonObject(jsonProperty(value, "overlayTour")),
  );
  if (overlayTour) state.overlayTour = overlayTour;
  return state;
}

/** The persisted panel, also accepting the legacy layered `{ thread, tour }` form. */
function parsePersistedPanel(
  panel: JsonObject | undefined,
): PersistedReviewPanel | undefined {
  if (!panel) return undefined;
  const kind = jsonString(jsonProperty(panel, "kind"));
  const tour = parsePersistedTourState(panel);
  if (kind === "tour" && tour) return { kind: "tour", ...tour };
  const legacyThread = jsonObject(jsonProperty(panel, "thread"));
  if (
    kind === "threads" ||
    jsonString(legacyThread && jsonProperty(legacyThread, "kind")) === "threads"
  ) {
    return { kind: "threads" };
  }
  const legacyTour = parsePersistedTourState(
    jsonObject(jsonProperty(panel, "tour")),
  );
  return legacyTour ? { kind: "tour", ...legacyTour } : undefined;
}

function parsePersistedTourState(
  tour: JsonObject | undefined,
): PersistedReviewViewState["overlayTour"] {
  const tourId = jsonString(tour && jsonProperty(tour, "tourId"));
  const activeAnchor = jsonString(tour && jsonProperty(tour, "activeAnchor"));
  return tourId !== undefined && activeAnchor !== undefined
    ? { tourId, activeAnchor }
    : undefined;
}
