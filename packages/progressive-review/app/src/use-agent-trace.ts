import {
  type ReviewAgentTraceResponse,
  parseReviewAgentTraceResponse,
} from "@dev.fast/review-protocol";
import { useEffect, useState } from "react";

import { type ReviewSession, useReviewSession } from "./host/review-session";

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

interface InFlightRequest {
  controller: AbortController;
  subscribers: Set<(state: AgentTraceState) => void>;
}

let traceCaches = new WeakMap<ReviewSession, Map<string, LoadedAgentTrace>>();
let inFlightRequestCaches = new WeakMap<
  ReviewSession,
  Map<string, InFlightRequest>
>();

function traceCacheFor(session: ReviewSession): Map<string, LoadedAgentTrace> {
  let cache = traceCaches.get(session);
  if (!cache) {
    cache = new Map();
    traceCaches.set(session, cache);
  }
  return cache;
}

function inFlightRequestsFor(
  session: ReviewSession,
): Map<string, InFlightRequest> {
  let requests = inFlightRequestCaches.get(session);
  if (!requests) {
    requests = new Map();
    inFlightRequestCaches.set(session, requests);
  }
  return requests;
}

export function getAgentTraceCache(
  session: ReviewSession,
  key: string,
): LoadedAgentTrace | undefined {
  return traceCaches.get(session)?.get(key);
}

export function clearAgentTraceCache(session?: ReviewSession): void {
  if (!session) {
    traceCaches = new WeakMap();
    inFlightRequestCaches = new WeakMap();
    return;
  }
  traceCaches.delete(session);
  const requests = inFlightRequestCaches.get(session);
  for (const request of requests?.values() ?? []) {
    request.controller.abort();
  }
  inFlightRequestCaches.delete(session);
}

/**
 * Shared data hook to load and cache agent traces.
 * Manages request URL construction, loading/error/loaded state transitions,
 * abort-on-unmount, session-scoped response caching, and in-flight request
 * deduplication.
 */
export function useAgentTrace(
  sessionId?: string | null,
  trace?: string | null,
): AgentTraceState {
  const session = useReviewSession();
  const key = sessionId ? makeAgentTraceKey(sessionId, trace) : null;
  const traceCache = traceCacheFor(session);
  const inFlightRequests = inFlightRequestsFor(session);

  const [state, setState] = useState<{
    key: string | null;
    traceState: AgentTraceState;
  }>(() => {
    if (!key) return { key: null, traceState: { status: "idle" } };
    const cached = traceCache.get(key);
    if (cached) {
      return { key, traceState: { status: "loaded", trace: cached } };
    }
    return { key, traceState: { status: "loading" } };
  });

  let activeState = state.traceState;
  if (state.key !== key) {
    const cached = key ? traceCache.get(key) : undefined;
    const nextState: AgentTraceState = !key
      ? { status: "idle" }
      : cached
        ? { status: "loaded", trace: cached }
        : { status: "loading" };
    setState({ key, traceState: nextState });
    activeState = nextState;
  }

  useEffect(() => {
    if (!key || !sessionId) return;

    let cancelled = false;

    const handleUpdate = (nextState: AgentTraceState) => {
      if (cancelled) return;
      setState((prev) =>
        prev.key === key ? { key, traceState: nextState } : prev,
      );
    };

    // The cache may have been filled by another consumer between this
    // component's render (which saw a miss) and this effect. Deliver the
    // cached value through the same update path instead of skipping out,
    // or that render's "loading" state would never resolve.
    const cachedNow = traceCache.get(key);
    if (cachedNow) {
      handleUpdate({ status: "loaded", trace: cachedNow });
      return;
    }

    let inFlight = inFlightRequests.get(key);
    if (!inFlight) {
      const controller = new AbortController();
      const subscribers = new Set<(nextState: AgentTraceState) => void>([
        handleUpdate,
      ]);

      const url = makeAgentTraceUrl(sessionId, trace);

      session
        .fetch(url, { signal: controller.signal })
        .then(async (response) => {
          const json = await response.json();
          const result = parseReviewAgentTraceResponse(json);
          if (!response.ok || !result.ok) {
            throw new Error(result.ok ? "Unable to load trace." : result.error);
          }
          traceCache.set(key, result);
          const currentSubscribers = Array.from(subscribers);
          for (const sub of currentSubscribers) {
            sub({ status: "loaded", trace: result });
          }
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return;
          const message =
            error instanceof Error ? error.message : String(error);
          const currentSubscribers = Array.from(subscribers);
          for (const sub of currentSubscribers) {
            sub({ status: "error", error: message });
          }
        })
        .finally(() => {
          inFlightRequests.delete(key);
        });

      inFlight = { controller, subscribers };
      inFlightRequests.set(key, inFlight);
    } else {
      inFlight.subscribers.add(handleUpdate);
    }

    return () => {
      cancelled = true;
      const entry = inFlightRequests.get(key);
      if (entry) {
        entry.subscribers.delete(handleUpdate);
        if (entry.subscribers.size === 0) {
          entry.controller.abort();
          inFlightRequests.delete(key);
        }
      }
    };
  }, [inFlightRequests, key, session, sessionId, trace, traceCache]);

  return activeState;
}
