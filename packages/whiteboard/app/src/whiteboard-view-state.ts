import {
  type JsonObject,
  type JsonValue,
  isJsonObject,
  jsonNumber,
  jsonObject,
  jsonProperty,
  jsonString,
  parseJsonText,
} from "@dev.fast/whiteboard-protocol";
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

import type { WhiteboardClientConfig } from "./host/whiteboard-client";
import { useWhiteboardSession } from "./host/whiteboard-session";
import type { GuidedTour } from "./whiteboard-panel-model";
import type {
  WhiteboardPanelState,
  WhiteboardPanelStore,
} from "./whiteboard-panel-store";
import {
  readWhiteboardUiState,
  removeWhiteboardUiState,
  whiteboardUiStateKey,
  writeWhiteboardUiState,
} from "./whiteboard-ui-state";
import type { WhiteboardView } from "./whiteboard-view-route";

const WHITEBOARD_VIEW_STATE_NAMESPACE = "view-state";

const SCROLL_RESTORE_DEADLINE_MS = 30_000;

export interface PersistedWhiteboardViewState {
  scrollTop?: number;
  activeView?: WhiteboardView;
  panel?: PersistedWhiteboardPanel;
  /** A fullscreen diagram tour (sequence or database lens) that was open. */
  overlayTour?: { tourId: string; activeAnchor: string };
}

export interface PersistedTourPanel {
  kind: "tour";
  tourId: string;
  activeAnchor: string;
}

export type PersistedWhiteboardPanel = PersistedTourPanel;

export interface WhiteboardTourRestore {
  tour: GuidedTour;
  activeAnchor: string;
}

interface WhiteboardTourRestoreClaim {
  claim(
    tours: GuidedTour | readonly GuidedTour[],
  ): WhiteboardTourRestore | null;
}

interface WhiteboardViewStateSync {
  initialActiveView: WhiteboardView | undefined;
  persistActiveView(view: WhiteboardView): void;
  tourRestore: WhiteboardTourRestoreClaim;
  persistOverlayTour(
    open: { tourId: string; activeAnchor: string } | null,
  ): void;
}

interface WhiteboardTourStateContextValue {
  tourRestore: WhiteboardTourRestoreClaim;
  persistOverlayTour(
    open: { tourId: string; activeAnchor: string } | null,
  ): void;
}

const WhiteboardTourStateContext =
  createContext<WhiteboardTourStateContextValue | null>(null);

export function WhiteboardViewStateProvider({
  tourRestore,
  persistOverlayTour,
  children,
}: {
  tourRestore: WhiteboardTourRestoreClaim;
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

  return createElement(
    WhiteboardTourStateContext.Provider,
    { value },
    children,
  );
}

export function useWhiteboardViewStateSync({
  scrollRegionRef,
  panelStore,
}: {
  scrollRegionRef: RefObject<HTMLElement | null>;
  panelStore: WhiteboardPanelStore;
}): WhiteboardViewStateSync {
  const session = useWhiteboardSession();
  const key = whiteboardViewStateKey(session.config);

  const initialState = useMemo(
    () => readPersistedWhiteboardViewState(session.config),
    [session.config],
  );

  const persistedRef = useRef(initialState);

  // Overlay tours claim first; the panel slot keeps older in-panel tours
  // restorable.
  const tourRestore = useMemo(
    () =>
      createWhiteboardTourRestoreClaim(
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
    (next: PersistedWhiteboardViewState) => {
      // Normalise exactly as a stored value reads back.
      const normalized = parsePersistedWhiteboardViewState(
        parseJsonText(JSON.stringify(next)),
      );

      if (JSON.stringify(normalized) === JSON.stringify(persistedRef.current)) {
        return;
      }

      persistedRef.current = normalized;
      writeWhiteboardUiState("session", key, normalized);
    },
    [key],
  );

  const persistActiveView = useCallback(
    (view: WhiteboardView) => {
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
): WhiteboardTourRestore | null {
  const claim = useContext(WhiteboardTourStateContext)?.tourRestore;
  const attemptedRef = useRef(false);
  const [restore, setRestore] = useState<WhiteboardTourRestore | null>(null);
  useLayoutEffect(() => {
    if (attemptedRef.current) return;
    attemptedRef.current = true;
    setRestore(claim?.claim(tours) ?? null);
  }, [claim, tours]);

  return restore;
}

/** Keeps the persisted view state in step with a fullscreen diagram tour:
 * pass the open tour and its active anchor, or null when closed. An owner
 * that has not opened a tour in this mount never writes: a stored tour may
 * belong to another diagram that has yet to claim it. */
export function useTourPersist(
  tour: GuidedTour | null,
  activeAnchor: string | null,
): void {
  const persistOverlayTour = useContext(
    WhiteboardTourStateContext,
  )?.persistOverlayTour;

  const openedRef = useRef(false);

  useEffect(() => {
    const open =
      tour && activeAnchor ? { tourId: tour.id, activeAnchor } : null;

    if (open) openedRef.current = true;
    else if (!openedRef.current) return;

    persistOverlayTour?.(open);
  }, [activeAnchor, persistOverlayTour, tour]);
}

export function whiteboardViewStateKey(config: WhiteboardClientConfig): string {
  return whiteboardUiStateKey(
    config,
    "session",
    WHITEBOARD_VIEW_STATE_NAMESPACE,
  );
}

export function readPersistedWhiteboardViewState(
  config: WhiteboardClientConfig,
): PersistedWhiteboardViewState {
  const value = readWhiteboardUiState<JsonValue>(
    "session",
    whiteboardViewStateKey(config),
  );

  return parsePersistedWhiteboardViewState(value);
}

export function clearPersistedWhiteboardViewState(
  config: WhiteboardClientConfig,
): void {
  removeWhiteboardUiState("session", whiteboardViewStateKey(config));
}

export function createWhiteboardTourRestoreClaim(
  pending: { tourId: string; activeAnchor: string } | null | undefined,
): WhiteboardTourRestoreClaim {
  let claimed = false;

  return {
    claim(tours) {
      if (claimed || !pending) return null;

      const candidates: readonly GuidedTour[] = Array.isArray(tours)
        ? tours
        : [tours];

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

      for (const child of layoutChildren(scrollRegion)) {
        resizeObserver.observe(child);
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

/**
 * The region's box-generating children: any descendant growing resizes one of
 * them, so observing these sees every change without observing the document.
 * `display: contents` wrappers generate no box, so look through them.
 */
function* layoutChildren(element: Element): Generator<Element> {
  for (const child of element.children) {
    if (getComputedStyle(child).display === "contents") {
      yield* layoutChildren(child);
    } else {
      yield child;
    }
  }
}

function useScrollCapture(
  scrollRegionRef: RefObject<HTMLElement | null>,
  persist: (state: PersistedWhiteboardViewState) => void,
  persistedRef: RefObject<PersistedWhiteboardViewState>,
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
  state: WhiteboardPanelState,
): PersistedWhiteboardViewState["panel"] {
  if (state.active?.kind === "tour") {
    return {
      kind: "tour",
      tourId: state.active.tour.id,
      activeAnchor: state.active.activeAnchor,
    };
  }

  return undefined;
}

function parsePersistedWhiteboardViewState(
  value: JsonValue | null,
): PersistedWhiteboardViewState {
  if (!isJsonObject(value)) return {};
  const state: PersistedWhiteboardViewState = {};
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

function parsePersistedPanel(
  panel: JsonObject | undefined,
): PersistedWhiteboardPanel | undefined {
  if (!panel) return undefined;
  const kind = jsonString(jsonProperty(panel, "kind"));
  const tour = parsePersistedTourState(panel);

  if (kind === "tour" && tour) return { kind: "tour", ...tour };

  return undefined;
}

function parsePersistedTourState(
  tour: JsonObject | undefined,
): PersistedWhiteboardViewState["overlayTour"] {
  const tourId = jsonString(tour && jsonProperty(tour, "tourId"));
  const activeAnchor = jsonString(tour && jsonProperty(tour, "activeAnchor"));

  return tourId !== undefined && activeAnchor !== undefined
    ? { tourId, activeAnchor }
    : undefined;
}
