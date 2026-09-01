import type { ReviewAgentTraceEvent } from "@dev.fast/review-protocol";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  type IndexedTraceTurnGroup,
  buildIndexedTraceTurns,
  extractEventText,
} from "./trace-document";
import { findScrollContainer } from "./trace-scroll-anchor";

/**
 * Turn-ruler scrollbar for the agent trace view. A left-edge column of
 * uniform dashes maps the whole session at even pitch: one tick per turn
 * (a user prompt, its collapsed work, and the final response — the same
 * grouping the trace view renders via buildIndexedTraceTurns), bucketed only
 * when turns outnumber the rail. Brightness marks the turns currently in the
 * viewport. Hovering bulges nearby ticks toward the content and previews the
 * turn's prompt plus its final response; clicking a tick jumps to the turn.
 * There is no proportional thumb.
 */

export const RULER_TICK_PITCH = 11;
export const RULER_PAD = 10;
const RULER_TICK_WIDTH = 6;
const RULER_HOVER_WIDTH = 30;
const RULER_COMB_REACH = 4;

export function rulerTickCount(height: number, eventCount: number): number {
  if (eventCount <= 0) return 0;
  const fit = Math.floor((height - RULER_PAD * 2) / RULER_TICK_PITCH);
  return Math.max(0, Math.min(eventCount, fit));
}

/** Half-open event range [start, end) represented by one tick. */
export function rulerBucketRange(
  tick: number,
  tickCount: number,
  eventCount: number,
): { start: number; end: number } {
  const start = Math.floor((tick * eventCount) / tickCount);
  const end = Math.max(
    start + 1,
    Math.floor(((tick + 1) * eventCount) / tickCount),
  );
  return { start, end: Math.min(end, eventCount) };
}

export function rulerTickForEvent(
  index: number,
  tickCount: number,
  eventCount: number,
): number {
  if (eventCount <= 0 || tickCount <= 0) return 0;
  // Inverse of rulerBucketRange's floor boundaries: the tick whose
  // half-open bucket contains the event index.
  const tick = Math.ceil(((index + 1) * tickCount) / eventCount) - 1;
  return Math.min(tickCount - 1, Math.max(0, tick));
}

/** Comb widths: the hovered tick is longest, neighbors taper back to rest. */
export function rulerCombWidth(tick: number, hoverTick: number | null): number {
  if (hoverTick === null) return RULER_TICK_WIDTH;
  const distance = Math.abs(tick - hoverTick);
  if (distance > RULER_COMB_REACH) return RULER_TICK_WIDTH;
  const falloff = (RULER_COMB_REACH - distance) / RULER_COMB_REACH;
  return Math.round(
    RULER_TICK_WIDTH + (RULER_HOVER_WIDTH - RULER_TICK_WIDTH) * falloff ** 1.6,
  );
}

/**
 * Index of the tick whose rendered center is nearest the pointer. Hit-testing
 * against the real tick rects keeps hover exact regardless of layout.
 */
export function rulerNearestTick(
  rects: readonly { top: number; bottom: number }[],
  clientY: number,
): number | null {
  let best: number | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  rects.forEach((rect, index) => {
    const distance = Math.abs((rect.top + rect.bottom) / 2 - clientY);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = index;
    }
  });
  return best;
}

/** First event index of each turn; the last entry's span runs to eventCount. */
export function rulerTurnStarts(
  turns: readonly IndexedTraceTurnGroup[],
): number[] {
  return turns.map(
    (turn) =>
      turn.user?.index ?? turn.work[0]?.index ?? turn.final[0]?.index ?? 0,
  );
}

/** The turn whose span contains an event index (binary search over starts). */
export function rulerTurnForEvent(
  index: number,
  starts: readonly number[],
): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= index) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Preview for one turn, mirroring what the trace view shows for it: the user
 * prompt as the title and the final agent response (the trailing assistant
 * text after the collapsed work) as the snippet.
 */
export function rulerPreview(
  turn: IndexedTraceTurnGroup | undefined,
): { title: string; snippet: string } | null {
  if (!turn?.user) return null;
  const title = collapseWhitespace(extractEventText(turn.user.event));
  if (!title) return null;
  let snippet = "";
  for (const item of turn.final) {
    snippet = collapseWhitespace(extractEventText(item.event));
    if (snippet) break;
  }
  return { title, snippet };
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function TraceRuler({
  events,
}: {
  events: readonly ReviewAgentTraceEvent[];
}) {
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const railRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLElement | null>(null);
  const frameRef = useRef<number | null>(null);
  const [rect, setRect] = useState<{
    top: number;
    left: number;
    height: number;
  } | null>(null);
  const railHeight = rect?.height ?? 0;
  const [visibleRange, setVisibleRange] = useState<{
    lo: number;
    hi: number;
  } | null>(null);
  const [hoverTick, setHoverTick] = useState<number | null>(null);

  const eventCount = events.length;
  const turns = useMemo(() => buildIndexedTraceTurns([...events]), [events]);
  const turnStarts = useMemo(() => rulerTurnStarts(turns), [turns]);
  const turnCount = turns.length;
  const tickCount = rulerTickCount(railHeight, turnCount);

  const measureVisible = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const containerRect = container.getBoundingClientRect();
    let lo = Number.POSITIVE_INFINITY;
    let hi = Number.NEGATIVE_INFINITY;
    const wrappers =
      container.querySelectorAll<HTMLElement>("[data-trace-event]");
    for (const wrapper of wrappers) {
      const index = Number(wrapper.dataset.traceEvent);
      if (!Number.isFinite(index)) continue;
      const rect = wrapper.getBoundingClientRect();
      if (rect.bottom > containerRect.top && rect.top < containerRect.bottom) {
        lo = Math.min(lo, index);
        hi = Math.max(hi, index);
      }
    }
    setVisibleRange(lo <= hi ? { lo, hi } : null);
  }, []);

  useEffect(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    const container = findScrollContainer(anchor);
    containerRef.current = container;
    if (!container) return;

    const measureHeight = () => {
      const bounds = container.getBoundingClientRect();
      setRect({
        top: bounds.top,
        left: bounds.left,
        height: container.clientHeight,
      });
    };
    measureHeight();
    measureVisible();

    const onScroll = () => {
      if (frameRef.current !== null) return;
      frameRef.current = requestAnimationFrame(() => {
        frameRef.current = null;
        measureVisible();
      });
    };
    container.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", measureHeight);
    const resizeObserver =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(() => {
            measureHeight();
            measureVisible();
          })
        : null;
    resizeObserver?.observe(container);
    return () => {
      container.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", measureHeight);
      resizeObserver?.disconnect();
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    };
  }, [measureVisible, eventCount]);

  const tickTop = useCallback(
    (tick: number) => RULER_PAD + tick * RULER_TICK_PITCH,
    [],
  );

  const tickFromPointer = useCallback((clientY: number) => {
    const rail = railRef.current;
    if (!rail) return null;
    const rects = [
      ...rail.querySelectorAll<HTMLElement>(".review-trace-ruler-tick"),
    ].map((tick) => tick.getBoundingClientRect());
    return rulerNearestTick(rects, clientY);
  }, []);

  const jumpToTick = useCallback(
    (tick: number) => {
      const container = containerRef.current;
      if (!container || tickCount === 0) return;
      const { start: turn } = rulerBucketRange(tick, tickCount, turnCount);
      const start = turnStarts[turn] ?? 0;
      const wrappers = [
        ...container.querySelectorAll<HTMLElement>("[data-trace-event]"),
      ]
        .map((wrapper) => ({
          wrapper,
          index: Number(wrapper.dataset.traceEvent),
        }))
        .filter((entry) => Number.isFinite(entry.index))
        .sort((left, right) => left.index - right.index);
      const target =
        wrappers.find((entry) => entry.index >= start) ?? wrappers.at(-1);
      if (target && typeof target.wrapper.scrollIntoView === "function") {
        target.wrapper.scrollIntoView({ block: "start", behavior: "auto" });
        return;
      }
      container.scrollTop =
        (start / Math.max(1, eventCount)) *
        (container.scrollHeight - container.clientHeight);
    },
    [tickCount, turnCount, turnStarts, eventCount],
  );

  const preview = useMemo(() => {
    if (hoverTick === null || tickCount === 0) return null;
    const { start } = rulerBucketRange(hoverTick, tickCount, turnCount);
    return rulerPreview(turns[start]);
  }, [hoverTick, tickCount, turnCount, turns]);

  if (eventCount === 0 || turnCount === 0) return null;

  // Visible events map onto the turns that contain them.
  const visibleTurns =
    visibleRange === null
      ? null
      : {
          lo: rulerTurnForEvent(visibleRange.lo, turnStarts),
          hi: rulerTurnForEvent(visibleRange.hi, turnStarts),
        };

  const ticks: ReactNode[] = [];
  for (let tick = 0; tick < tickCount; tick += 1) {
    const { start, end } = rulerBucketRange(tick, tickCount, turnCount);
    const isVisible =
      visibleTurns !== null &&
      start <= visibleTurns.hi &&
      end > visibleTurns.lo;
    const width = rulerCombWidth(tick, hoverTick);
    const className = [
      "review-trace-ruler-tick",
      // While the comb is active only the hover treatment shows; the
      // viewport run returns when the pointer leaves.
      isVisible && hoverTick === null ? "review-trace-ruler-tick--visible" : "",
      tick === hoverTick ? "review-trace-ruler-tick--hovered" : "",
    ]
      .filter(Boolean)
      .join(" ");
    ticks.push(
      <div
        key={tick}
        className={className}
        style={{ top: tickTop(tick), width }}
      />,
    );
  }

  const cardTop =
    hoverTick !== null
      ? Math.max(RULER_PAD, Math.min(tickTop(hoverTick) - 24, railHeight - 140))
      : 0;

  return (
    <div ref={anchorRef} className="review-trace-ruler" aria-hidden="true">
      <div
        ref={railRef}
        className="review-trace-ruler-rail"
        style={{
          height: railHeight,
          top: rect?.top ?? 0,
          left: (rect?.left ?? 0) + 6,
        }}
        onMouseMove={(event) => setHoverTick(tickFromPointer(event.clientY))}
        onMouseLeave={() => setHoverTick(null)}
        onClick={(event) => {
          const tick = tickFromPointer(event.clientY);
          if (tick !== null) jumpToTick(tick);
        }}
      >
        {ticks}
        {preview && hoverTick !== null && (
          <div className="review-trace-ruler-card" style={{ top: cardTop }}>
            <span className="review-trace-ruler-card-title">
              {preview.title}
            </span>
            {preview.snippet && (
              <span className="review-trace-ruler-card-snippet">
                {preview.snippet}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
