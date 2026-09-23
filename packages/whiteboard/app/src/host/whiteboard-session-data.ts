import type {
  WhiteboardDocumentVersionWire,
  WhiteboardStackLayer,
} from "@dev.fast/whiteboard-protocol";

import type { LoadedAgentTrace } from "../use-agent-trace";

export interface WhiteboardSessionData {
  /** Absent for a review. The scratchpad hides whiteboard-only chrome. */
  kind?: "scratchpad";
  /** Absent for a document whose references all carry their own pins. */
  pins?: { base: string; head: string };
  historicalRevision: string | null;
  updatedAtMs: number;
  /** Head branch captured with the displayed snapshot. */
  headBranch?: string;
  pullRequestNumber?: number;
  pullRequestUrl?: string;
  traces: ReadonlyMap<string, LoadedAgentTrace>;
  listVersions(): Promise<WhiteboardDocumentVersionWire[]>;
  stack(signal: AbortSignal): Promise<WhiteboardStackLayer[]>;
  dismiss(): Promise<void>;
}
