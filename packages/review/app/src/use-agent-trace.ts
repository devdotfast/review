import { type ReviewAgentTraceResponse } from "@dev.fast/review-protocol";

import { useReviewSession } from "./host/review-session";

export type LoadedAgentTrace = Extract<ReviewAgentTraceResponse, { ok: true }>;

export type AgentTraceState =
  | { status: "idle"; trace?: undefined; error?: undefined }
  | { status: "loading"; trace?: undefined; error?: undefined }
  | { status: "error"; error: string; trace?: undefined }
  | { status: "loaded"; trace: LoadedAgentTrace; error?: undefined };

export function makeAgentTraceKey(
  sessionId: string,
  trace?: string | null,
): string {
  return trace ? `${sessionId}:${trace}` : sessionId;
}

/** Loads the currently selected trace for this component instance. */
export function useAgentTrace(
  sessionId?: string | null,
  trace?: string | null,
): AgentTraceState {
  const session = useReviewSession();

  if (!sessionId) return { status: "idle" };

  const retained = session.review!.traces.get(
    makeAgentTraceKey(sessionId, trace),
  );

  return retained
    ? { status: "loaded", trace: retained }
    : { status: "error", error: "Trace is not part of this review version." };
}
