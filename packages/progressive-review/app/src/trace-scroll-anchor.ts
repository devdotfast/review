/**
 * Scroll anchoring for the agent trace view.
 *
 * Expanding or collapsing an elision inserts or removes rows in place while
 * the browser keeps `scrollTop` constant, so a gap opened near the top of the
 * viewport teleports the reader into the revealed span. These helpers pin one
 * visible row to its viewport offset across the DOM change: capture the row
 * before the state update, then restore its offset after React commits.
 *
 * The anchor is the first row at or below the viewport top. A row below the
 * changed span moves by the inserted (or removed) height, so restoring it
 * keeps the reader's view still and the revealed content lands above, in
 * reach by scrolling. A row above the span never moves, so the adjustment is
 * zero and the content grows downward beneath what the reader was looking at.
 */

export interface TraceScrollAnchor {
  /** Event index carried by the anchored row's `data-trace-event`. */
  index: number;
  /** Row top relative to the scroll container's top, before the change. */
  offset: number;
}

export interface TraceAnchorCandidate {
  index: number;
  top: number;
}

/** Nearest ancestor whose computed overflow scrolls. */
export function findScrollContainer(element: HTMLElement): HTMLElement | null {
  let parent = element.parentElement;
  while (parent) {
    const style = window.getComputedStyle(parent);
    if (
      /(auto|scroll)/.test(style.overflowY) ||
      /(auto|scroll)/.test(style.overflow)
    ) {
      return parent;
    }
    parent = parent.parentElement;
  }
  return null;
}

/**
 * Choose the anchor among measured rows (in document order): the first row
 * whose top sits at or below the viewport top. When every row is above the
 * viewport, the last row is the closest one and anchors instead.
 */
export function chooseTraceAnchor(
  rows: readonly TraceAnchorCandidate[],
  viewportTop: number,
): TraceScrollAnchor | null {
  if (rows.length === 0) return null;
  const visible = rows.find((row) => row.top >= viewportTop - 0.5);
  const chosen = visible ?? rows[rows.length - 1];
  return { index: chosen.index, offset: chosen.top - viewportTop };
}

/** Scroll delta that returns the anchor to its saved viewport offset. */
export function traceScrollAdjustment(
  anchor: TraceScrollAnchor,
  currentTop: number,
  viewportTop: number,
): number {
  return currentTop - viewportTop - anchor.offset;
}

function measureRows(container: HTMLElement): TraceAnchorCandidate[] {
  const rows: TraceAnchorCandidate[] = [];
  for (const element of container.querySelectorAll<HTMLElement>(
    "[data-trace-event]",
  )) {
    const index = Number(element.dataset.traceEvent);
    if (!Number.isFinite(index)) continue;
    rows.push({ index, top: element.getBoundingClientRect().top });
  }
  return rows;
}

/** Capture the anchor for `container` before the trace DOM changes. */
export function captureTraceScrollAnchor(
  container: HTMLElement,
): TraceScrollAnchor | null {
  return chooseTraceAnchor(
    measureRows(container),
    container.getBoundingClientRect().top,
  );
}

/**
 * Restore the anchor after the trace DOM changed. When the anchored row is
 * gone (it sat inside a span that was just folded), the gap chip that took
 * the span's place stands in for it, so folding lands the reader on the chip.
 * Returns the applied delta, or null when nothing could be anchored.
 */
export function restoreTraceScrollAnchor(
  container: HTMLElement,
  anchor: TraceScrollAnchor,
  fallbackGap?: number,
): number | null {
  const row =
    container.querySelector<HTMLElement>(
      `[data-trace-event="${anchor.index}"]`,
    ) ??
    (fallbackGap === undefined
      ? null
      : container.querySelector<HTMLElement>(
          `[data-trace-gap="${fallbackGap}"]`,
        ));
  if (!row) return null;
  const delta = traceScrollAdjustment(
    anchor,
    row.getBoundingClientRect().top,
    container.getBoundingClientRect().top,
  );
  if (delta !== 0) container.scrollTop += delta;
  return delta;
}
