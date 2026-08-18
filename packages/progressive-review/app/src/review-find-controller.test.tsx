// @vitest-environment jsdom

import type {
  ReviewFindQuery,
  ReviewInlineEditorHandle,
} from "@dev.fast/review-protocol";
import { act, useLayoutEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import {
  type ReviewFindHost,
  ReviewFindProvider,
  createReviewFindHost,
  useReviewFindRegistration,
} from "./review-find";

let root: ReturnType<typeof createRoot> | undefined;

beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
});

it("orders duplicate editors with MDX and wraps navigation", async () => {
  const first = findHandle();
  const second = findHandle();
  const focusTarget = document.createElement("button");
  const container = document.createElement("div");
  document.body.append(focusTarget, container);
  focusTarget.focus();
  const host = createReviewFindHost();
  root = createRoot(container);
  await act(async () => {
    root?.render(<FindHarness host={host} handles={[first, second]} />);
  });

  await act(async () => {
    expect(host.showFind("Alpha")).toBe(true);
  });
  await vi.waitFor(() => {
    expect(container.querySelector(".review-find-count")?.textContent).toBe(
      "1 of 4",
    );
  });
  const next = button(container, "Next Match");
  await act(async () => next.click());
  await vi.waitFor(() => {
    expect(first.revealFindMatch).toHaveBeenCalledWith(0);
  });
  expect(container.querySelector(".review-find-count")?.textContent).toBe(
    "2 of 4",
  );
  await act(async () => next.click());
  expect(container.querySelector(".review-find-count")?.textContent).toBe(
    "3 of 4",
  );
  expect(first.clearActiveFindMatch).toHaveBeenCalled();
  await act(async () => next.click());
  await vi.waitFor(() => {
    expect(second.revealFindMatch).toHaveBeenCalledWith(0);
  });
  await act(async () => next.click());
  expect(container.querySelector(".review-find-count")?.textContent).toBe(
    "1 of 4",
  );

  await act(async () => button(container, "Close Find").click());
  expect(document.activeElement).toBe(focusTarget);
  expect(first.clearFind).toHaveBeenCalled();
  expect(second.clearFind).toHaveBeenCalled();
});

it("ignores results from an older query generation", async () => {
  let resolveSlow!: (value: { matchCount: number }) => void;
  const slow = new Promise<{ matchCount: number }>((resolve) => {
    resolveSlow = resolve;
  });
  const handle = findHandle(async (query) =>
    query.text.includes("slow") ? slow : { matchCount: 1 },
  );
  const container = document.createElement("div");
  document.body.append(container);
  const host = createReviewFindHost();
  root = createRoot(container);
  await act(async () => {
    root?.render(<FindHarness host={host} handles={[handle]} />);
  });
  await act(async () => {
    expect(host.showFind("slow")).toBe(true);
  });
  await vi.waitFor(() => {
    expect(
      container.querySelector('.review-find-widget input[aria-label="Find"]'),
    ).not.toBeNull();
  });
  await setInput(container, "Alpha");
  await vi.waitFor(() => {
    expect(container.querySelector(".review-find-count")?.textContent).toBe(
      "1 of 3",
    );
  });
  resolveSlow({ matchCount: 9 });
  await act(async () => Promise.resolve());
  expect(container.querySelector(".review-find-count")?.textContent).toBe(
    "1 of 3",
  );
});

it("uses equal action controls and describes every Find option", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const host = createReviewFindHost();
  root = createRoot(container);
  await act(async () => {
    root?.render(<FindHarness host={host} handles={[findHandle()]} />);
  });
  await act(async () => {
    expect(host.showFind()).toBe(true);
  });

  const actions = [
    button(container, "Previous Match"),
    button(container, "Next Match"),
    button(container, "Close Find"),
  ];
  expect(actions.map((action) => action.className)).toEqual([
    "review-find-action",
    "review-find-action",
    "review-find-action",
  ]);
  expect(
    actions.map((action) =>
      action.querySelector("svg")?.getAttribute("viewBox"),
    ),
  ).toEqual(["0 0 16 16", "0 0 16 16", "0 0 16 16"]);
  expect(button(container, "Match Case").title).toContain(
    "uppercase and lowercase",
  );
  expect(button(container, "Match Whole Word").title).toContain(
    "complete words only",
  );
  expect(button(container, "Use Regular Expression").title).toContain(
    "regular expression",
  );
});

function FindHarness({
  host,
  handles,
}: {
  host: ReviewFindHost;
  handles: ReviewInlineEditorHandle[];
}) {
  const articleRef = useRef<HTMLElement | null>(null);
  const scrollRef = useRef<HTMLElement | null>(null);
  return (
    <ReviewFindProvider
      articleRef={articleRef}
      scrollRegionRef={scrollRef}
      documentKey="test-document"
      host={host}
    >
      <section ref={scrollRef}>
        <article ref={articleRef} className="review-document">
          <p>Alpha first</p>
          <InlineRegistration handle={handles[0]!} />
          <p>Alpha second</p>
          {handles[1] ? <InlineRegistration handle={handles[1]} /> : null}
        </article>
      </section>
    </ReviewFindProvider>
  );
}

function InlineRegistration({ handle }: { handle: ReviewInlineEditorHandle }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const find = useReviewFindRegistration();
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container || !find) return;
    return find.register({
      container,
      setFindQuery: (query) => handle.setFindQuery(query),
      async revealFindMatch(index) {
        handle.revealFindMatch(index);
      },
      clearFind: () => handle.clearFind(),
      getHandle: () => handle,
      expand() {},
    });
  }, [find, handle]);
  return <div ref={containerRef} data-review-inline-editor="duplicate.ts" />;
}

function findHandle(
  search: (
    query: ReviewFindQuery,
  ) => Promise<{ matchCount: number }> = async () => ({ matchCount: 1 }),
) {
  const revealFindMatch = vi.fn<(index: number) => void>();
  const clearActiveFindMatch = vi.fn<() => void>();
  const clearFind = vi.fn<() => void>();
  return {
    height: 100,
    setActive() {},
    setCollapsed() {},
    setFindQuery: vi.fn<typeof search>(search),
    revealFindMatch,
    clearActiveFindMatch,
    clearFind,
    onDidChangeHeight: () => ({ dispose() {} }),
    onDidError: () => ({ dispose() {} }),
    dispose() {},
  };
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const result = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.getAttribute("aria-label") === label,
  );
  if (!result) throw new Error(`Missing ${label} button`);
  return result;
}

async function setInput(container: HTMLElement, value: string): Promise<void> {
  const input = container.querySelector<HTMLInputElement>(
    '.review-find-widget input[aria-label="Find"]',
  );
  if (!input) throw new Error("Missing Find input");
  const setValue = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  if (!setValue) throw new Error("Missing input value setter");
  await act(async () => {
    setValue.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
