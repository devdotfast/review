import {
  type JsonValue,
  type ReviewCanvasTutorialBridge,
  parseJsonText,
} from "@dev.fast/review-protocol";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  FIXTURE_IMAGE_ID,
  FIXTURE_MAP_ID,
  FIXTURE_TRACE_EVENT_ID,
  FIXTURE_TRACE_ID,
} from "../../src/fixtures/blocks/ids";
import { selectionKey } from "../../src/lens-selection";
import {
  assignFreshIds,
  documentSchema,
  elements,
  isUnit,
} from "../../src/review-api/document";
import { mapInputSchema } from "../../src/review-api/map-input";
import type { ReviewProgress } from "../../src/review-api/review-progress";
import type { Snapshot } from "../../src/review-api/store";
import { defineSoftwareMap } from "../../src/software-map-model";
import tutorialDocument from "../../tutorial/document.json";
import tutorialModel from "../../tutorial/software-map.json";
import tutorialTrace from "../../tutorial/trace.json";
import { BlockErrorBoundary, blockComponents } from "./blocks";
import { mountReviewCanvas as mount } from "./desktop-entry";
import { fixtureReviewBridge, settled } from "./fixture-review-bridge";

type Kind = keyof typeof blockComponents;

// Vite inlines the fixture files, one array of blocks per kind.
const fixtureFiles = import.meta.glob<{ default: JsonValue }>(
  "../../src/fixtures/blocks/*.json",
  { eager: true },
);

const fixtures = new Map(
  Object.entries(fixtureFiles).map(([file, module]) => [
    file.slice(file.lastIndexOf("/") + 1, -".json".length),
    documentSchema.parse(module.default),
  ]),
);

const trace = {
  label: "Fixture conversation",
  events: [
    {
      id: FIXTURE_TRACE_EVENT_ID,
      role: "assistant",
      text: "Please queue the order once the row is written.",
    },
  ],
};

// A 1x1 PNG.
const png = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  ),
  (char) => char.charCodeAt(0),
);

// What the host serves for an uploaded map: the normalized elements and
// relationships as JSON, resolved with empty diff counts.
const model = defineSoftwareMap({
  systems: {
    orders: {
      label: "Order service",
      containers: { api: { label: "Order API", components: { save: {} } } },
    },
  },
});

const savedMap = parseJsonText(
  JSON.stringify({
    elements: model.elements,
    relationships: model.relationships,
    side: "head",
    commit: "head",
    countsByElementPath: {},
    unmappedByElementPath: {},
  }),
);

// The fixture compares the single status line in order.ts on both sides.
const fixtureProgress: ReviewProgress = {
  files: [],
  lenses: [],
  resolvedSelections: Object.fromEntries(
    (["base", "head"] as const).map((side) => [
      selectionKey({
        file: "order.ts",
        start: { side, line: 1 },
        end: { side, line: 1 },
      }),
      [
        { file: "order.ts", side: "base", fromLine: 1, toLine: 1 },
        { file: "order.ts", side: "head", fromLine: 1, toLine: 1 },
      ],
    ]),
  ),
};

const text = (container: HTMLElement) => container.textContent ?? "";

const has = (container: HTMLElement, selector: string) =>
  container.querySelector(selector) !== null;

/**
 * What each kind must have rendered from its fixture. The NodeReveal wrapper
 * exists for every block, so these look inside it: real content, and for the
 * diagrams a finished layout.
 */
const rendered: Record<
  Exclude<Kind, "call_stack_diff">,
  (container: HTMLElement) => boolean
> = {
  markdown: (c) =>
    c.querySelector("h1")?.textContent === "Order status" &&
    has(c, "a[href*='review-source:']"),
  code: (c) =>
    (c.querySelector("pre")?.textContent ?? "").includes(
      'export const status = "queued";',
    ) && text(c).includes("The new status"),
  divider: (c) => has(c, "hr"),
  // The peek asked the host for an inline editor on the fixture's file.
  code_peek: (c) =>
    has(c, ".code-peek .fixture-inline-editor[data-path='order.ts']"),
  // Every step is laid out as a routed message once the diagram settles.
  sequence: (c) =>
    has(c, ".sequence-diagram-body") &&
    has(c, "[data-review-anchor-id='step-1']") &&
    has(c, "[data-review-anchor-id='step-2']") &&
    text(c).includes("set status"),
  database_lens: (c) =>
    has(c, ".database-lens select") &&
    text(c).includes("Queue an order") &&
    text(c).includes("write queued"),
  image: (c) =>
    has(c, "figure.review-image img[src^='blob:']") &&
    text(c).includes("An image"),
  trace_quote: (c) =>
    has(c, ".review-trace-quote") && text(c).includes("queue the order"),
  // The map has drawn its system and is neither refreshing nor failed.
  flow_diagram: (c) =>
    has(c, ".flow-node") &&
    text(c).includes("Queue order") &&
    !text(c).includes("Laying out"),
  software_map: (c) =>
    has(c, ".software-map-canvas") &&
    text(c).includes("Order service") &&
    !has(c, ".software-map-code-status"),
  section: (c) =>
    has(c, "button[aria-expanded='true']") && text(c).includes("Hello."),
  tutorial: (c) =>
    has(c, ".tutorial-authoring-conversation") &&
    text(c).includes("Explain this change."),
  callout: (c) =>
    c.querySelector("blockquote[data-tone='warning'] strong")?.textContent ===
      "Note" && text(c).includes("Careful."),
};

let canvas: ReturnType<typeof mount> | undefined;

afterEach(async () => {
  await act(async () => canvas?.dispose());
  canvas = undefined;
});

async function mountFixture(
  kind: Kind,
  options: { trace?: null; document?: Snapshot["document"] } = {},
  tutorial?: ReviewCanvasTutorialBridge,
  shippedTutorial = false,
  hostStyle?: string,
) {
  const snapshot: Snapshot = {
    reviewId: `fixture-${kind}`,
    version: 0,
    title: "Fixture review",
    pins: { repositoryId: "repo", base: "base", head: "head" },
    target: {
      kind: "commits",
      repositoryId: "repo",
      base: "base",
      head: "head",
    },
    document: shippedTutorial
      ? documentSchema.parse(tutorialDocument.document)
      : (options.document ?? fixtures.get(kind)!),
    origin: shippedTutorial ? { tutorial: true } : undefined,
    createdAt: "2026-09-16T00:00:00.000Z",
  };

  if (shippedTutorial) {
    let nextId = 0;

    for (const block of snapshot.document)
      assignFreshIds(block, (prefix) => `${prefix}-${++nextId}`);
  }

  const image = { bytes: png, type: "image/png" };

  const bridge = fixtureReviewBridge({
    snapshot,
    progress: fixtureProgress,
    resources:
      options.trace === null
        ? { [FIXTURE_IMAGE_ID]: image }
        : {
            [FIXTURE_IMAGE_ID]: image,
            [FIXTURE_TRACE_ID]: trace,
            "tutorial-trace": parseJsonText(JSON.stringify(tutorialTrace)),
          },
    maps: {
      [FIXTURE_MAP_ID]: savedMap,
      ...Object.fromEntries(
        (["base", "head"] as const).map((side) => [
          `tutorial-map-${side}`,
          parseJsonText(
            JSON.stringify({
              ...defineSoftwareMap(mapInputSchema.parse(tutorialModel)),
              side,
              commit: side,
              countsByElementPath: {},
              unmappedByElementPath: {},
            }),
          ),
        ]),
      ),
    },
  });

  const request = vi.spyOn(bridge, "request");
  const container = document.createElement("div");

  if (hostStyle) container.style.cssText = hostStyle;
  document.body.append(container);
  await act(async () => {
    canvas = mount(container, {
      kind: "api",
      tutorial:
        tutorial ??
        (kind === "tutorial"
          ? {
              content: {
                reviewUuid: snapshot.reviewId,
                progress: { version: 1, checked: [], dismissed: false },
                keymap: "none",
              },
              setStep() {},
              dismiss() {},
              reopen() {},
              async selectKeymap() {},
              close() {},
            }
          : undefined),
      softwareMapEnabled: true,
      reviewId: snapshot.reviewId,
      version: 0,
      bridge,
    });
  });

  return { container, snapshot, request };
}

describe("block components", () => {
  it.each([
    {
      kind: "sequence",
      selector: ".diagram-header-title",
      label: "sequence title",
    },
    {
      kind: "flow_diagram",
      selector: ".diagram-header-title",
      label: "flow title",
    },
    {
      kind: "database_lens",
      selector: ".diagram-header-title",
      label: "database title",
    },
    {
      kind: "software_map",
      selector: ".diagram-header-title",
      label: "map title",
    },
    {
      kind: "code",
      selector: ".rendered-code-body code",
      label: "authored code",
    },
    {
      kind: "markdown",
      selector: ".rendered-code-body code",
      label: "fenced Markdown code",
    },
  ] as const)(
    "copies selected $label text for the agent",
    async ({ kind, selector }) => {
      const code = 'export const status = "queued";\n  save(status);';

      const documentBlocks: Snapshot["document"] | undefined =
        kind === "code"
          ? [
              {
                id: "block-1",
                type: "code",
                language: "ts",
                text: code,
                caption: "The new status",
              },
            ]
          : kind === "markdown"
            ? [
                {
                  id: "block-1",
                  type: "markdown",
                  markdown: "```ts\n" + code + "\n```",
                },
              ]
            : undefined;

      const { container, request } = await mountFixture(kind, {
        document: documentBlocks,
      });

      expect(
        await settled(() => container.querySelector(selector) !== null),
      ).toBe(true);
      const selected = container.querySelector(selector)!;

      const quote =
        kind === "code" || kind === "markdown" ? code : selected.textContent!;

      request.mockClear();
      request.mockResolvedValueOnce(Response.json({ text: `> ${quote}` }));

      const write = vi
        .spyOn(navigator.clipboard, "writeText")
        .mockResolvedValue();

      const selection = document.getSelection()!;
      const range = document.createRange();
      range.selectNodeContents(selected);

      try {
        await act(async () => {
          selection.removeAllRanges();
          selection.addRange(range);
          document.dispatchEvent(new Event("selectionchange"));
        });

        const copy = container.querySelector<HTMLButtonElement>(
          '[aria-label="Copy for Agent"]',
        );

        expect(copy).not.toBeNull();
        await act(async () => copy!.click());
        expect(request).toHaveBeenCalledWith(
          expect.stringContaining("/copy-context"),
          expect.objectContaining({
            method: "POST",
            body: expect.any(String),
          }),
        );
        expect(
          JSON.parse(request.mock.lastCall![1]!.body as string),
        ).toMatchObject({
          target: { kind: "text", quote },
          title: quote.slice(0, 100),
        });
        expect(write).toHaveBeenCalledWith(`> ${quote}`);
      } finally {
        selection.removeAllRanges();
        request.mockRestore();
        write.mockRestore();
      }
    },
  );

  it("keeps shipped tutorial keybindings and view buttons interactive in the JSON canvas", async () => {
    const selectKeymap = vi.fn<ReviewCanvasTutorialBridge["selectKeymap"]>(
      async () => {},
    );

    const tutorial: ReviewCanvasTutorialBridge = {
      content: {
        reviewUuid: "fixture-tutorial",
        progress: { version: 1, checked: [], dismissed: true },
        keymap: "none",
      },
      setStep() {},
      dismiss() {},
      reopen() {},
      selectKeymap,
      close() {},
    };

    const { container } = await mountFixture("tutorial", {}, tutorial, true);
    expect(
      await settled(
        () =>
          has(container, ".tutorial-keymap-picker") &&
          has(container, ".tutorial-authoring-conversation"),
      ),
    ).toBe(true);

    const vim = [
      ...container.querySelectorAll<HTMLButtonElement>(
        ".tutorial-keymap-picker button",
      ),
    ].find((button) => button.textContent === "Vim")!;

    expect(vim.disabled).toBe(false);
    await act(async () => vim.click());
    expect(selectKeymap).toHaveBeenCalledWith("vim");

    const commits = container.querySelector<HTMLButtonElement>(
      '[data-tutorial-view="commits"]',
    )!;

    expect(commits).not.toBeNull();
    await act(async () => commits.click());
    expect(
      container
        .querySelector('[aria-label="Commits"]')
        ?.getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it.each(["sequence", "database_lens", "software_map"] as const)(
    "keeps %s interactions without offering Copy for Agent",
    async (kind) => {
      const { container } = await mountFixture(kind);
      expect(await settled(() => rendered[kind](container))).toBe(true);
      const buttons = [...container.querySelectorAll("button")];
      expect(
        buttons.some((button) =>
          button.textContent?.includes("Select for Agent"),
        ),
      ).toBe(false);

      const target = container.querySelector<HTMLElement>(
        kind === "sequence"
          ? ".sequence-participant-label"
          : kind === "database_lens"
            ? ".database-lens-header"
            : ".software-map .react-flow__node",
      );

      expect(target).not.toBeNull();
      await act(async () => target!.click());
      expect(
        [...container.querySelectorAll("button")].some(
          (button) => button.textContent === "Copy for Agent",
        ),
      ).toBe(false);
    },
  );

  it("has a component for every fixture kind", () => {
    expect(Object.keys(blockComponents).sort()).toEqual(
      [...fixtures.keys()].sort(),
    );
  });

  it.each(Object.keys(rendered) as (keyof typeof rendered)[])(
    "renders the %s fixtures with their content and a finished layout",
    async (kind) => {
      const { container, snapshot } = await mountFixture(kind);

      expect(await settled(() => rendered[kind](container))).toBe(true);
      expect(text(container)).not.toContain("Layout failed");
      expect(container.querySelector("[data-block-error]")).toBeNull();

      // Every visible block, nested ones included, mounts a node with content.
      const empty = elements(snapshot.document)
        .filter((element) => !isUnit(element))
        .map((element) => element.id)
        .filter((id) => {
          const node = container.querySelector(`[data-review-node-id="${id}"]`);

          return !node || node.innerHTML.trim() === "";
        });

      expect(empty).toEqual([]);
    },
  );

  it("opens the selected call-tree frame's code", async () => {
    const { container } = await mountFixture("call_stack_diff");

    const tree = await settled(() =>
      container.querySelector('nav[aria-label="Call tree"]'),
    );

    expect(tree).not.toBeNull();
    const frames = tree!.querySelectorAll("button");
    expect([...frames].map((frame) => frame.textContent)).toEqual([
      "status = queued",
    ]);
    await act(async () => frames[0]!.click());
    expect(
      await settled(() =>
        container.querySelector('.fixture-inline-editor[data-path="order.ts"]'),
      ),
    ).not.toBeNull();
  });

  it("renders a trace quote whose trace fails to load as a placeholder, not an error", async () => {
    const { container } = await mountFixture("trace_quote", { trace: null });

    expect(
      await settled(() =>
        container.querySelector("blockquote[data-unavailable='trace']"),
      ),
    ).toBeTruthy();
    expect(text(container)).toContain("queue the order");
    expect(container.querySelector("[data-block-error]")).toBeNull();
  });
});

describe("BlockErrorBoundary", () => {
  it("contains one throwing block, reports it, and leaves its siblings rendered", async () => {
    const onError = vi.fn<(error: Error) => void>();

    const Broken = () => {
      throw new Error("bad props reached render");
    };

    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    vi.spyOn(console, "error").mockImplementation(() => {});

    await act(async () => {
      root.render(
        <>
          <BlockErrorBoundary type="markdown" onError={onError}>
            <p>Healthy sibling</p>
          </BlockErrorBoundary>
          <BlockErrorBoundary type="database_lens" onError={onError}>
            <Broken />
          </BlockErrorBoundary>
        </>,
      );
    });

    expect(text(container)).toContain("Healthy sibling");
    expect(
      container.querySelector(
        "[role='alert'][data-block-error='database_lens']",
      )?.textContent,
    ).toContain("bad props reached render");
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]![0].message).toBe("bad props reached render");
    await act(async () => root.unmount());
    vi.restoreAllMocks();
  });
});

describe("tutorial guide placement", () => {
  it("keeps the guide inside the host when status rows sit above the document", async () => {
    const tutorial: ReviewCanvasTutorialBridge = {
      content: {
        reviewUuid: "fixture-tutorial",
        progress: { version: 1, checked: [], dismissed: false },
        keymap: "none",
      },
      setStep() {},
      dismiss() {},
      reopen() {},
      async selectKeymap() {},
      close() {},
    };

    const { container } = await mountFixture(
      "tutorial",
      {},
      tutorial,
      true,
      "position: relative; height: 700px; overflow: hidden;",
    );

    expect(await settled(() => has(container, ".tutorial-guide"))).toBe(true);

    const contentsElement = container.querySelector(".review-toc")!;
    const appElement = container.querySelector(".review-app")!;

    const contentsOffset =
      contentsElement.getBoundingClientRect().top -
      appElement.getBoundingClientRect().top;

    const statusRow = document.createElement("p");
    statusRow.setAttribute("role", "status");
    statusRow.textContent = "Refresh failed; showing the last saved review.";
    statusRow.style.minHeight = "200px";
    container.querySelector("[data-review-api]")!.prepend(statusRow);

    const host = container.getBoundingClientRect();
    const app = container.querySelector(".review-app")!.getBoundingClientRect();
    const status = statusRow.getBoundingClientRect();

    const contents = container
      .querySelector(".review-toc")!
      .getBoundingClientRect();

    const guide = container
      .querySelector(".tutorial-guide")!
      .getBoundingClientRect();

    expect(app.bottom).toBeLessThanOrEqual(host.bottom);
    expect(app.top).toBeGreaterThanOrEqual(status.bottom);
    expect(contents.top).toBeGreaterThanOrEqual(app.top);
    expect(contents.top - app.top).toBeCloseTo(contentsOffset);
    expect(guide.top).toBeGreaterThanOrEqual(host.top);
    expect(guide.bottom).toBeLessThanOrEqual(host.bottom);
  });
});

it("opens a flow node in a full-screen tour with all its code attachments", async () => {
  const { container } = await mountFixture("flow_diagram");
  await settled(() => container.querySelector(".flow-node"));
  await act(async () =>
    container
      .querySelector(".flow-node")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true })),
  );
  expect(
    await settled(
      () =>
        container.querySelectorAll(".diagram-tour-panel .fixture-inline-editor")
          .length === 2,
    ),
  ).toBe(true);
  expect(container.querySelector(".diagram-tour-panel")?.textContent).toContain(
    "Validation",
  );
  expect(
    container.querySelector('[role="dialog"][aria-modal="true"]'),
  ).not.toBeNull();
  expect(container.querySelector(".flow-diagram aside")).toBeNull();
  await act(async () =>
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })),
  );
  expect(container.querySelector('[role="dialog"]')).toBeNull();
  expect(container.querySelector(".flow-node")).not.toBeNull();
});
