import type {
  ReviewCommitSummary,
  ReviewDiffFileWire,
} from "@dev.fast/review-protocol";

import { type DiffSelection } from "../../src/lens-selection";

export type ReviewPeekContent =
  | { kind: "source"; source: DiffSelection }
  | { kind: "inline-code"; language?: string; text: string }
  | { kind: "explanation"; text?: string }
  | {
      kind: "trace-quote";
      sessionId: string;
      trace?: string;
      event?: number;
      quote: string;
    };

/** What a peek or tour stop needs to know about its subject. Components build
 * one from their own document props; it is the panel's contract, not the
 * authoring anchor. */
export interface PeekAnchor {
  id: string;
  title: string;
  detail?: string;
  peek?: DiffSelection;
  softwareMapPath?: string;
}

export interface GuidedTourStop {
  anchor: PeekAnchor;
  label: string;
  detail?: string;
  content: ReviewPeekContent;
}

export interface GuidedTour {
  id: string;
  title?: string;
  stops: GuidedTourStop[];
  telemetryKind?: "sequence";
}

export interface PeekPanel {
  kind: "peek";
  anchor?: PeekAnchor;
  content: ReviewPeekContent;
}

export interface TourPanel {
  kind: "tour";
  tour: GuidedTour;
  activeAnchor: string;
  revealRequest: number;
}

export interface CommitDiffPanel {
  kind: "commit-diff";
  commit: ReviewCommitSummary;
  file: ReviewDiffFileWire;
}

export type ReviewPanel = PeekPanel | TourPanel | CommitDiffPanel;

export type ReviewPanelMotion = "live" | "restored";
