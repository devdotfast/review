import type { ReviewAgentTraceEvent } from "@dev.fast/review-protocol";
import { type ReactNode, useEffect, useMemo, useState } from "react";

import { AgentMarkdown } from "./agent-markdown";
import {
  HighlightedText,
  findWhitespaceNormalizedSpan,
} from "./highlighted-text";

export type TraceTurnEvent = Exclude<
  ReviewAgentTraceEvent,
  { kind: "separator" }
>;

export interface TraceTurnGroup {
  user: Extract<TraceTurnEvent, { kind: "user" }> | null;
  work: TraceTurnEvent[];
  final: TraceTurnEvent[];
  workedMs: number | null;
}

const TURN_ACTIVE_GAP_LIMIT_MS = 10 * 60 * 1000;

export interface IndexedTraceTurnEvent {
  event: TraceTurnEvent;
  index: number;
}

export interface IndexedTraceTurnGroup {
  user: IndexedTraceTurnEvent | null;
  work: IndexedTraceTurnEvent[];
  final: IndexedTraceTurnEvent[];
  workedMs: number | null;
}

export function buildIndexedTraceTurns(
  events: ReviewAgentTraceEvent[],
): IndexedTraceTurnGroup[] {
  const turns: IndexedTraceTurnGroup[] = [];
  let current: {
    user: IndexedTraceTurnEvent | null;
    items: IndexedTraceTurnEvent[];
  } | null = null;

  const finish = () => {
    if (!current) return;
    let splitIndex = current.items.length;
    while (
      splitIndex > 0 &&
      current.items[splitIndex - 1].event.kind === "assistant" &&
      !(
        current.items[splitIndex - 1].event as Extract<
          TraceTurnEvent,
          { kind: "assistant" }
        >
      ).thinking
    ) {
      splitIndex -= 1;
    }
    const allItems = current.user
      ? [current.user.event, ...current.items.map((i) => i.event)]
      : current.items.map((i) => i.event);
    turns.push({
      user: current.user,
      work: current.items.slice(0, splitIndex),
      final: current.items.slice(splitIndex),
      workedMs: activeSpanMs(allItems),
    });
    current = null;
  };

  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    if (event.kind === "separator") continue;
    if (event.kind === "user") {
      finish();
      current = { user: { event, index: i }, items: [] };
      continue;
    }
    current ??= { user: null, items: [] };
    current.items.push({ event, index: i });
  }
  finish();
  return turns;
}

export function buildTraceTurns(
  events: ReviewAgentTraceEvent[],
): TraceTurnGroup[] {
  return buildIndexedTraceTurns(events).map((t) => ({
    user: t.user
      ? (t.user.event as Extract<TraceTurnEvent, { kind: "user" }>)
      : null,
    work: t.work.map((w) => w.event),
    final: t.final.map((f) => f.event),
    workedMs: t.workedMs,
  }));
}

function activeSpanMs(events: TraceTurnEvent[]): number | null {
  let total = 0;
  let previous: number | null = null;
  let sawTimestamp = false;
  for (const event of events) {
    if (!event.at) continue;
    const at = Date.parse(event.at);
    if (!Number.isFinite(at)) continue;
    sawTimestamp = true;
    if (previous !== null && at > previous) {
      total += Math.min(at - previous, TURN_ACTIVE_GAP_LIMIT_MS);
    }
    previous = at;
  }
  return sawTimestamp ? total : null;
}

export type IndexedTraceToolItem = {
  event: Extract<ReviewAgentTraceEvent, { kind: "tool" }>;
  index: number;
};

export function groupIndexedWorkEvents(
  work: IndexedTraceTurnEvent[],
): Array<IndexedTraceTurnEvent | IndexedTraceToolItem[]> {
  const items: Array<IndexedTraceTurnEvent | IndexedTraceToolItem[]> = [];
  let run: IndexedTraceToolItem[] = [];
  const flush = () => {
    if (run.length === 0) return;
    if (run.length === 1) items.push(run[0]);
    else items.push(run);
    run = [];
  };
  for (const item of work) {
    if (item.event.kind === "tool") {
      run.push(item as IndexedTraceToolItem);
      continue;
    }
    flush();
    items.push(item);
  }
  flush();
  return items;
}

export function toolGroupLabel(
  events: Array<Extract<ReviewAgentTraceEvent, { kind: "tool" }>>,
): string {
  const categories = new Map<string, number>();
  for (const event of events) {
    const verb = event.verb;
    const key =
      verb === "Edited" || verb === "Wrote" || verb === "Added"
        ? "edited"
        : verb === "Deleted"
          ? "deleted"
          : verb === "Ran"
            ? "ran"
            : verb === "Read"
              ? "read"
              : verb === "Ran agent"
                ? "agents"
                : verb.startsWith("Searched")
                  ? "searched"
                  : "called";
    categories.set(key, (categories.get(key) ?? 0) + 1);
  }
  const phrase = (key: string, count: number): string => {
    const plural = count !== 1;
    if (key === "edited") return `edited ${count} ${plural ? "files" : "file"}`;
    if (key === "deleted")
      return `deleted ${count} ${plural ? "files" : "file"}`;
    if (key === "ran") return `ran ${count} ${plural ? "commands" : "command"}`;
    if (key === "read") return `read ${count} ${plural ? "files" : "file"}`;
    if (key === "agents") return `ran ${count} ${plural ? "agents" : "agent"}`;
    if (key === "searched")
      return `searched ${count} ${plural ? "times" : "time"}`;
    return `called ${count} ${plural ? "tools" : "tool"}`;
  };
  const parts = [...categories.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([key, count]) => phrase(key, count));
  const label = parts.join(", ");
  return label.charAt(0).toUpperCase() + label.slice(1);
}

export function TraceToolGroup({
  items,
  targetEventIndex,
  highlightQuote,
}: {
  items: IndexedTraceToolItem[];
  targetEventIndex?: number;
  highlightQuote?: string;
}) {
  const hasTarget =
    targetEventIndex !== undefined &&
    items.some((item) => item.index === targetEventIndex);
  const events = items.map((i) => i.event);
  return (
    <details
      className="review-trace-toolgroup"
      open={hasTarget}
      data-trace-event={items[0]?.index}
    >
      <summary>
        <span className="review-trace-tool-icon">
          {iconSvg(
            <>
              <rect
                x="2"
                y="3"
                width="10"
                height="2.2"
                rx="1.1"
                fill="currentColor"
              />
              <rect
                x="2"
                y="6.9"
                width="10"
                height="2.2"
                rx="1.1"
                fill="currentColor"
                opacity="0.6"
              />
              <rect
                x="2"
                y="10.8"
                width="10"
                height="2.2"
                rx="1.1"
                fill="currentColor"
                opacity="0.35"
              />
            </>,
          )}
        </span>
        <span className="review-trace-toolgroup-label">
          {toolGroupLabel(events)}
        </span>
        <span className="review-trace-toolgroup-count">
          {events.length} steps
        </span>
        <span className="review-trace-toolgroup-chevron" aria-hidden="true">
          <ChevronIcon />
        </span>
      </summary>
      <div className="review-trace-toolgroup-body">
        {items.map((item) => (
          <div
            key={item.index}
            id={
              item.index === targetEventIndex
                ? "review-trace-target-event"
                : undefined
            }
            className={
              item.index === targetEventIndex
                ? "review-trace-target-turn"
                : undefined
            }
          >
            <TraceEvent event={item.event} highlightQuote={highlightQuote} />
          </div>
        ))}
      </div>
    </details>
  );
}

export function TraceEvent({
  event,
  highlightQuote,
}: {
  event: TraceTurnEvent;
  highlightQuote?: string;
}) {
  if (event.kind === "user") {
    return (
      <div className="review-trace-user">
        <div className="review-trace-user-bubble">
          {highlightQuote ? (
            <HighlightedText text={event.text} quote={highlightQuote} />
          ) : (
            event.text
          )}
        </div>
        {event.at && (
          <span className="review-trace-timestamp">{timeLabel(event.at)}</span>
        )}
      </div>
    );
  }
  if (event.kind === "assistant") {
    if (event.thinking) {
      return (
        <details
          className="review-trace-tool review-trace-tool--expandable"
          open={Boolean(highlightQuote)}
        >
          <summary>
            <span className="review-trace-tool-row">
              <span className="review-trace-tool-icon">
                {toolIcon("Thinking")}
              </span>
              <span className="review-trace-tool-label">
                <span className="review-trace-tool-verb">Thinking</span>
              </span>
              <span className="review-trace-tool-chevron" aria-hidden="true">
                <ChevronIcon />
              </span>
            </span>
          </summary>
          <figure className="review-trace-figure">
            <figcaption className="review-trace-figure-head">
              <span>Thinking</span>
            </figcaption>
            <div className="review-trace-figure-body review-trace-figure-body--thinking">
              <AgentMarkdown
                source={event.markdown}
                highlightQuote={highlightQuote}
              />
            </div>
          </figure>
        </details>
      );
    }
    return (
      <div className="review-trace-prose">
        <AgentMarkdown
          source={event.markdown}
          highlightQuote={highlightQuote}
        />
      </div>
    );
  }
  return <TraceToolRow event={event} />;
}

export { HighlightedText } from "./highlighted-text";

export function TraceToolRow({
  event,
}: {
  event: Extract<ReviewAgentTraceEvent, { kind: "tool" }>;
}) {
  const expandable = Boolean(event.command || event.input || event.output);
  const row = (
    <span className="review-trace-tool-row">
      <span className="review-trace-tool-icon">{toolIcon(event.verb)}</span>
      <span className="review-trace-tool-label">
        <span className="review-trace-tool-verb">{event.verb}</span>
        <span
          className={
            event.filePath
              ? "review-trace-tool-title review-trace-tool-title--file"
              : "review-trace-tool-title"
          }
        >
          {event.filePath ? <bdi>{event.title}</bdi> : event.title}
        </span>
        {event.additions !== undefined && event.additions > 0 && (
          <span className="review-trace-added">+{event.additions}</span>
        )}
        {event.deletions !== undefined && event.deletions > 0 && (
          <span className="review-trace-removed">−{event.deletions}</span>
        )}
        {event.error && <span className="review-trace-error-flag">failed</span>}
      </span>
      {expandable && (
        <span className="review-trace-tool-chevron" aria-hidden="true">
          <ChevronIcon />
        </span>
      )}
    </span>
  );
  if (!expandable) {
    return <div className="review-trace-tool">{row}</div>;
  }
  return (
    <details className="review-trace-tool review-trace-tool--expandable">
      <summary>{row}</summary>
      <figure className="review-trace-figure">
        <figcaption className="review-trace-figure-head">
          <span>{event.command ? "Shell" : event.tool}</span>
        </figcaption>
        <pre className="review-trace-figure-body">
          {event.command && (
            <code className="review-trace-figure-command">{event.command}</code>
          )}
          {!event.command && event.input && (
            <code className="review-trace-figure-command">{event.input}</code>
          )}
          {event.output && (
            <code className="review-trace-figure-output">{event.output}</code>
          )}
        </pre>
      </figure>
    </details>
  );
}

export function timeLabel(at: string): string {
  const value = new Date(at);
  if (Number.isNaN(value.getTime())) return "";
  return value.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

export function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) return "";
  const totalSeconds = Math.round(durationMs / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

function iconSvg(children: ReactNode): ReactNode {
  return (
    <svg viewBox="0 0 16 16" className="review-trace-icon" aria-hidden="true">
      {children}
    </svg>
  );
}

export function toolIcon(verb: string): ReactNode {
  switch (verb) {
    case "Thinking":
      return iconSvg(
        <path d="M8 2a5 5 0 0 0-3.5 8.5V12a1 1 0 0 0 1 1h5a1 1 0 0 0 1-1v-1.5A5 5 0 0 0 8 2zM6 15h4" />,
      );
    case "Ran":
      return iconSvg(
        <>
          <rect x="1.5" y="2.5" width="13" height="11" rx="2" />
          <path d="M4.5 6l2 2-2 2M8.5 10.5h3" />
        </>,
      );
    case "Edited":
    case "Wrote":
      return iconSvg(
        <path d="M11.1 2.2a1.6 1.6 0 0 1 2.3 2.3L5 12.9l-3 .7.7-3z" />,
      );
    case "Read":
      return iconSvg(
        <>
          <path d="M9.5 1.5h-5a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V4.5z" />
          <path d="M9.5 1.5v3h3" />
        </>,
      );
    case "Searched":
    case "Searched web":
    case "Fetched":
      return iconSvg(
        <>
          <circle cx="7" cy="7" r="4.5" />
          <path d="M10.5 10.5L14 14" />
        </>,
      );
    case "Ran agent":
      return iconSvg(
        <path d="M8 1.5l1.8 4.2 4.2 1.8-4.2 1.8L8 13.5 6.2 9.3 2 7.5l4.2-1.8z" />,
      );
    default:
      return iconSvg(
        <>
          <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h7" />
        </>,
      );
  }
}

export function ChevronIcon() {
  return iconSvg(<path d="M4 6l4 4 4-4" />);
}

export interface LensPickEvent {
  event: number;
  keep?: string[] | null;
}

export interface LensPickRange {
  events: [number, number];
}

export type LensPick = LensPickEvent | LensPickRange;

export type LensDisplayItem =
  | { type: "event"; index: number; keep: string[] | null }
  | { type: "gap"; from: number; count: number };

export function applyLensPicks(
  eventCount: number,
  lens: { picks: LensPick[] },
): Map<number, string[] | null> {
  const included = new Map<number, string[] | null>();
  for (const pick of lens.picks) {
    if ("events" in pick) {
      const [from, to] = pick.events;
      for (
        let index = Math.max(0, from);
        index <= Math.min(eventCount - 1, to);
        index += 1
      ) {
        included.set(index, null);
      }
    } else if (pick.event >= 0 && pick.event < eventCount) {
      const existing = included.get(pick.event);
      if (existing === null) continue;
      included.set(
        pick.event,
        pick.keep && pick.keep.length > 0 ? pick.keep : null,
      );
    }
  }
  return included;
}

export function buildLensDisplay(
  eventCount: number,
  included: Map<number, string[] | null>,
): LensDisplayItem[] {
  const items: LensDisplayItem[] = [];
  let cursor = 0;
  while (cursor < eventCount) {
    if (included.has(cursor)) {
      items.push({
        type: "event",
        index: cursor,
        keep: included.get(cursor) ?? null,
      });
      cursor += 1;
      continue;
    }
    let end = cursor;
    while (end < eventCount && !included.has(end)) end += 1;
    items.push({ type: "gap", from: cursor, count: end - cursor });
    cursor = end;
  }
  return items;
}

export interface ElidedSegment {
  kind: "kept" | "chip";
  text?: string;
}

export function elideByKeep(
  text: string,
  keep: string[],
): ElidedSegment[] | null {
  const segments: ElidedSegment[] = [];
  let cursor = 0;
  let matched = 0;
  for (const snippet of keep) {
    const span = findWhitespaceNormalizedSpan(text.slice(cursor), snippet);
    if (!span) continue;
    matched += 1;
    const start = cursor + span.start;
    const end = cursor + span.end;
    if (start > cursor) segments.push({ kind: "chip" });
    segments.push({ kind: "kept", text: text.slice(start, end) });
    cursor = end;
  }
  if (matched === 0) return null;
  if (cursor < text.trimEnd().length) segments.push({ kind: "chip" });
  return segments;
}

export function extractEventText(
  event: ReviewAgentTraceEvent | undefined,
): string {
  if (!event) return "";
  if (event.kind === "user") return event.text;
  if (event.kind === "assistant") return event.markdown;
  if (event.kind === "tool") {
    return [event.title, event.command, event.input, event.output]
      .filter(Boolean)
      .join(" ");
  }
  if (event.kind === "separator") return event.label;
  return "";
}

export function ElidedMessage({
  event,
  keep,
  quote,
  onExpand,
}: {
  event: Extract<ReviewAgentTraceEvent, { kind: "user" | "assistant" }>;
  keep: string[];
  quote?: string;
  onExpand: () => void;
}) {
  const text = event.kind === "user" ? event.text : event.markdown;
  const segments = elideByKeep(text, keep);
  if (!segments) return <TraceEvent event={event} highlightQuote={quote} />;
  const body = (
    <span className="review-trace-lens-elided">
      {segments.map((segment, index) =>
        segment.kind === "kept" ? (
          <span key={index} className="review-trace-lens-kept">
            <mark className="review-trace-quote-mark">{segment.text}</mark>
          </span>
        ) : (
          <button
            key={index}
            type="button"
            className="review-trace-lens-chip"
            title="Show the hidden text"
            onClick={onExpand}
          >
            ⋯
          </button>
        ),
      )}
    </span>
  );
  if (event.kind === "user") {
    return (
      <div className="review-trace-user">
        <div className="review-trace-user-bubble review-trace-user-bubble--elided">
          {body}
        </div>
        {event.at && (
          <span className="review-trace-timestamp">{timeLabel(event.at)}</span>
        )}
      </div>
    );
  }
  if (event.thinking) {
    return (
      <details className="review-trace-tool review-trace-tool--expandable" open>
        <summary>
          <span className="review-trace-tool-row">
            <span className="review-trace-tool-icon">
              {toolIcon("Thinking")}
            </span>
            <span className="review-trace-tool-label">
              <span className="review-trace-tool-verb">Thinking</span>
            </span>
            <span className="review-trace-tool-chevron" aria-hidden="true">
              <ChevronIcon />
            </span>
          </span>
        </summary>
        <figure className="review-trace-figure">
          <figcaption className="review-trace-figure-head">
            <span>Thinking</span>
          </figcaption>
          <div className="review-trace-figure-body review-trace-figure-body--thinking">
            <div className="review-trace-prose review-trace-prose--elided">
              {body}
            </div>
          </div>
        </figure>
      </details>
    );
  }
  return (
    <div className="review-trace-prose review-trace-prose--elided">{body}</div>
  );
}

export function TraceGapChip({
  from,
  count,
  onExpand,
}: {
  from: number;
  count: number;
  onExpand: () => void;
}) {
  return (
    <button
      key={`gap-${from}`}
      type="button"
      className="review-trace-lens-gap"
      onClick={onExpand}
    >
      <span className="review-trace-lens-gap-line" />
      <span className="review-trace-lens-gap-chip">
        ⋯ {count} hidden {count === 1 ? "event" : "events"}
      </span>
      <span className="review-trace-lens-gap-line" />
    </button>
  );
}

export interface TraceCollapseSpan {
  from: number;
  count: number;
}

export function TraceCollapseRow({
  span,
  edge,
  onCollapse,
}: {
  span: TraceCollapseSpan;
  edge: "top" | "bottom";
  onCollapse: () => void;
}) {
  return (
    <button
      type="button"
      className="review-trace-lens-collapse"
      onClick={onCollapse}
    >
      <span className="review-trace-lens-collapse-line" />
      <span className="review-trace-lens-collapse-chip">
        <svg
          viewBox="0 0 16 16"
          className="review-trace-lens-collapse-chevron"
          aria-hidden="true"
        >
          {edge === "top" ? (
            <polyline points="4 6 8 10 12 6" />
          ) : (
            <polyline points="4 10 8 6 12 10" />
          )}
        </svg>
        collapse {span.count} {span.count === 1 ? "event" : "events"}
      </span>
      <span className="review-trace-lens-collapse-line" />
    </button>
  );
}

export function TraceTurn({
  turn,
  effectiveIncluded,
  expandedEvents,
  collapseStarts,
  collapseEnds,
  onExpandGap,
  onExpandEvent,
  onCollapseGap,
  targetEventIndex,
  highlightQuote,
  turnCoalesce,
}: {
  turn: IndexedTraceTurnGroup;
  effectiveIncluded: Map<number, string[] | null> | null;
  expandedEvents: ReadonlySet<number>;
  collapseStarts?: ReadonlyMap<number, TraceCollapseSpan> | null;
  collapseEnds?: ReadonlyMap<number, TraceCollapseSpan> | null;
  onExpandGap: (from: number, count: number) => void;
  onExpandEvent: (index: number) => void;
  onCollapseGap?: (from: number) => void;
  targetEventIndex?: number;
  highlightQuote?: string;
  turnCoalesce: boolean;
}) {
  const steps = turn.work.length;
  const isTargetInWork =
    targetEventIndex !== undefined &&
    turn.work.some((w) => w.index === targetEventIndex);
  const isTargetTurn =
    targetEventIndex !== undefined &&
    (turn.user?.index === targetEventIndex ||
      isTargetInWork ||
      turn.final.some((f) => f.index === targetEventIndex));

  const workedLabel =
    turn.workedMs !== null && turn.workedMs >= 1000
      ? `Worked for ${formatDuration(turn.workedMs)}`
      : `Worked · ${steps} ${steps === 1 ? "step" : "steps"}`;

  const renderTurnEvent = (item: IndexedTraceTurnEvent) => {
    const isTarget = item.index === targetEventIndex;
    const quote = isTarget || isTargetTurn ? highlightQuote : undefined;
    const keep = effectiveIncluded?.get(item.index);
    const shouldElide =
      keep !== undefined &&
      keep !== null &&
      keep.length > 0 &&
      (item.event.kind === "user" || item.event.kind === "assistant") &&
      !expandedEvents.has(item.index);

    return (
      <div
        key={item.index}
        id={isTarget ? "review-trace-target-event" : undefined}
        className={isTarget ? "review-trace-target-turn" : undefined}
        data-trace-event={item.index}
      >
        {shouldElide ? (
          <ElidedMessage
            event={
              item.event as Extract<
                TraceTurnEvent,
                { kind: "user" | "assistant" }
              >
            }
            keep={keep}
            quote={quote}
            onExpand={() => onExpandEvent(item.index)}
          />
        ) : (
          <TraceEvent event={item.event} highlightQuote={quote} />
        )}
      </div>
    );
  };

  // Rows that bracket an expanded elision so the reader can fold it back.
  const collapseRowFor = (index: number, edge: "top" | "bottom"): ReactNode => {
    const span =
      edge === "top" ? collapseStarts?.get(index) : collapseEnds?.get(index);
    if (!span || !onCollapseGap) return null;
    return (
      <TraceCollapseRow
        key={`collapse-${edge}-${span.from}`}
        span={span}
        edge={edge}
        onCollapse={() => onCollapseGap(span.from)}
      />
    );
  };

  const renderWorkItems = () => {
    if (effectiveIncluded === null) {
      if (turnCoalesce) {
        return groupIndexedWorkEvents(turn.work).map((item, index) =>
          Array.isArray(item) ? (
            <TraceToolGroup
              key={index}
              items={item}
              targetEventIndex={targetEventIndex}
              highlightQuote={highlightQuote}
            />
          ) : (
            renderTurnEvent(item)
          ),
        );
      }
      return turn.work.map((item) => renderTurnEvent(item));
    }

    const elements: ReactNode[] = [];
    let toolRun: IndexedTraceToolItem[] = [];
    let gapRun: { from: number; count: number } | null = null;

    const flushToolRun = () => {
      if (toolRun.length === 0) return;
      if (turnCoalesce && toolRun.length >= 2) {
        const items = [...toolRun];
        elements.push(
          <TraceToolGroup
            key={`toolgroup-${items[0].index}`}
            items={items}
            targetEventIndex={targetEventIndex}
            highlightQuote={highlightQuote}
          />,
        );
      } else {
        for (const item of toolRun) {
          elements.push(renderTurnEvent(item));
        }
      }
      toolRun = [];
    };

    const flushGapRun = () => {
      if (!gapRun) return;
      const { from, count } = gapRun;
      elements.push(
        <TraceGapChip
          key={`gap-${from}`}
          from={from}
          count={count}
          onExpand={() => onExpandGap(from, count)}
        />,
      );
      gapRun = null;
    };

    for (const item of turn.work) {
      const isIncluded = effectiveIncluded.has(item.index);
      if (!isIncluded) {
        flushToolRun();
        if (!gapRun) {
          gapRun = { from: item.index, count: 1 };
        } else {
          gapRun.count += 1;
        }
        continue;
      }

      flushGapRun();
      const topRow = collapseRowFor(item.index, "top");
      if (topRow) {
        flushToolRun();
        elements.push(topRow);
      }
      if (turnCoalesce && item.event.kind === "tool") {
        toolRun.push(item as IndexedTraceToolItem);
      } else {
        flushToolRun();
        elements.push(renderTurnEvent(item));
      }
      const bottomRow = collapseRowFor(item.index, "bottom");
      if (bottomRow) {
        flushToolRun();
        elements.push(bottomRow);
      }
    }
    flushToolRun();
    flushGapRun();

    return elements;
  };

  const renderFinalItems = () => {
    if (effectiveIncluded === null) {
      return turn.final.map((item) => renderTurnEvent(item));
    }

    const elements: ReactNode[] = [];
    let gapRun: { from: number; count: number } | null = null;

    const flushGapRun = () => {
      if (!gapRun) return;
      const { from, count } = gapRun;
      elements.push(
        <TraceGapChip
          key={`gap-${from}`}
          from={from}
          count={count}
          onExpand={() => onExpandGap(from, count)}
        />,
      );
      gapRun = null;
    };

    for (const item of turn.final) {
      if (!effectiveIncluded.has(item.index)) {
        if (!gapRun) {
          gapRun = { from: item.index, count: 1 };
        } else {
          gapRun.count += 1;
        }
      } else {
        flushGapRun();
        const topRow = collapseRowFor(item.index, "top");
        if (topRow) elements.push(topRow);
        elements.push(renderTurnEvent(item));
        const bottomRow = collapseRowFor(item.index, "bottom");
        if (bottomRow) elements.push(bottomRow);
      }
    }
    flushGapRun();
    return elements;
  };

  let userElement: ReactNode = null;
  if (turn.user) {
    if (effectiveIncluded === null || effectiveIncluded.has(turn.user.index)) {
      const topRow = collapseRowFor(turn.user.index, "top");
      const bottomRow = collapseRowFor(turn.user.index, "bottom");
      userElement =
        topRow || bottomRow ? (
          <div
            key={`user-${turn.user.index}`}
            className="review-trace-user-slot"
          >
            {topRow}
            {renderTurnEvent(turn.user)}
            {bottomRow}
          </div>
        ) : (
          renderTurnEvent(turn.user)
        );
    } else {
      userElement = (
        <TraceGapChip
          key={`gap-${turn.user.index}`}
          from={turn.user.index}
          count={1}
          onExpand={() => onExpandGap(turn.user!.index, 1)}
        />
      );
    }
  }

  let workElement: ReactNode = null;
  if (turn.work.length > 0) {
    const includedWorkCount =
      effectiveIncluded === null
        ? turn.work.length
        : turn.work.filter((w) => effectiveIncluded.has(w.index)).length;

    if (includedWorkCount === 0 && effectiveIncluded !== null) {
      workElement = (
        <TraceGapChip
          key={`gap-${turn.work[0].index}`}
          from={turn.work[0].index}
          count={turn.work.length}
          onExpand={() => onExpandGap(turn.work[0].index, turn.work.length)}
        />
      );
    } else {
      const openWorked =
        isTargetInWork || (effectiveIncluded !== null && includedWorkCount > 0);
      workElement = (
        <details className="review-trace-worked" open={openWorked}>
          <summary>
            <span className="review-trace-worked-label">{workedLabel}</span>
            <span className="review-trace-worked-chevron" aria-hidden="true">
              <ChevronIcon />
            </span>
            <span className="review-trace-worked-line" />
          </summary>
          <div className="review-trace-worked-body">{renderWorkItems()}</div>
        </details>
      );
    }
  }

  return (
    <div className="review-trace-turn">
      {userElement}
      {workElement}
      {renderFinalItems()}
    </div>
  );
}

export interface TraceDocumentOptions {
  picks?: LensPick[] | { picks: LensPick[] } | Map<number, string[] | null>;
  highlightQuote?: string;
  targetEventIndex?: number;
  coalesce?: boolean;
  className?: string;
}

export interface TraceDocumentProps extends TraceDocumentOptions {
  events: ReviewAgentTraceEvent[];
}

export function TraceDocument({
  events,
  picks,
  highlightQuote,
  targetEventIndex,
  coalesce = true,
  className,
}: TraceDocumentProps) {
  useEffect(() => {
    if (targetEventIndex === undefined) return;
    const targetTurn = document.getElementById("review-trace-target-event");
    const quoteMark = targetTurn?.querySelector(".review-trace-quote-mark");
    const el = quoteMark ?? targetTurn;
    if (el && typeof el.scrollIntoView === "function") {
      el.scrollIntoView({ block: "center", behavior: "auto" });
    }
  }, [targetEventIndex, events, highlightQuote]);

  const [expandedGaps, setExpandedGaps] = useState<ReadonlySet<number>>(
    () => new Set(),
  );
  const [expandedEvents, setExpandedEvents] = useState<ReadonlySet<number>>(
    () => new Set(),
  );

  const baseIncluded = useMemo(() => {
    if (!picks) return null;
    if (picks instanceof Map) return picks;
    if ("picks" in picks) return applyLensPicks(events.length, picks);
    return applyLensPicks(events.length, { picks });
  }, [events.length, picks]);

  const effectiveIncluded = useMemo(() => {
    if (!baseIncluded) return null;
    const map = new Map(baseIncluded);
    for (const from of expandedGaps) {
      let cursor = from;
      while (cursor < events.length && !baseIncluded.has(cursor)) {
        map.set(cursor, null);
        cursor++;
      }
    }
    return map;
  }, [baseIncluded, expandedGaps, events.length]);

  const handleExpandGap = (from: number, _count: number) => {
    setExpandedGaps((prev) => new Set(prev).add(from));
  };

  const handleCollapseGap = (from: number) => {
    setExpandedGaps((prev) => {
      const next = new Set(prev);
      next.delete(from);
      return next;
    });
  };

  // Each expanded gap becomes a collapse span bracketed by rows at its first
  // and last event, so the reader can fold the reveal back from either end.
  const collapseMarkers = useMemo(() => {
    if (!baseIncluded) return null;
    const starts = new Map<number, TraceCollapseSpan>();
    const ends = new Map<number, TraceCollapseSpan>();
    for (const from of expandedGaps) {
      let cursor = from;
      while (cursor < events.length && !baseIncluded.has(cursor)) cursor++;
      const count = cursor - from;
      if (count <= 0) continue;
      const span = { from, count };
      starts.set(from, span);
      ends.set(cursor - 1, span);
    }
    return { starts, ends };
  }, [baseIncluded, expandedGaps, events.length]);

  const handleExpandEvent = (index: number) => {
    setExpandedEvents((prev) => new Set(prev).add(index));
  };

  const turns = useMemo(() => buildIndexedTraceTurns(events), [events]);

  const turnElements = useMemo(() => {
    if (effectiveIncluded === null) {
      return turns.map((turn, index) => {
        const isTargetTurn =
          targetEventIndex !== undefined &&
          (turn.user?.index === targetEventIndex ||
            turn.work.some((w) => w.index === targetEventIndex) ||
            turn.final.some((f) => f.index === targetEventIndex));
        // Groups containing the target render open (TraceToolGroup), so
        // even the quoted turn coalesces; quotes in tool text stay visible.
        const turnCoalesce = coalesce;

        return (
          <TraceTurn
            key={index}
            turn={turn}
            effectiveIncluded={null}
            expandedEvents={expandedEvents}
            onExpandGap={handleExpandGap}
            onExpandEvent={handleExpandEvent}
            targetEventIndex={targetEventIndex}
            highlightQuote={highlightQuote}
            turnCoalesce={turnCoalesce}
          />
        );
      });
    }

    const elements: ReactNode[] = [];
    let hiddenTurns: IndexedTraceTurnGroup[] = [];

    const flushHiddenTurns = () => {
      if (hiddenTurns.length === 0) return;
      const firstTurn = hiddenTurns[0];
      const lastTurn = hiddenTurns[hiddenTurns.length - 1];
      const from =
        firstTurn.user?.index ??
        firstTurn.work[0]?.index ??
        firstTurn.final[0]?.index;
      const to =
        lastTurn.final[lastTurn.final.length - 1]?.index ??
        lastTurn.work[lastTurn.work.length - 1]?.index ??
        lastTurn.user?.index;
      if (from !== undefined && to !== undefined) {
        const count = to - from + 1;
        elements.push(
          <TraceGapChip
            key={`gap-${from}`}
            from={from}
            count={count}
            onExpand={() => handleExpandGap(from, count)}
          />,
        );
      }
      hiddenTurns = [];
    };

    for (let i = 0; i < turns.length; i++) {
      const turn = turns[i];
      const isUserIncluded = turn.user
        ? effectiveIncluded.has(turn.user.index)
        : false;
      const includedWorkCount = turn.work.filter((w) =>
        effectiveIncluded.has(w.index),
      ).length;
      const includedFinalCount = turn.final.filter((f) =>
        effectiveIncluded.has(f.index),
      ).length;
      const hasAnyIncluded =
        isUserIncluded || includedWorkCount > 0 || includedFinalCount > 0;

      if (!hasAnyIncluded) {
        hiddenTurns.push(turn);
        continue;
      }

      flushHiddenTurns();

      const isTargetTurn =
        targetEventIndex !== undefined &&
        (turn.user?.index === targetEventIndex ||
          turn.work.some((w) => w.index === targetEventIndex) ||
          turn.final.some((f) => f.index === targetEventIndex));
      // Groups containing the target render open (TraceToolGroup), so
      // even the quoted turn coalesces; quotes in tool text stay visible.
      const turnCoalesce = coalesce;

      elements.push(
        <TraceTurn
          key={i}
          turn={turn}
          effectiveIncluded={effectiveIncluded}
          expandedEvents={expandedEvents}
          collapseStarts={collapseMarkers?.starts}
          collapseEnds={collapseMarkers?.ends}
          onExpandGap={handleExpandGap}
          onExpandEvent={handleExpandEvent}
          onCollapseGap={handleCollapseGap}
          targetEventIndex={targetEventIndex}
          highlightQuote={highlightQuote}
          turnCoalesce={turnCoalesce}
        />,
      );
    }
    flushHiddenTurns();
    return elements;
  }, [
    turns,
    effectiveIncluded,
    expandedEvents,
    collapseMarkers,
    targetEventIndex,
    highlightQuote,
    coalesce,
  ]);

  return (
    <div
      className={
        className ? `review-trace-events ${className}` : "review-trace-events"
      }
    >
      {turnElements}
    </div>
  );
}
