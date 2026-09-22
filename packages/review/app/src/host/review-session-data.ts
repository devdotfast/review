import type {
  ReviewDocumentVersionWire,
  ReviewStackLayer,
} from "@dev.fast/review-protocol";

import type { LoadedAgentTrace } from "../use-agent-trace";

export interface ReviewSessionData {
  /** Absent for a document whose references all carry their own pins. */
  pins?: { base: string; head: string };
  historicalRevision: string | null;
  updatedAtMs: number;
  pullRequestNumber?: number;
  pullRequestUrl?: string;
  traces: ReadonlyMap<string, LoadedAgentTrace>;
  listVersions(): Promise<ReviewDocumentVersionWire[]>;
  stack(signal: AbortSignal): Promise<ReviewStackLayer[]>;
  dismiss(): Promise<void>;
}
