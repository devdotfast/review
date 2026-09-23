import type {
  WhiteboardCommitSummary,
  WhiteboardDiffFileWire,
} from "@dev.fast/whiteboard-protocol";

import { type DiffSelection } from "../../src/lens-selection";

export type WhiteboardPeekContent =
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
  content: WhiteboardPeekContent;
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
  content: WhiteboardPeekContent;
}

export interface TourPanel {
  kind: "tour";
  tour: GuidedTour;
  activeAnchor: string;
  revealRequest: number;
}

export interface CommitDiffPanel {
  kind: "commit-diff";
  commit: WhiteboardCommitSummary;
  file: WhiteboardDiffFileWire;
}

export type WhiteboardPanel = PeekPanel | TourPanel | CommitDiffPanel;

export type WhiteboardPanelMotion = "live" | "restored";
