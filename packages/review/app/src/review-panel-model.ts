import type {
  ReviewCommitSummary,
  ReviewDiffFileWire,
} from "@dev.fast/review-protocol";

import type { AnchorRef } from "../../src/authoring";
import type { ValidatedCodePeekInput } from "./CodePeek";

export type ReviewPeekContent =
  | { kind: "resolved-code"; input: ValidatedCodePeekInput }
  | { kind: "inline-code"; language?: string; text: string }
  | {
      kind: "trace-quote";
      sessionId: string;
      trace?: string;
      event?: number;
      quote: string;
    };

export interface GuidedTourStop {
  anchor: AnchorRef;
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
  anchor?: AnchorRef;
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

export interface ThreadsListPage {
  kind: "list";
}

export interface NewAskPage {
  kind: "new-ask";
}

export interface CommentThreadPage {
  kind: "comment";
  threadId: string;
}

export type ThreadsPage = ThreadsListPage | NewAskPage | CommentThreadPage;

export interface ThreadsPanel {
  kind: "threads";
  page: ThreadsPage;
}

export type ReviewPanel =
  | PeekPanel
  | TourPanel
  | CommitDiffPanel
  | ThreadsPanel;

export type ReviewPanelMotion = "live" | "restored";

export function isDetailPanel(
  panel: ReviewPanel | null,
): panel is PeekPanel | TourPanel | CommitDiffPanel {
  return panel !== null && panel.kind !== "threads";
}
