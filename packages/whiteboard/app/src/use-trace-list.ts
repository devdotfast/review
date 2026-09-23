import {
  type WhiteboardAgentTraceSession,
  parseWhiteboardAgentTraceListResponse,
} from "@dev.fast/whiteboard-protocol";
import { useEffect, useState } from "react";

import { useWhiteboardSession } from "./host/whiteboard-session";
import type { AgentTraceStorage } from "./use-agent-trace";

export type TraceListState =
  | { status: "loading" }
  | { status: "error"; error: string }
  | {
      status: "loaded";
      configured: boolean;
      storage: AgentTraceStorage | null;
      sources: AgentTraceStorage[];
      storageError: string | null;
      sessions: WhiteboardAgentTraceSession[];
    };

export function useTraceList(
  storageOverride: AgentTraceStorage | null = null,
  provided?: TraceListState,
): TraceListState {
  const session = useWhiteboardSession();
  const whiteboardFetch = session.fetch;

  const [storedList, setStoredList] = useState<TraceListState>({
    status: "loading",
  });

  useEffect(() => {
    if (provided && !storageOverride) return;
    const controller = new AbortController();

    const url: `/${string}` = storageOverride
      ? `/agent-traces?storage=${storageOverride}`
      : "/agent-traces";

    whiteboardFetch(url, { signal: controller.signal })
      .then(async (response) => {
        const result = parseWhiteboardAgentTraceListResponse(
          await response.json(),
        );

        if (!response.ok || !result.ok) {
          throw new Error(
            result.ok ? "Unable to load agent traces." : result.error,
          );
        }

        if (controller.signal.aborted) return;
        setStoredList({
          status: "loaded",
          configured: result.configured !== false,
          storage:
            result.storage === "s3" || result.storage === "hosted"
              ? result.storage
              : null,
          sources: result.sources ?? [],
          storageError: result.storageError ?? null,
          sessions: result.sessions,
        });
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setStoredList({
          status: "error",
          error: cause instanceof Error ? cause.message : String(cause),
        });
      });

    return () => controller.abort();
  }, [whiteboardFetch, storageOverride, session.review, provided]);

  return provided && !storageOverride ? provided : storedList;
}
