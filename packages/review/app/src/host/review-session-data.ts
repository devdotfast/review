import type {
  ReviewDocumentVersionWire,
  ReviewStackLayer,
} from "@dev.fast/review-protocol";

import type { LoadedAgentTrace } from "../use-agent-trace";

/** Facts and actions for the JSON version currently displayed in the canvas. */
export interface ReviewSessionData {
  pins: { base: string; head: string };
  historicalRevision: string | null;
  updatedAtMs: number;
  pullRequestNumber?: number;
  pullRequestUrl?: string;
  traces: ReadonlyMap<string, LoadedAgentTrace>;
  listVersions(): Promise<ReviewDocumentVersionWire[]>;
  stack(signal: AbortSignal): Promise<ReviewStackLayer[]>;
  dismiss(): Promise<void>;
}
