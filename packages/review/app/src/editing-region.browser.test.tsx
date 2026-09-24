import { act, createRef } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { ActivitySnapshot } from "../../src/review-api/activity";
import type { Block } from "../../src/review-api/document";
import { ApiDocument } from "./api-document";
import { AuthoringActivityContext } from "./authoring-activity";
import type { AuthoringCursor } from "./authoring-cursor";
import { AuthoringCursorContext } from "./courier";
import { ReviewSessionProvider } from "./host/review-session";
import type { ReviewRoots } from "./review-root-context";
import { ReviewRootsProvider } from "./review-root-context";
import {
  testApiDocumentData,
  testReviewSession,
} from "./review-session-test-utils";

import "./styles.css";
import "./whiteboard.css";

const blocks: Block[] = [
  { id: "intro", type: "markdown", markdown: "Before the sections.\n" },
  {
    id: "failures",
    type: "section",
    title: "Failure modes",
    children: [
      { id: "p1", type: "markdown", markdown: "The broker dies.\n" },
      { id: "p2", type: "markdown", markdown: "Nothing revokes it.\n" },
    ],
  },
  {
    id: "testing",
    type: "section",
    title: "Testing",
    children: [{ id: "p3", type: "markdown", markdown: "Kill it.\n" }],
  },
];

const data = testApiDocumentData(blocks);

const working: ActivitySnapshot = {
  workingCount: 1,
  expiresAt: null,
  focuses: [],
};

const ended: ActivitySnapshot = { workingCount: 0, expiresAt: null };

let container: HTMLElement, article: HTMLElement, root: Root;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  article = document.createElement("article");
  article.className = "review-document";
  container = document.createElement("div");
  article.append(container);
  document.body.append(article);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  article.remove();
  vi.useRealTimers();
});

const render = async (
  cursor: AuthoringCursor | null,
  activity: ActivitySnapshot = working,
) => {
  const roots: ReviewRoots = {
    appRef: createRef<HTMLDivElement>(),
    shellRef: createRef<HTMLElement>(),
    scrollRegionRef: createRef<HTMLElement>(),
    articleRef: { current: article },
  };

  await act(async () =>
    root.render(
      <ReviewSessionProvider session={testReviewSession()}>
        <ReviewRootsProvider roots={roots}>
          <AuthoringActivityContext.Provider value={activity}>
            <AuthoringCursorContext.Provider value={cursor}>
              <ApiDocument data={data} />
            </AuthoringCursorContext.Provider>
          </AuthoringActivityContext.Provider>
        </ReviewRootsProvider>
      </ReviewSessionProvider>,
    ),
  );
};

let seq = 0;

const on = (blockId: string): AuthoringCursor => ({
  targetId: blockId,
  blockId,
  source: "edit",
  seq: ++seq,
});

const region = (id: string) =>
  article.querySelector<HTMLElement>(`[data-review-node-id="${id}"]`)?.dataset
    .region;

it("rings the top-level section holding the courier, not the block he is on", async () => {
  await render(on("p2"));

  expect(region("failures")).toBe("writing");
  expect(region("intro")).toBe("off");
  expect(region("testing")).toBe("off");
  expect(region("p2")).toBeUndefined();
});

it("holds the ring still once the courier sits, and pulses again when he moves", async () => {
  await render(on("p1"));
  await act(async () => vi.advanceTimersByTime(3000));
  expect(region("failures")).toBe("idle");

  await render(on("p3"));
  expect(region("failures")).toBe("off");
  expect(region("testing")).toBe("writing");
});

it("drops the ring when the document lease ends", async () => {
  const cursor = on("p1");
  await render(cursor);
  expect(region("failures")).toBe("writing");

  await render(cursor, ended);
  expect(region("failures")).toBe("off");
});

it("draws a section's ring around its chevron, not through it", async () => {
  await render(on("p1"));

  const node = article.querySelector<HTMLElement>(
    '[data-review-node-id="failures"]',
  )!;

  const section = node.querySelector<HTMLElement>(".review-section")!;
  const chevron = node.querySelector(".review-section-toggle")!;
  const ring = getComputedStyle(section, "::before");

  expect(getComputedStyle(node).outlineStyle).toBe("none");
  expect(ring.borderLeftStyle).toBe("solid");

  const left = section.getBoundingClientRect().left + parseFloat(ring.left);

  expect(left).toBeLessThan(chevron.getBoundingClientRect().left - 8);
});
