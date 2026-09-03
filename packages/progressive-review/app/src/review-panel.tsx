import { REVIEW_CANVAS_RESUME_EVENT } from "@dev.fast/review-protocol";
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
  type ReviewPanelStore,
  type ReviewPanelStoreState,
  createReviewPanelStore,
} from "./review-panel-store";

const ReviewPanelContext = createContext<ReviewPanelStore | null>(null);
const fallbackReviewPanelStore = createReviewPanelStore();

export function ReviewPanelProvider({
  children,
  detailRevision,
}: {
  children: ReactNode;
  detailRevision?: unknown;
}) {
  const [store] = useState(createReviewPanelStore);
  const previousDetailRevision = useRef(detailRevision);
  useEffect(() => {
    if (previousDetailRevision.current === detailRevision) return;
    previousDetailRevision.current = detailRevision;
    store.getState().closeForDocumentChange();
  }, [detailRevision, store]);
  return (
    <ReviewPanelContext.Provider value={store}>
      {children}
    </ReviewPanelContext.Provider>
  );
}

export function useReviewPanel<T>(
  selector: (state: ReviewPanelStoreState) => T,
): T {
  return useStore(useReviewPanelStore(), selector);
}

export function useOptionalReviewPanelStore(): ReviewPanelStore | null {
  return useContext(ReviewPanelContext);
}

export function useOptionalReviewPanel<T>(
  selector: (state: ReviewPanelStoreState) => T,
): T | undefined {
  const store = useContext(ReviewPanelContext);
  const selected = useStore(store ?? fallbackReviewPanelStore, selector);
  return store ? selected : undefined;
}

export function useReviewPanelStore(): ReviewPanelStore {
  const store = useContext(ReviewPanelContext);
  if (!store) {
    throw new Error(
      "Review panel components must render inside ReviewPanelProvider",
    );
  }
  return store;
}

export function useSuppressPanelMotionOnCanvasResume(
  appRef: RefObject<HTMLElement | null>,
): void {
  const store = useReviewPanelStore();
  useEffect(() => {
    const canvasRoot = appRef.current?.closest(".review-canvas-root");
    if (!canvasRoot) return;
    const suppressMotion = () => store.getState().suppressMotion();
    canvasRoot.addEventListener(REVIEW_CANVAS_RESUME_EVENT, suppressMotion);
    return () =>
      canvasRoot.removeEventListener(
        REVIEW_CANVAS_RESUME_EVENT,
        suppressMotion,
      );
  }, [appRef, store]);
}
