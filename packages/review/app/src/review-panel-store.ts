import { createStore } from "zustand/vanilla";

import type {
  GuidedTour,
  PeekPanel,
  ReviewPanel,
  ReviewPanelMotion,
} from "./review-panel-model";

export interface ReviewPanelState {
  active: ReviewPanel | null;
  motion: ReviewPanelMotion;
}

export interface ReviewPanelActions {
  suppressMotion: () => void;
  openPeek: (panel: PeekPanel) => void;
  openTour: (tour: GuidedTour, activeAnchor: string) => void;
  restoreTour: (tour: GuidedTour, activeAnchor: string) => void;
  activateTourAnchor: (anchorId: string, options: { reveal: boolean }) => void;
  close: () => void;
  closeForDocumentChange: () => void;
}

export type ReviewPanelStoreState = ReviewPanelState & ReviewPanelActions;

export type ReviewPanelStore = ReturnType<typeof createReviewPanelStore>;

export function createReviewPanelStore() {
  return createStore<ReviewPanelStoreState>()((set) => ({
    active: null,
    motion: "live",
    suppressMotion: () => set({ motion: "restored" }),
    openPeek: (panel) => set({ active: panel, motion: "live" }),
    openTour: (tour, activeAnchor) => {
      set((state) => ({
        active: {
          kind: "tour",
          tour,
          activeAnchor,
          revealRequest:
            state.active?.kind === "tour" ? state.active.revealRequest + 1 : 1,
        },
        motion: "live",
      }));
    },
    restoreTour: (tour, activeAnchor) => {
      set({
        active: {
          kind: "tour",
          tour,
          activeAnchor,
          revealRequest: 0,
        },
        motion: "restored",
      });
    },
    activateTourAnchor: (anchorId, options) => {
      set((state) => {
        if (state.active?.kind !== "tour") return state;

        return {
          active: {
            ...state.active,
            activeAnchor: anchorId,
            revealRequest: options.reveal
              ? state.active.revealRequest + 1
              : state.active.revealRequest,
          },
          motion: options.reveal ? "live" : state.motion,
        };
      });
    },
    close: () => set({ active: null, motion: "live" }),
    closeForDocumentChange: () =>
      set((state) => (state.active ? { active: null, motion: "live" } : state)),
  }));
}
