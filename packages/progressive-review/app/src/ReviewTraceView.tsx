import {
  type ReviewAgentTraceSession,
  parseReviewAgentTraceListResponse,
} from "@dev.fast/review-protocol";
import { useEffect, useMemo, useRef, useState } from "react";

import { useReviewSession } from "./host/review-session";
import { ChevronIcon, TraceDocument, formatDuration } from "./trace-document";
import { TraceRuler } from "./trace-ruler";
import {
  type LoadedAgentTrace,
  makeTraceKey,
  useAgentTrace,
} from "./use-agent-trace";

export {
  TraceDocument,
  TraceTurn,
  TraceToolGroup,
  TraceToolRow,
  TraceEvent,
  ElidedMessage,
  TraceGapChip,
  ChevronIcon,
  toolIcon,
  toolGroupLabel,
  timeLabel,
  formatDuration,
  applyLensPicks,
  buildLensDisplay,
  elideByKeep,
  extractEventText,
  buildIndexedTraceTurns,
  buildTraceTurns,
  groupIndexedWorkEvents,
  type TraceTurnEvent,
  type TraceTurnGroup,
  type IndexedTraceTurnEvent,
  type IndexedTraceTurnGroup,
  type IndexedTraceToolItem,
  type LensPick,
  type LensPickEvent,
  type LensPickRange,
  type LensDisplayItem,
  type ElidedSegment,
  type TraceDocumentProps,
  type TraceDocumentOptions,
} from "./trace-document";
/**
 * The Trace tab shows the raw agent traces behind a review, resolved from
 * `Agent-Session:` commit trailers and fetched from the shared R2 trace store.
 */

type TraceListState =
  | { status: "loading" }
  | { status: "error"; error: string }
  | {
      status: "loaded";
      configured: boolean;
      sessions: ReviewAgentTraceSession[];
    };

export interface TraceSelection {
  sessionId: string;
  trace?: string;
  eventIndex?: number;
}

export function ReviewTraceView({
  initialSelection,
}: {
  initialSelection?: TraceSelection;
}) {
  const session = useReviewSession();
  const reviewFetch = session.fetch;
  const [list, setList] = useState<TraceListState>({ status: "loading" });
  const [selectedKey, setSelectedKey] = useState<string | null>(() =>
    initialSelection
      ? makeTraceKey(initialSelection.sessionId, initialSelection.trace)
      : null,
  );
  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!pickerOpen) return;
    const handleOutsideClick = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setPickerOpen(false);
      }
    };
    document.addEventListener("mousedown", handleOutsideClick);
    return () => document.removeEventListener("mousedown", handleOutsideClick);
  }, [pickerOpen]);

  useEffect(() => {
    if (initialSelection) {
      setSelectedKey(
        makeTraceKey(initialSelection.sessionId, initialSelection.trace),
      );
    }
  }, [initialSelection]);

  useEffect(() => {
    const controller = new AbortController();
    reviewFetch("/agent-traces", { signal: controller.signal })
      .then(async (response) => {
        const result = parseReviewAgentTraceListResponse(await response.json());
        if (!response.ok || !result.ok) {
          throw new Error(
            result.ok ? "Unable to load agent traces." : result.error,
          );
        }
        if (controller.signal.aborted) return;
        setList({
          status: "loaded",
          configured: result.configured !== false,
          sessions: result.sessions,
        });
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setList({
          status: "error",
          error: cause instanceof Error ? cause.message : String(cause),
        });
      });
    return () => controller.abort();
  }, [reviewFetch]);

  const sessions = list.status === "loaded" ? list.sessions : [];

  // Build flat trace targets (main trace + each subagent)
  const targets = useMemo(() => {
    const result: Array<{
      key: string;
      sessionId: string;
      trace?: string;
      title: string;
      harness: ReviewAgentTraceSession["harness"];
      isSubagent?: boolean;
      available: boolean;
      notSynced?: boolean;
      commits: ReviewAgentTraceSession["commits"];
    }> = [];

    for (const s of sessions) {
      const title = s.commits[0]?.subject || "Agent session";
      result.push({
        key: s.sessionId,
        sessionId: s.sessionId,
        title,
        harness: s.harness,
        available: s.available,
        notSynced: s.notSynced,
        commits: s.commits,
      });
      for (const sub of s.subagents ?? []) {
        const key = `${s.sessionId}:${sub}`;
        result.push({
          key,
          sessionId: s.sessionId,
          trace: sub,
          title: sub,
          harness: s.harness,
          isSubagent: true,
          available: s.available,
          commits: s.commits,
        });
      }
    }
    return result;
  }, [sessions]);

  const activeTarget = useMemo(
    () =>
      targets.find((t) => t.key === selectedKey) ??
      targets.find((t) => t.available) ??
      targets[0] ??
      null,
    [targets, selectedKey],
  );

  const activeKey = activeTarget?.key ?? null;

  const detail = useAgentTrace(activeTarget?.sessionId, activeTarget?.trace);

  const activeTrace = detail.status === "loaded" ? detail.trace : undefined;
  const activeHarness =
    activeTrace?.session.harness ?? activeTarget?.harness ?? "unknown";
  const activeTitle = activeTrace?.title ?? activeTarget?.title ?? "";

  return (
    <div className="review-trace-view">
      {detail.status === "loaded" && (
        <TraceRuler events={detail.trace.events} />
      )}
      <div className="review-trace-column">
        {list.status === "loading" && (
          <p className="review-trace-note">Resolving agent sessions…</p>
        )}
        {list.status === "error" && (
          <p className="review-trace-note review-trace-note--error">
            {list.error}
          </p>
        )}
        {list.status === "loaded" && !list.configured && (
          <div className="review-trace-unconfigured">
            <span className="review-trace-kicker">Agent trace</span>
            <p>Agent traces are not configured.</p>
            <p className="review-trace-note">
              Open Agent Setup in Review Desktop to enable trace capture.
            </p>
          </div>
        )}
        {list.status === "loaded" &&
          list.configured &&
          sessions.length === 0 && (
            <div className="review-trace-empty">
              <span className="review-trace-kicker">Agent trace</span>
              <p>No agent sessions are recorded for this change range.</p>
              <p className="review-trace-note">
                Sessions attach automatically through{" "}
                <code>Agent-Session:</code> commit trailers when an agent
                commits with repository hooks installed.
              </p>
            </div>
          )}
        {targets.length > 1 && activeTarget && (
          <div className="review-trace-picker" ref={pickerRef}>
            <button
              type="button"
              className="review-trace-picker-trigger"
              aria-haspopup="listbox"
              aria-expanded={pickerOpen}
              onClick={() => setPickerOpen((open) => !open)}
            >
              <span className="review-trace-picker-harness">
                {harnessTag(activeHarness, activeTarget.isSubagent)}
              </span>
              <span className="review-trace-picker-title">{activeTitle}</span>
              <span className="review-trace-picker-chevron">
                <ChevronIcon />
              </span>
            </button>
            {pickerOpen && (
              <div className="review-trace-picker-menu" role="listbox">
                {targets.map((target) => {
                  const isActive = target.key === activeKey;
                  const targetHarness = target.harness;
                  const itemTitle = target.title;
                  return (
                    <button
                      key={target.key}
                      type="button"
                      role="option"
                      aria-selected={isActive}
                      className={
                        isActive
                          ? "review-trace-picker-item review-trace-picker-item--active"
                          : target.isSubagent
                            ? "review-trace-picker-item review-trace-picker-item--subagent"
                            : "review-trace-picker-item"
                      }
                      disabled={!target.available}
                      onClick={() => {
                        setSelectedKey(target.key);
                        setPickerOpen(false);
                      }}
                    >
                      <div className="review-trace-picker-item-left">
                        <span className="review-trace-picker-item-harness">
                          {harnessTag(targetHarness, target.isSubagent)}
                        </span>
                        <span className="review-trace-picker-item-title">
                          {itemTitle}
                        </span>
                      </div>
                      {target.notSynced ? (
                        <span className="review-trace-picker-item-badge">
                          not synced
                        </span>
                      ) : isActive ? (
                        <span className="review-trace-picker-item-check">
                          ✓
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}
        {detail.status === "loading" && (
          <p className="review-trace-note">Loading trace…</p>
        )}
        {detail.status === "error" && (
          <p className="review-trace-note review-trace-note--error">
            {detail.error}
          </p>
        )}
        {detail.status === "loaded" && (
          <ReviewTraceDocument
            trace={detail.trace}
            session={
              sessions.find(
                (s) => s.sessionId === detail.trace.session.sessionId,
              ) ?? detail.trace.session
            }
            targetEventIndex={
              initialSelection &&
              makeTraceKey(
                initialSelection.sessionId,
                initialSelection.trace,
              ) === activeKey
                ? initialSelection.eventIndex
                : undefined
            }
          />
        )}
      </div>
    </div>
  );
}

function harnessLabel(harness: ReviewAgentTraceSession["harness"]): string {
  if (harness === "claude-code") return "claude";
  if (harness === "codex") return "codex";
  if (harness === "pi") return "pi";
  return "agent";
}

function harnessTag(
  harness: ReviewAgentTraceSession["harness"],
  isSubagent?: boolean,
): string {
  if (isSubagent) {
    if (harness === "pi") return "PI SUB";
    if (harness === "claude-code") return "CLAUDE SUB";
    if (harness === "codex") return "CODEX SUB";
    return "SUBAGENT";
  }
  if (harness === "pi") return "PI";
  if (harness === "claude-code") return "CLAUDE";
  if (harness === "codex") return "CODEX";
  return "AGENT";
}

export function ReviewTraceDocument({
  trace,
  session,
  targetEventIndex,
  highlightQuote,
}: {
  trace: LoadedAgentTrace;
  session: ReviewAgentTraceSession;
  targetEventIndex?: number;
  highlightQuote?: string;
}) {
  const duration =
    trace.activeMs !== null
      ? formatDuration(trace.activeMs)
      : trace.startedAt && trace.endedAt
        ? formatDuration(
            Date.parse(trace.endedAt) - Date.parse(trace.startedAt),
          )
        : null;
  return (
    <>
      <header className="review-trace-header">
        <span className="review-trace-kicker">Agent trace</span>
        <h2 className="review-trace-title">
          {trace.title ??
            firstCommitSubject(session) ??
            (trace.trace ? `Subagent: ${trace.trace}` : "Agent session")}
        </h2>
        <div className="review-trace-meta">
          <span>{harnessLabel(trace.session.harness)}</span>
          <span className="review-trace-meta-sep">·</span>
          <span>{trace.session.sessionId.slice(0, 8)}</span>
          {trace.trace && (
            <>
              <span className="review-trace-meta-sep">·</span>
              <span>{trace.trace}</span>
            </>
          )}
          <span className="review-trace-meta-sep">·</span>
          <span>
            {trace.userTurns} {trace.userTurns === 1 ? "turn" : "turns"}
          </span>
          <span className="review-trace-meta-sep">·</span>
          <span>{trace.toolCalls} tool calls</span>
          {duration && (
            <>
              <span className="review-trace-meta-sep">·</span>
              <span>worked {duration}</span>
            </>
          )}
        </div>
      </header>
      <TraceDocument
        events={trace.events}
        targetEventIndex={targetEventIndex}
        highlightQuote={highlightQuote}
      />
    </>
  );
}

function firstCommitSubject(session: ReviewAgentTraceSession): string | null {
  return session.commits[0]?.subject ?? null;
}
