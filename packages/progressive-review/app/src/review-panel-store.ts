import { createStore } from "zustand/vanilla";

import type {
  CommitDiffPanel,
  GuidedTour,
  PeekPanel,
  ReviewPanel,
  ReviewPanelMotion,
  ThreadsPage,
} from "./review-panel-model";
import { isDetailPanel } from "./review-panel-model";

export interface ReviewPanelState {
  active: ReviewPanel | null;
  motion: ReviewPanelMotion;
}

export interface ReviewPanelActions {
  suppressMotion: () => void;
  openPeek: (panel: PeekPanel) => void;
  openTour: (tour: GuidedTour, activeAnchor: string) => void;
  openCommitDiff: (panel: CommitDiffPanel) => void;
  restoreTour: (tour: GuidedTour, activeAnchor: string) => void;
  activateTourAnchor: (anchorId: string, options: { reveal: boolean }) => void;
  openThreads: (page?: ThreadsPage) => void;
  /** Moves within Threads while it is active; a no-op once another surface
   *  (such as the agent terminal) has closed it. */
  setThreadsPage: (page: ThreadsPage) => void;
  restoreThreads: () => void;
  close: () => void;
  closeForAgentTerminal: () => void;
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
    openCommitDiff: (panel) => set({ active: panel, motion: "live" }),
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
    openThreads: (page = { kind: "list" }) =>
      set({ active: { kind: "threads", page }, motion: "live" }),
    setThreadsPage: (page) =>
      set((state) =>
        state.active?.kind === "threads"
          ? { active: { kind: "threads", page } }
          : state,
      ),
    restoreThreads: () =>
      set({
        active: { kind: "threads", page: { kind: "list" } },
        motion: "restored",
      }),
    close: () => set({ active: null, motion: "live" }),
    closeForAgentTerminal: () =>
      set((state) =>
        state.active?.kind === "threads"
          ? { active: null, motion: "live" }
          : state,
      ),
    closeForDocumentChange: () =>
      set((state) =>
        isDetailPanel(state.active) ? { active: null, motion: "live" } : state,
      ),
  }));
}
