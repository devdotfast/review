// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";

import {
  captureTraceScrollAnchor,
  chooseTraceAnchor,
  restoreTraceScrollAnchor,
  traceScrollAdjustment,
} from "./trace-scroll-anchor";

/** A scroll container whose rows report stubbed layout positions. */
function makeContainer(
  rows: Array<{ index?: number; gap?: number; top: number }>,
) {
  const container = document.createElement("div");
  let scrollTop = 0;
  Object.defineProperty(container, "scrollTop", {
    get: () => scrollTop,
    set: (value: number) => {
      scrollTop = value;
    },
  });
  container.getBoundingClientRect = () =>
    ({
      top: 100,
      left: 0,
      width: 800,
      height: 600,
      bottom: 700,
      right: 800,
    }) as DOMRect;
  const setTop = (element: HTMLElement, top: number) => {
    element.getBoundingClientRect = () =>
      ({
        top,
        left: 0,
        width: 800,
        height: 40,
        bottom: top + 40,
        right: 800,
      }) as DOMRect;
  };
  const elements = rows.map((row) => {
    const element = document.createElement("div");
    if (row.index !== undefined) element.dataset.traceEvent = String(row.index);
    if (row.gap !== undefined) element.dataset.traceGap = String(row.gap);
    setTop(element, row.top);
    container.append(element);
    return element;
  });
  document.body.append(container);
  return { container, elements, setTop };
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("chooseTraceAnchor", () => {
  it("anchors the first row at or below the viewport top", () => {
    const anchor = chooseTraceAnchor(
      [
        { index: 0, top: -50 },
        { index: 1, top: 20 },
        { index: 2, top: 120 },
        { index: 3, top: 220 },
      ],
      100,
    );
    expect(anchor).toEqual({ index: 2, offset: 20 });
  });

  it("falls back to the last row when every row is above the viewport", () => {
    expect(
      chooseTraceAnchor(
        [
          { index: 4, top: -300 },
          { index: 5, top: -200 },
        ],
        100,
      ),
    ).toEqual({ index: 5, offset: -300 });
    expect(chooseTraceAnchor([], 100)).toBeNull();
  });
});

describe("traceScrollAdjustment", () => {
  it("returns the delta that restores the saved offset", () => {
    expect(traceScrollAdjustment({ index: 2, offset: 20 }, 420, 100)).toBe(300);
    expect(traceScrollAdjustment({ index: 2, offset: 20 }, 120, 100)).toBe(0);
  });
});

describe("capture and restore across an elision change", () => {
  it("keeps a row below the expanded gap still by scrolling past the inserted height", () => {
    const { container, elements, setTop } = makeContainer([
      { index: 0, top: 40 },
      { index: 7, top: 110 },
      { index: 8, top: 170 },
    ]);
    const anchor = captureTraceScrollAnchor(container);
    expect(anchor).toEqual({ index: 7, offset: 10 });

    // Expanding a gap above row 7 pushes it and its followers down 300px.
    setTop(elements[1], 410);
    setTop(elements[2], 470);
    expect(restoreTraceScrollAnchor(container, anchor!)).toBe(300);
    expect(container.scrollTop).toBe(300);
  });

  it("makes no adjustment when the anchored row sits above the change", () => {
    const { container, elements, setTop } = makeContainer([
      { index: 3, top: 130 },
      { index: 9, top: 200 },
    ]);
    const anchor = captureTraceScrollAnchor(container);
    expect(anchor).toEqual({ index: 3, offset: 30 });

    // Expanding a gap below row 3 moves only the rows after it.
    setTop(elements[1], 900);
    expect(restoreTraceScrollAnchor(container, anchor!)).toBe(0);
    expect(container.scrollTop).toBe(0);
  });

  it("lands on the gap chip when the anchored row was inside the folded span", () => {
    const { container, elements } = makeContainer([
      { index: 2, top: 50 },
      { index: 5, top: 130 },
      { index: 6, top: 190 },
      { index: 9, top: 250 },
    ]);
    const anchor = captureTraceScrollAnchor(container);
    expect(anchor).toEqual({ index: 5, offset: 30 });

    // Folding events 5..6 replaces them with the gap chip for `from: 5`.
    elements[1].remove();
    elements[2].remove();
    const chip = document.createElement("button");
    chip.dataset.traceGap = "5";
    chip.getBoundingClientRect = () =>
      ({
        top: 250,
        left: 0,
        width: 800,
        height: 22,
        bottom: 272,
        right: 800,
      }) as DOMRect;
    container.insertBefore(chip, elements[3]);

    expect(restoreTraceScrollAnchor(container, anchor!, 5)).toBe(120);
    expect(container.scrollTop).toBe(120);
    expect(
      restoreTraceScrollAnchor(container, { index: 42, offset: 0 }),
    ).toBeNull();
  });
});
