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
import type { GuidedTour } from "./review-components";
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
  panel?: {
    thread?: { kind: "threads" } | { kind: "commentThread"; threadId: string };
    tour?: { tourId: string; activeAnchor: string };
  };
  /** A fullscreen diagram tour (sequence or database lens) that was open. */
  overlayTour?: { tourId: string; activeAnchor: string };
}

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
  // Overlay tours claim first; the legacy panel.tour slot keeps sessions
  // persisted before tours moved fullscreen restorable.
  const tourRestore = useMemo(
    () =>
      createReviewTourRestoreClaim(
        initialState.overlayTour ?? initialState.panel?.tour,
      ),
    [initialState],
  );

  const persist = useCallback(
    (next: PersistedReviewViewState) => {
      const normalized = parsePersistedReviewViewState(next);
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
    const persistedThread = initialState.panel?.thread;
    if (persistedThread?.kind === "threads") {
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
  const value = readReviewUiState<unknown>(
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
  const thread =
    state.thread?.kind === "threads"
      ? ({ kind: "threads" } as const)
      : state.thread?.kind === "commentThread"
        ? ({
            kind: "commentThread",
            threadId: state.thread.threadId,
          } as const)
        : undefined;
  const tour =
    state.detail?.kind === "tour"
      ? {
          tourId: state.detail.tour.id,
          activeAnchor: state.detail.activeAnchor,
        }
      : undefined;
  return thread || tour ? { thread, tour } : undefined;
}

function parsePersistedReviewViewState(
  value: unknown,
): PersistedReviewViewState {
  if (!value || typeof value !== "object") return {};
  const candidate = value as {
    scrollTop?: unknown;
    activeView?: unknown;
    panel?: {
      thread?: { kind?: unknown; threadId?: unknown };
      tour?: { tourId?: unknown; activeAnchor?: unknown };
    };
    overlayTour?: { tourId?: unknown; activeAnchor?: unknown };
  };
  const state: PersistedReviewViewState = {};
  if (
    typeof candidate.scrollTop === "number" &&
    Number.isFinite(candidate.scrollTop) &&
    candidate.scrollTop >= 0
  ) {
    state.scrollTop = candidate.scrollTop;
  }
  if (
    candidate.activeView === "review" ||
    candidate.activeView === "commits" ||
    candidate.activeView === "map" ||
    candidate.activeView === "diff"
  ) {
    state.activeView = candidate.activeView;
  }
  const thread =
    candidate.panel?.thread?.kind === "threads"
      ? ({ kind: "threads" } as const)
      : candidate.panel?.thread?.kind === "commentThread" &&
          typeof candidate.panel.thread.threadId === "string"
        ? ({
            kind: "commentThread",
            threadId: candidate.panel.thread.threadId,
          } as const)
        : undefined;
  const tour =
    typeof candidate.panel?.tour?.tourId === "string" &&
    typeof candidate.panel.tour.activeAnchor === "string"
      ? {
          tourId: candidate.panel.tour.tourId,
          activeAnchor: candidate.panel.tour.activeAnchor,
        }
      : undefined;
  if (thread || tour) state.panel = { thread, tour };
  if (
    typeof candidate.overlayTour?.tourId === "string" &&
    typeof candidate.overlayTour.activeAnchor === "string"
  ) {
    state.overlayTour = {
      tourId: candidate.overlayTour.tourId,
      activeAnchor: candidate.overlayTour.activeAnchor,
    };
  }
  return state;
}
