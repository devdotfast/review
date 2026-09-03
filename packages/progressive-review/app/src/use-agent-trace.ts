import {
  type ReviewAgentTraceResponse,
  parseReviewAgentTraceResponse,
} from "@dev.fast/review-protocol";
import { useEffect, useState } from "react";

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

export const makeTraceKey = makeAgentTraceKey;

export function makeAgentTraceUrl(
  sessionId: string,
  trace?: string | null,
): `/${string}` {
  const query = trace ? `?trace=${encodeURIComponent(trace)}` : "";
  return `/agent-traces/${encodeURIComponent(sessionId)}${query}`;
}

/** Loads the currently selected trace for this component instance. */
export function useAgentTrace(
  sessionId?: string | null,
  trace?: string | null,
): AgentTraceState {
  const session = useReviewSession();
  const key = sessionId ? makeAgentTraceKey(sessionId, trace) : null;

  const [state, setState] = useState<{
    key: string | null;
    traceState: AgentTraceState;
  }>(() => {
    if (!key) return { key: null, traceState: { status: "idle" } };
    return { key, traceState: { status: "loading" } };
  });

  const activeState: AgentTraceState =
    state.key === key
      ? state.traceState
      : key
        ? { status: "loading" }
        : { status: "idle" };

  useEffect(() => {
    if (!key || !sessionId) {
      setState({ key: null, traceState: { status: "idle" } });
      return;
    }

    const controller = new AbortController();
    setState({ key, traceState: { status: "loading" } });
    const url = makeAgentTraceUrl(sessionId, trace);
    session
      .fetch(url, { signal: controller.signal })
      .then(async (response) => {
        const json = await response.json();
        const result = parseReviewAgentTraceResponse(json);
        if (!response.ok || !result.ok) {
          throw new Error(result.ok ? "Unable to load trace." : result.error);
        }
        if (!controller.signal.aborted) {
          setState({ key, traceState: { status: "loaded", trace: result } });
        }
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setState({
          key,
          traceState: {
            status: "error",
            error: cause instanceof Error ? cause.message : String(cause),
          },
        });
      });

    return () => {
      controller.abort();
    };
  }, [key, session, sessionId, trace]);

  return activeState;
}
