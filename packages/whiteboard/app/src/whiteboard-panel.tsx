import { WHITEBOARD_CANVAS_RESUME_EVENT } from "@dev.fast/whiteboard-protocol";
import {
  type ReactNode,
  type RefObject,
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { useStore } from "zustand";

import {
  type WhiteboardPanelStore,
  type WhiteboardPanelStoreState,
  createWhiteboardPanelStore,
} from "./whiteboard-panel-store";

const WhiteboardPanelContext = createContext<WhiteboardPanelStore | null>(null);

const fallbackWhiteboardPanelStore = createWhiteboardPanelStore();

export function WhiteboardPanelProvider({
  children,
  detailRevision,
}: {
  children: ReactNode;
  detailRevision?: unknown;
}) {
  const [store] = useState(createWhiteboardPanelStore);
  const previousDetailRevision = useRef(detailRevision);
  useEffect(() => {
    if (previousDetailRevision.current === detailRevision) return;
    previousDetailRevision.current = detailRevision;
    store.getState().closeForDocumentChange();
  }, [detailRevision, store]);

  return (
    <WhiteboardPanelContext.Provider value={store}>
      {children}
    </WhiteboardPanelContext.Provider>
  );
}

export function useWhiteboardPanel<T>(
  selector: (state: WhiteboardPanelStoreState) => T,
): T {
  return useStore(useWhiteboardPanelStore(), selector);
}

export function useOptionalWhiteboardPanelStore(): WhiteboardPanelStore | null {
  return useContext(WhiteboardPanelContext);
}

export function useOptionalWhiteboardPanel<T>(
  selector: (state: WhiteboardPanelStoreState) => T,
): T | undefined {
  const store = useContext(WhiteboardPanelContext);
  const selected = useStore(store ?? fallbackWhiteboardPanelStore, selector);

  return store ? selected : undefined;
}

export function useWhiteboardPanelStore(): WhiteboardPanelStore {
  const store = useContext(WhiteboardPanelContext);

  if (!store) {
    throw new Error(
      "Whiteboard panel components must render inside WhiteboardPanelProvider",
    );
  }

  return store;
}

export function useSuppressPanelMotionOnCanvasResume(
  appRef: RefObject<HTMLElement | null>,
): void {
  const store = useWhiteboardPanelStore();
  useEffect(() => {
    const canvasRoot = appRef.current?.closest(".whiteboard-canvas-root");

    if (!canvasRoot) return;
    const suppressMotion = () => store.getState().suppressMotion();
    canvasRoot.addEventListener(WHITEBOARD_CANVAS_RESUME_EVENT, suppressMotion);

    return () =>
      canvasRoot.removeEventListener(
        WHITEBOARD_CANVAS_RESUME_EVENT,
        suppressMotion,
      );
  }, [appRef, store]);
}
