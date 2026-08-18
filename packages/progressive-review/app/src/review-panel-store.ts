import type {
  ReviewCommitSummary,
  ReviewDiffFileWire,
} from "@dev.fast/review-protocol";
import { createStore } from "zustand/vanilla";

import type { AnchorRef } from "../../src/authoring";
import type { GuidedTour, ReviewPeekContent } from "./review-components";

export type DetailPanel =
  | {
      kind: "peek";
      anchor?: AnchorRef;
      content: ReviewPeekContent;
    }
  | {
      kind: "tour";
      tour: GuidedTour;
      activeAnchor: string;
      revealRequest: number;
    }
  | {
      kind: "commit-diff";
      commit: ReviewCommitSummary;
      file: ReviewDiffFileWire;
    };

export type ThreadPanel =
  | { kind: "threads" }
  | { kind: "new-ask" }
  | { kind: "commentThread"; threadId: string };

export interface ReviewPanelState {
  detail: DetailPanel | null;
  thread: ThreadPanel | null;
  motion: "live" | "restored";
}

export interface ReviewPanelActions {
  suppressMotion: () => void;
  openPeek: (
    anchorOrContent: AnchorRef | ReviewPeekContent,
    content?: ReviewPeekContent,
  ) => void;
  openTour: (tour: GuidedTour, activeAnchor: string) => void;
  openCommitDiff: (
    commit: ReviewCommitSummary,
    file: ReviewDiffFileWire,
  ) => void;
  restoreTour: (tour: GuidedTour, activeAnchor: string) => void;
  activateTourAnchor: (anchorId: string, options: { reveal: boolean }) => void;
  openThreads: () => void;
  restoreThreads: () => void;
  openNewAsk: () => void;
  openCommentThread: (threadId: string) => void;
  showThreads: () => void;
  closeActive: () => void;
  closeThread: () => void;
  closeDetail: () => void;
  reset: () => void;
}

export type ReviewPanelStoreState = ReviewPanelState & ReviewPanelActions;
export type ReviewPanelStore = ReturnType<typeof createReviewPanelStore>;
export type ActiveReviewPanel = DetailPanel | ThreadPanel | null;

export function selectActiveReviewPanel(
  state: ReviewPanelState,
): ActiveReviewPanel {
  return state.thread ?? state.detail;
}

export function createReviewPanelStore() {
  return createStore<ReviewPanelStoreState>()((set) => ({
    detail: null,
    thread: null,
    motion: "live",
    suppressMotion: () => set({ motion: "restored" }),
    openPeek: (anchorOrContent, content) => {
      if (content !== undefined) {
        set({
          detail: {
            kind: "peek",
            anchor: anchorOrContent as AnchorRef,
            content,
          },
          motion: "live",
        });
      } else {
        set({
          detail: {
            kind: "peek",
            content: anchorOrContent as ReviewPeekContent,
          },
          motion: "live",
        });
      }
    },
    openTour: (tour, activeAnchor) => {
      set((state) => ({
        detail: {
          kind: "tour",
          tour,
          activeAnchor,
          revealRequest:
            state.detail?.kind === "tour" ? state.detail.revealRequest + 1 : 1,
        },
        motion: "live",
      }));
    },
    openCommitDiff: (commit, file) =>
      set({ detail: { kind: "commit-diff", commit, file }, motion: "live" }),
    restoreTour: (tour, activeAnchor) => {
      set({
        detail: {
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
        if (state.detail?.kind !== "tour") return state;
        return {
          detail: {
            ...state.detail,
            activeAnchor: anchorId,
            revealRequest: options.reveal
              ? state.detail.revealRequest + 1
              : state.detail.revealRequest,
          },
          motion: options.reveal ? "live" : state.motion,
        };
      });
    },
    openThreads: () => set({ thread: { kind: "threads" }, motion: "live" }),
    restoreThreads: () =>
      set({ thread: { kind: "threads" }, motion: "restored" }),
    openNewAsk: () => set({ thread: { kind: "new-ask" }, motion: "live" }),
    openCommentThread: (threadId) =>
      set({
        thread: { kind: "commentThread", threadId },
        motion: "live",
      }),
    showThreads: () =>
      set((state) =>
        state.thread ? { thread: { kind: "threads" }, motion: "live" } : state,
      ),
    closeActive: () => {
      set((state) =>
        state.thread
          ? { thread: null, motion: "live" }
          : { detail: null, motion: "live" },
      );
    },
    closeThread: () =>
      set((state) => (state.thread ? { thread: null, motion: "live" } : state)),
    closeDetail: () => set({ detail: null, motion: "live" }),
    reset: () => set({ detail: null, thread: null, motion: "live" }),
  }));
}
