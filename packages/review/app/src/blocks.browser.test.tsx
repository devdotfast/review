import { type JsonValue, parseJsonText } from "@dev.fast/review-protocol";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  FIXTURE_IMAGE_ID,
  FIXTURE_MAP_ID,
  FIXTURE_TRACE_EVENT_ID,
  FIXTURE_TRACE_ID,
} from "../../src/fixtures/blocks/ids";
import { documentSchema, elements } from "../../src/review-api/document";
import type { Snapshot } from "../../src/review-api/store";
import { defineSoftwareMap } from "../../src/software-map-model";
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

const text = (container: HTMLElement) => container.textContent ?? "";

const has = (container: HTMLElement, selector: string) =>
  container.querySelector(selector) !== null;

/**
 * What each kind must have rendered from its fixture. The NodeReveal wrapper
 * exists for every block, so these look inside it: real content, and for the
 * diagrams a finished layout.
 */
const rendered: Record<Kind, (container: HTMLElement) => boolean> = {
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
  // The base and head frames share a key, so the diff shows one row for both.
  call_stack_diff: (c) =>
    has(c, ".call-stack-diff[data-review-call-stack='ready']") &&
    has(c, ".call-stack-row[data-review-anchor-id='frame-2']") &&
    text(c).includes("status = queued"),
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
  software_map: (c) =>
    has(c, ".software-map-canvas") &&
    text(c).includes("Order service") &&
    !has(c, ".software-map-code-status"),
  section: (c) =>
    has(c, "button[aria-expanded='true']") && text(c).includes("Hello."),
  callout: (c) =>
    c.querySelector("blockquote[data-tone='warning'] strong")?.textContent ===
      "Note" && text(c).includes("Careful."),
};

let canvas: ReturnType<typeof mount> | undefined;

afterEach(async () => {
  await act(async () => canvas?.dispose());
  canvas = undefined;
});

async function mountFixture(kind: Kind, resources: { trace?: null } = {}) {
  const snapshot: Snapshot = {
    reviewId: `fixture-${kind}`,
    version: 0,
    title: "Fixture review",
    pins: { repositoryId: "repo", base: "base", head: "head" },
    document: fixtures.get(kind)!,
    createdAt: "2026-09-16T00:00:00.000Z",
  };

  const image = { bytes: png, type: "image/png" };

  const bridge = fixtureReviewBridge({
    snapshot,
    resources:
      resources.trace === null
        ? { [FIXTURE_IMAGE_ID]: image }
        : { [FIXTURE_IMAGE_ID]: image, [FIXTURE_TRACE_ID]: trace },
    maps: { [FIXTURE_MAP_ID]: savedMap },
  });

  const container = document.createElement("div");
  document.body.append(container);
  await act(async () => {
    canvas = mount(container, {
      kind: "api",
      softwareMapEnabled: true,
      reviewId: snapshot.reviewId,
      version: 0,
      bridge,
    });
  });

  return { container, snapshot };
}

describe("block components", () => {
  it("has a component for every fixture kind", () => {
    expect(Object.keys(blockComponents).sort()).toEqual(
      [...fixtures.keys()].sort(),
    );
  });

  it.each(Object.keys(blockComponents) as Kind[])(
    "renders the %s fixtures with their content and a finished layout",
    async (kind) => {
      const { container, snapshot } = await mountFixture(kind);

      expect(await settled(() => rendered[kind](container))).toBe(true);
      expect(text(container)).not.toContain("Layout failed");
      expect(container.querySelector("[data-block-error]")).toBeNull();

      // Every block in the fixture, nested ones included, mounts a node with content.
      const empty = elements(snapshot.document)
        .filter((element) => element.type !== "step")
        .map((element) => element.id)
        .filter((id) => {
          const node = container.querySelector(`[data-review-node-id="${id}"]`);

          return !node || node.innerHTML.trim() === "";
        });

      expect(empty).toEqual([]);
    },
  );

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
