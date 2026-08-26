// @vitest-environment jsdom

import type { ReviewInlineEditorSpec } from "@dev.fast/review-protocol";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { InlineCodeEditor } from "./InlineCodeEditor";
import { ReviewFindProvider, createReviewFindHost } from "./review-find";
import { REVIEW_INTERACTION_EVENT } from "./review-interaction-event";
import {
  reviewSessionElement,
  testReviewSession,
} from "./review-session-test-utils";

class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = [];
  observed: Element[] = [];

  constructor(private readonly callback: IntersectionObserverCallback) {
    FakeIntersectionObserver.instances.push(this);
  }

  observe(element: Element) {
    this.observed.push(element);
  }

  disconnect() {
    this.observed = [];
  }

  unobserve() {}

  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }

  intersect() {
    this.callback(
      this.observed.map(
        (target) =>
          ({ isIntersecting: true, target }) as IntersectionObserverEntry,
      ),
      this as unknown as IntersectionObserver,
    );
  }
}

let root: ReturnType<typeof createRoot> | undefined;
let created: ReviewInlineEditorSpec[] = [];

beforeEach(() => {
  (
    globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  created = [];
  FakeIntersectionObserver.instances = [];
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

function renderPeek(active: boolean) {
  const session = testReviewSession(
    {},
    {
      diffView: {
        create: () => {
          throw new Error("unused test diff view");
        },
      },
      inlineEditors: {
        async find() {
          return { matchCount: 0 };
        },
        create: (spec) => {
          created.push(spec);
          return {
            height: 180,
            setActive() {},
            setCollapsed() {},
            async setFindQuery() {
              return { matchCount: 0 };
            },
            revealFindMatch() {},
            clearActiveFindMatch() {},
            clearFind() {},
            setCommentState() {},
            onDidChangeHeight: () => ({ dispose() {} }),
            onDidError: () => ({ dispose() {} }),
            onDidChangeCommentCardGeometry: () => ({ dispose() {} }),
            dispose() {},
          };
        },
      },
    },
  );
  const element = document.createElement("div");
  document.body.append(element);
  root = createRoot(element);
  act(() => {
    root?.render(
      reviewSessionElement(
        session,
        <InlineCodeEditor
          path="src/example.ts"
          title="src/example.ts"
          side="head"
          ranges={[{ startLine: 10, endLine: 14 }]}
          heightMode="content"
          active={active}
        />,
      ),
    );
  });
  return element;
}

it("defers native editor creation until the peek nears the viewport", () => {
  vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
  const element = renderPeek(false);

  expect(created).toHaveLength(0);
  const host = element.querySelector<HTMLElement>(".review-inline-editor");
  expect(host).not.toBeNull();
  // 5 range lines + 3 lines of leading context + 3 trailing = 11 lines
  // at LINE_HEIGHT 20 plus the 40px header.
  expect(host?.style.height).toBe("260px");

  const observer = FakeIntersectionObserver.instances.at(-1);
  expect(observer).toBeDefined();
  act(() => observer?.intersect());
  expect(created).toHaveLength(1);
});

it("searches an offscreen peek without mounting Monaco", async () => {
  vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
  const setFindQuery = vi.fn<() => Promise<{ matchCount: number }>>(
    async () => ({ matchCount: 1 }),
  );
  const find = vi.fn<() => Promise<{ matchCount: number }>>(async () => ({
    matchCount: 1,
  }));
  const session = testReviewSession(
    {},
    {
      inlineEditors: {
        find,
        create: (spec) => {
          created.push(spec);
          return {
            height: 180,
            setActive() {},
            setCollapsed() {},
            setFindQuery,
            revealFindMatch() {},
            clearActiveFindMatch() {},
            clearFind() {},
            onDidChangeHeight: () => ({ dispose() {} }),
            onDidError: () => ({ dispose() {} }),
            dispose() {},
          };
        },
      },
    },
  );
  const element = document.createElement("div");
  const article = document.createElement("article");
  const scrollRegion = document.createElement("section");
  element.append(article, scrollRegion);
  document.body.append(element);
  const host = createReviewFindHost();
  root = createRoot(article);
  await act(async () => {
    root?.render(
      reviewSessionElement(
        session,
        <ReviewFindProvider
          articleRef={{ current: article }}
          scrollRegionRef={{ current: scrollRegion }}
          documentKey="test"
          host={host}
        >
          <p>needle in authored text</p>
          <InlineCodeEditor
            path="src/offscreen.ts"
            title="src/offscreen.ts"
            side="head"
            ranges={[{ startLine: 1, endLine: 3 }]}
            heightMode="content"
            active={false}
          />
        </ReviewFindProvider>,
      ),
    );
  });

  expect(created).toHaveLength(0);
  await act(async () => {
    expect(host.showFind("needle")).toBe(true);
  });
  await vi.waitFor(() => {
    expect(find).toHaveBeenCalledWith(
      {
        path: "src/offscreen.ts",
        side: "head",
        ranges: [{ startLine: 1, endLine: 3 }],
        commentsEnabled: false,
      },
      {
        text: "needle",
        matchCase: false,
        wholeWord: false,
        isRegex: true,
      },
    );
  });
  expect(created).toHaveLength(0);
  expect(setFindQuery).not.toHaveBeenCalled();
});

it("finishes search when revealing a failed editor", async () => {
  vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
  const session = testReviewSession(
    {},
    {
      inlineEditors: {
        async find() {
          return { matchCount: 1 };
        },
        create() {
          throw new Error("editor creation failed");
        },
      },
    },
  );
  const article = document.createElement("article");
  const scrollRegion = document.createElement("section");
  document.body.append(article, scrollRegion);
  const host = createReviewFindHost();
  root = createRoot(article);
  await act(async () => {
    root?.render(
      reviewSessionElement(
        session,
        <ReviewFindProvider
          articleRef={{ current: article }}
          scrollRegionRef={{ current: scrollRegion }}
          documentKey="failed-editor"
          host={host}
        >
          <InlineCodeEditor
            path="src/failure.ts"
            title="src/failure.ts"
            side="head"
            ranges={[{ startLine: 1, endLine: 3 }]}
            heightMode="content"
            active={false}
          />
        </ReviewFindProvider>,
      ),
    );
  });
  await act(async () => {
    expect(host.showFind("needle")).toBe(true);
  });

  await vi.waitFor(() => {
    expect(article.querySelector(".review-find-count")?.textContent).toBe(
      "1 of 1",
    );
    expect(
      article.querySelector(".review-inline-editor-error")?.textContent,
    ).toContain("Inline preview unavailable");
  });
});

it("mounts immediately when the peek is active", () => {
  vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
  renderPeek(true);
  expect(created).toHaveLength(1);
});

it("mounts eagerly when IntersectionObserver is unavailable", () => {
  renderPeek(false);
  expect(created).toHaveLength(1);
});

it("emits neutral hover and navigation interactions without remounting", () => {
  let disposed = 0;
  const session = testReviewSession(
    {},
    {
      inlineEditors: {
        async find() {
          return { matchCount: 0 };
        },
        create: (spec) => {
          created.push(spec);
          return {
            height: 180,
            setActive() {},
            setCollapsed() {},
            async setFindQuery() {
              return { matchCount: 0 };
            },
            revealFindMatch() {},
            clearActiveFindMatch() {},
            clearFind() {},
            setCommentState() {},
            onDidChangeHeight: () => ({ dispose() {} }),
            onDidError: () => ({ dispose() {} }),
            onDidChangeCommentCardGeometry: () => ({ dispose() {} }),
            dispose() {
              disposed += 1;
            },
          };
        },
      },
    },
  );
  const element = document.createElement("div");
  document.body.append(element);
  root = createRoot(element);
  const interactions: unknown[] = [];
  element.addEventListener(REVIEW_INTERACTION_EVENT, (event) => {
    interactions.push((event as CustomEvent).detail);
  });
  act(() => {
    root?.render(
      reviewSessionElement(
        session,
        <InlineCodeEditor
          path="src/example.ts"
          title="src/example.ts"
          side="head"
          ranges={[{ startLine: 10, endLine: 14 }]}
          heightMode="content"
          active
        />,
      ),
    );
  });
  expect(created).toHaveLength(1);
  const { onDidNavigate, onDidShowHover } = created[0]!;
  act(() => {
    onDidShowHover?.();
    onDidNavigate?.();
  });
  expect(interactions).toEqual([
    { kind: "inline-hover", path: "src/example.ts" },
    { kind: "inline-navigation", path: "src/example.ts" },
  ]);
  expect(created).toHaveLength(1);
  expect(disposed).toBe(0);
});
