import { act, createRef } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { ActivitySnapshot } from "../../src/session-api/activity";
import { SessionApiClient } from "../../src/session-api/client";
import type { Lens } from "../../src/session-api/diff-lenses";
import type { Snapshot } from "../../src/session-api/store";
import {
  AuthoringActivityBadge,
  AuthoringActivityContext,
} from "./authoring-activity";
import type { AuthoringCursor } from "./authoring-cursor";
import { AuthoringCursorContext } from "./courier";
import { WhiteboardDiffView } from "./DiffView";
import { type DrawQueueClock, DrawQueueProvider } from "./draw-queue-provider";
import { WhiteboardSessionProvider } from "./host/whiteboard-session";
import { WhiteboardLensesProvider } from "./whiteboard-lenses";
import {
  type WhiteboardRoots,
  WhiteboardRootsProvider,
} from "./whiteboard-root-context";
import { testWhiteboardSession } from "./whiteboard-session-test-utils";

const api: Lens = {
  id: "lens-1",
  title: "API",
  targets: [{ kind: "files", patterns: ["src/api/**"] }],
};

const docs: Lens = {
  id: "lens-2",
  title: "Docs",
  targets: [
    { kind: "files", patterns: ["docs/**"] },
    {
      kind: "ranges",
      sources: [
        {
          file: "README.md",
          start: { side: "head", line: 1 },
          end: { side: "head", line: 4 },
        },
      ],
    },
  ],
};

const lensesOnly: ActivitySnapshot = {
  workingCount: 1,
  expiresAt: null,
  scopes: ["lenses"],
};

const both: ActivitySnapshot = {
  workingCount: 2,
  expiresAt: null,
  scopes: ["document", "lenses"],
};

/** Timers the test fires by hand, so each phase is asserted on schedule. */
const createManualClock = () => {
  let time = 0;
  let scheduled: { id: number; due: number; fn: () => void } | null = null;
  let nextId = 0;

  const clock: DrawQueueClock = {
    now: () => time,
    setTimeout: (fn, ms) => {
      scheduled = { id: ++nextId, due: time + ms, fn };

      return scheduled.id;
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

let app: HTMLDivElement, root: Root;

let manualClock: ReturnType<typeof createManualClock>;

const onLocate = vi.fn<(view: "review" | "diff") => void>();

/** The lenses the host's progress route answers with: the version shown. */
let served: Lens[] = [];

const session = testWhiteboardSession(
  {},
  {
    request: async () =>
      Response.json({
        files: [],
        lenses: [
          ...served.map((lens) => ({
            id: lens.id,
            title: lens.title,
            sources: [],
            fileCount: 1,
          })),
          {
            id: "automatic-uncategorized",
            title: "Uncategorized changes",
            sources: [],
            fileCount: 0,
          },
        ],
        resolvedSelections: {},
      }),
    diffView: {
      files: async () => [],
      create: () => ({
        focus() {},
        onDidError: () => ({ dispose() {} }),
        dispose() {},
      }),
    },
  },
);

const client = new SessionApiClient(session.config, session.bridge.request);

beforeEach(() => {
  app = document.createElement("div");
  app.style.width = "900px";
  app.style.height = "700px";
  document.body.append(app);
  root = createRoot(app);
  manualClock = createManualClock();
  onLocate.mockClear();
});

afterEach(async () => {
  await act(async () => root.unmount());
  app.remove();
});

const render = async (state: {
  lenses: Lens[];
  version: number;
  activity?: ActivitySnapshot;
  lensCursor: AuthoringCursor | null;
  documentCursor?: AuthoringCursor | null;
}) => {
  served = state.lenses;

  const snapshot: Snapshot = {
    sessionId: "lens-courier",
    version: state.version,
    title: "Lenses",
    pins: { repositoryId: "r", base: "b", head: "h" },
    target: { kind: "commits", repositoryId: "r", base: "b", head: "h" },
    document: [],
    lenses: state.lenses,
    createdAt: "2026-09-23",
  };

  const roots: WhiteboardRoots = {
    appRef: { current: app },
    shellRef: createRef<HTMLElement>(),
    scrollRegionRef: createRef<HTMLElement>(),
    articleRef: createRef<HTMLElement>(),
  };

  await act(async () =>
    root.render(
      <WhiteboardSessionProvider session={session}>
        <WhiteboardRootsProvider roots={roots}>
          <AuthoringActivityContext.Provider
            value={state.activity ?? lensesOnly}
          >
            <AuthoringCursorContext.Provider
              value={state.documentCursor ?? null}
            >
              <DrawQueueProvider
                scope="lenses"
                cursor={state.lensCursor}
                clock={manualClock.clock}
              >
                <WhiteboardLensesProvider client={client} snapshot={snapshot}>
                  <AuthoringActivityBadge onLocate={onLocate} />
                  <WhiteboardDiffView />
                </WhiteboardLensesProvider>
              </DrawQueueProvider>
            </AuthoringCursorContext.Provider>
          </AuthoringActivityContext.Provider>
        </WhiteboardRootsProvider>
      </WhiteboardSessionProvider>,
    ),
  );
};

let seq = 0;

const lensEdit = (
  type: "insert" | "update" | "remove",
  targetId: string,
): AuthoringCursor => ({
  targetId,
  blockId: targetId,
  source: "edit",
  edit: { type, targetId, blockId: targetId, kind: "lens" },
  seq: ++seq,
});

const row = (id: string) =>
  app.querySelector<HTMLElement>(`[data-lens-id="${id}"]`);

const courier = () =>
  app.querySelector<HTMLElement>('.courier[data-scope="lenses"]');

it("lands a new lens row with the courier on it, without listing its files, and erases a removed one", async () => {
  await render({ lenses: [api], version: 1, lensCursor: null });
  expect(courier()).toBeNull();

  await render({
    lenses: [api, docs],
    version: 2,
    lensCursor: lensEdit("insert", docs.id),
  });
  expect(row(docs.id)?.dataset.motion).toBe("landing");
  await vi.waitFor(() => expect(courier()).toBeTruthy());

  const list = app.querySelector<HTMLElement>(".diff-sidebar-lenses")!;
  const box = list.getBoundingClientRect();
  expect(parseFloat(courier()!.style.top)).toBeCloseTo(
    row(docs.id)!.getBoundingClientRect().top - box.top + list.scrollTop,
    0,
  );

  // The row lands and settles; the files it groups are never listed under it.
  await manualClock.advance(520);
  expect(row(docs.id)?.dataset.motion).toBeUndefined();
  expect(row(docs.id)?.querySelector("ul, li")).toBeNull();

  // A removed row stays in its place while it is erased, then goes.
  await render({
    lenses: [docs],
    version: 3,
    lensCursor: lensEdit("remove", api.id),
  });
  expect(
    [...app.querySelectorAll("[data-lens-id]")].map((item) =>
      item.getAttribute("data-lens-id"),
    ),
  ).toEqual([api.id, docs.id, "automatic-uncategorized"]);
  expect(row(api.id)?.dataset.motion).toBe("erasing");
  await manualClock.advance(520);
  expect(row(api.id)).toBeNull();
});

it("sends the top-bar badge to the Diffs page while only lenses are written", async () => {
  await render({
    lenses: [api, docs],
    version: 2,
    lensCursor: { targetId: api.id, blockId: api.id, source: "focus", seq: 1 },
  });
  await vi.waitFor(() => expect(courier()).toBeTruthy());

  const scroll = vi.fn<() => void>();
  row(api.id)!.scrollIntoView = scroll;

  const badge = app.querySelector<HTMLButtonElement>(
    "button.host-authoring-activity",
  )!;

  await act(async () => badge.click());
  expect(onLocate).toHaveBeenCalledWith("diff");
  await vi.waitFor(() => expect(scroll).toHaveBeenCalled());
  await vi.waitFor(() => expect(courier()!.dataset.motion).toBe("jumping"));

  // With the document being written too, the badge keeps going to the
  // document's courier.
  onLocate.mockClear();
  await render({
    lenses: [api, docs],
    version: 2,
    activity: both,
    lensCursor: { targetId: api.id, blockId: api.id, source: "focus", seq: 1 },
    documentCursor: { targetId: "b1", blockId: "b1", source: "focus", seq: 1 },
  });
  await act(async () =>
    app
      .querySelector<HTMLButtonElement>("button.host-authoring-activity")!
      .click(),
  );
  expect(onLocate).toHaveBeenCalledWith("review");
});
