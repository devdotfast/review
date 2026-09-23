import { act, createRef } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { Block } from "../../src/session-api/document";
import { ApiDocument } from "./api-document";
import { AuthoringActivityContext } from "./authoring-activity";
import type { AuthoringCursor } from "./authoring-cursor";
import { WhiteboardDebugSettingsProvider } from "./debug-settings";
import type { DrawQueueClock } from "./draw-queue-provider";
import { DrawQueueProvider } from "./draw-queue-provider";
import { WhiteboardSessionProvider } from "./host/whiteboard-session";
import { WhiteboardPanelProvider } from "./whiteboard-panel";
import type { WhiteboardRoots } from "./whiteboard-root-context";
import { WhiteboardRootsProvider } from "./whiteboard-root-context";
import {
  testApiDocumentData,
  testWhiteboardSession,
} from "./whiteboard-session-test-utils";

const blocks: Block[] = [
  { id: "b1", type: "markdown", markdown: "Before the diagram.\n" },
  {
    id: "d1",
    type: "flow_diagram",
    title: "Lease",
    nodes: [
      {
        id: "n1",
        type: "flow_node",
        key: "a",
        label: "Session",
        attachments: [],
      },
      {
        id: "n2",
        type: "flow_node",
        key: "b",
        label: "Broker",
        attachments: [],
      },
    ],
    edges: [{ id: "e1", type: "flow_edge", from: "a", to: "b" }],
  },
  { id: "b2", type: "markdown", markdown: "After the diagram.\n" },
  {
    id: "s1",
    type: "sequence",
    title: "Renewal",
    actors: { a: "Agent", s: "Server" },
    steps: [
      {
        id: "st1",
        type: "step",
        from: "a",
        to: "s",
        label: "renew",
        explanation: "Fresh expiry.",
        style: "call",
      },
    ],
  },
];

const data = testApiDocumentData(blocks);

const working = { workingCount: 1, expiresAt: null, focuses: [] };

/** A clock the test drives by hand: `advance` moves it forward and, inside
 * `act`, fires the pending timeout once its due time has passed. This is
 * what keeps a `data-motion` assertion on the test's schedule instead of
 * racing a loaded CI runner's wall clock. */
const createManualClock = () => {
  let time = 0;
  let nextId = 0;
  let scheduled: { id: number; due: number; fn: () => void } | null = null;

  const clock: DrawQueueClock = {
    now: () => time,
    setTimeout: (fn, ms) => {
      const id = ++nextId;
      scheduled = { id, due: time + ms, fn };

      return id;
    },
    clearTimeout: (handle) => {
      if (scheduled?.id === handle) scheduled = null;
    },
  };

  return {
    clock,
    advance: async (ms: number) => {
      time += ms;
      const due = scheduled;

      if (due && due.due <= time) {
        scheduled = null;
        await act(async () => due.fn());
      }
    },
  };
};

let container: HTMLElement, article: HTMLElement, root: Root;

let manualClock: ReturnType<typeof createManualClock>;

beforeEach(() => {
  article = document.createElement("article");
  article.className = "whiteboard-document";
  article.style.position = "relative";
  article.style.width = "900px";
  container = document.createElement("div");
  article.append(container);
  document.body.append(article);
  root = createRoot(container);
  manualClock = createManualClock();
});

afterEach(async () => {
  await act(async () => root.unmount());
  article.remove();
});

const render = async (cursor: AuthoringCursor | null, shown = data) => {
  const roots: WhiteboardRoots = {
    appRef: createRef<HTMLDivElement>(),
    shellRef: createRef<HTMLElement>(),
    scrollRegionRef: createRef<HTMLElement>(),
    articleRef: { current: article },
  };

  await act(async () =>
    root.render(
      <WhiteboardSessionProvider session={testWhiteboardSession()}>
        <WhiteboardDebugSettingsProvider>
          <WhiteboardPanelProvider>
            <WhiteboardRootsProvider roots={roots}>
              <AuthoringActivityContext.Provider value={working}>
                <DrawQueueProvider cursor={cursor} clock={manualClock.clock}>
                  <ApiDocument data={shown} />
                </DrawQueueProvider>
              </AuthoringActivityContext.Provider>
            </WhiteboardRootsProvider>
          </WhiteboardPanelProvider>
        </WhiteboardDebugSettingsProvider>
      </WhiteboardSessionProvider>,
    ),
  );
};

let seq = 0;

const insert = (
  targetId: string,
  blockId = targetId,
  unit?: "flow_node" | "flow_edge" | "step",
): AuthoringCursor => ({
  targetId,
  blockId,
  source: "edit",
  edit: { type: "insert", targetId, blockId, kind: unit ?? "markdown", unit },
  seq: ++seq,
});

const motion = (selector: string) =>
  article.querySelector<HTMLElement>(selector)?.dataset.motion;

const courier = () => article.querySelector<HTMLElement>(".courier");

it("traces a new flow node, then fills it, with the courier on it, and settles", async () => {
  await render(null);
  await vi.waitFor(() =>
    expect(
      article.querySelector('[data-whiteboard-unit-id="n2"]'),
    ).toBeTruthy(),
  );

  await render(insert("n2", "d1", "flow_node"));
  expect(motion('[data-whiteboard-unit-id="n2"]')).toBe("outline");
  await vi.waitFor(() => expect(courier()).toBeTruthy());
  await manualClock.advance(420);
  expect(motion('[data-whiteboard-unit-id="n2"]')).toBe("fill");
  await manualClock.advance(330);
  expect(motion('[data-whiteboard-unit-id="n2"]')).toBeUndefined();

  // The courier is still on the node once the queue is empty.
  const node = article
    .querySelector('[data-whiteboard-unit-id="n2"]')!
    .getBoundingClientRect();

  const base = article.getBoundingClientRect();
  expect(parseFloat(courier()!.style.top)).toBeCloseTo(node.top - base.top, 0);
});

it("stands on an edit already on the board when the reader arrives, drawing nothing", async () => {
  await render({ ...insert("b1"), source: "standing" });
  expect(motion('[data-whiteboard-node-id="b1"]')).toBeUndefined();
  await vi.waitFor(() => expect(courier()).toBeTruthy());

  const block = article
    .querySelector('[data-whiteboard-node-id="b1"]')!
    .getBoundingClientRect();

  const base = article.getBoundingClientRect();
  expect(parseFloat(courier()!.style.top)).toBeCloseTo(block.top - base.top, 0);
  expect(motion('[data-whiteboard-node-id="b1"]')).toBeUndefined();

  // The agent's next edit is drawn as usual.
  await render(insert("b2"));
  expect(motion('[data-whiteboard-node-id="b2"]')).toBe("landing");
});

it("keeps a queued block unseen until its turn, then lands it", async () => {
  await render(insert("b1"));
  expect(motion('[data-whiteboard-node-id="b1"]')).toBe("landing");

  // b2 arrives while b1 is still landing: it waits, hidden.
  await render(insert("b2"));
  expect(motion('[data-whiteboard-node-id="b2"]')).toBe("queued");

  await manualClock.advance(680);
  expect(motion('[data-whiteboard-node-id="b2"]')).toBe("landing");
  expect(motion('[data-whiteboard-node-id="b1"]')).toBeUndefined();
  await manualClock.advance(680);
  expect(motion('[data-whiteboard-node-id="b2"]')).toBeUndefined();
});

it("holds the attention ring on a focused block until the next edit lands", async () => {
  await render({ targetId: "b1", blockId: "b1", source: "focus", seq: ++seq });
  expect(motion('[data-whiteboard-node-id="b1"]')).toBe("attention");

  // The diagram lays out asynchronously; the edge has to be on the board
  // before an edit can be drawn on it.
  await vi.waitFor(() =>
    expect(
      article.querySelector('[data-whiteboard-unit-id="e1"]'),
    ).toBeTruthy(),
  );
  expect(motion('[data-whiteboard-node-id="b1"]')).toBe("attention");

  await render(insert("e1", "d1", "flow_edge"));
  expect(motion('[data-whiteboard-node-id="b1"]')).toBeUndefined();
  // The edge may remount with the layout; its outline lasts long enough.
  await vi.waitFor(() =>
    expect(motion('[data-whiteboard-unit-id="e1"]')).toBe("outline"),
  );
});

it("keeps a removed block on the board while it is erased, then lets it go", async () => {
  await render(null);
  expect(article.querySelector('[data-whiteboard-node-id="b2"]')).toBeTruthy();

  const without = testApiDocumentData(blocks.filter((b) => b.id !== "b2"));
  await render(
    {
      targetId: "b2",
      blockId: "b2",
      source: "edit",
      edit: { type: "remove", targetId: "b2", blockId: "b2", kind: "markdown" },
      seq: ++seq,
    },
    without,
  );

  // Still there, after its old neighbour, being erased.
  const ids = [...article.querySelectorAll("[data-whiteboard-node-id]")].map(
    (node) => node.getAttribute("data-whiteboard-node-id"),
  );

  expect(ids).toEqual(["b1", "d1", "b2", "s1"]);
  expect(motion('[data-whiteboard-node-id="b2"]')).toBe("erasing");

  await manualClock.advance(660);
  expect(article.querySelector('[data-whiteboard-node-id="b2"]')).toBeNull();
});

it("draws a sequence step's line before its arrowhead and dot", async () => {
  await render(null);
  await vi.waitFor(
    () =>
      expect(
        article.querySelector('[data-whiteboard-anchor-id="st1"]'),
      ).toBeTruthy(),
    { timeout: 5000 },
  );

  await render(insert("st1", "s1", "step"));
  await vi.waitFor(() =>
    expect(motion(".sequence-message[data-motion]")).toBe("outline"),
  );
  expect(motion('[data-whiteboard-anchor-id="st1"]')).toBe("outline");
  await manualClock.advance(450);
  expect(motion('[data-whiteboard-anchor-id="st1"]')).toBe("fill");
  await manualClock.advance(250);
  expect(motion('[data-whiteboard-anchor-id="st1"]')).toBeUndefined();
});
