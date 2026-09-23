import { createStore } from "zustand/vanilla";

import type {
  CommitDiffPanel,
  GuidedTour,
  PeekPanel,
  WhiteboardPanel,
  WhiteboardPanelMotion,
} from "./whiteboard-panel-model";

export interface WhiteboardPanelState {
  active: WhiteboardPanel | null;
  motion: WhiteboardPanelMotion;
}

export interface WhiteboardPanelActions {
  suppressMotion: () => void;
  openPeek: (panel: PeekPanel) => void;
  openTour: (tour: GuidedTour, activeAnchor: string) => void;
  openCommitDiff: (panel: CommitDiffPanel) => void;
  restoreTour: (tour: GuidedTour, activeAnchor: string) => void;
  activateTourAnchor: (anchorId: string, options: { reveal: boolean }) => void;
  close: () => void;
  closeForDocumentChange: () => void;
}

export type WhiteboardPanelStoreState = WhiteboardPanelState &
  WhiteboardPanelActions;

export type WhiteboardPanelStore = ReturnType<
  typeof createWhiteboardPanelStore
>;

export function createWhiteboardPanelStore() {
  return createStore<WhiteboardPanelStoreState>()((set) => ({
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
    close: () => set({ active: null, motion: "live" }),
    closeForDocumentChange: () =>
      set((state) => (state.active ? { active: null, motion: "live" } : state)),
  }));
}
