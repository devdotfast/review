// @vitest-environment jsdom
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

import { type JsonValue, parseJsonText } from "@dev.fast/review-protocol";
import { Hono } from "hono";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  FIXTURE_IMAGE_ID,
  FIXTURE_MAP_ID,
  FIXTURE_TRACE_EVENT_ID,
  FIXTURE_TRACE_ID,
  readBlockFixtures,
} from "../../src/fixtures/blocks/fixtures";
import { documentSchema, elements } from "../../src/review-api/document";
import { createReviewApi } from "../../src/review-api/http";
import { ReviewStore } from "../../src/review-api/store";
import { blockComponents } from "./blocks";
import { mountReviewCanvas as mount } from "./desktop-entry";
import { testReviewBridge } from "./review-session-test-utils";

let store: ReviewStore, directory: string;

let canvas: ReturnType<typeof mount> | undefined;

const pins = { repositoryId: "repo", base: "base", head: "head" };

// The software map routes edges through libavoid's wasm, which the desktop
// serves over the review API; the test hands the canvas the file on disk.
const wasmUrl = path.join(
  path.dirname(
    createRequire(import.meta.url).resolve("@mr_mint/elkjs-libavoid"),
  ),
  "libavoid.wasm",
);

const command = <Operation,>(operation: Operation) =>
  store.execute({ commandId: randomUUID(), operation });

/** The store assigns ids; fixtures carry them only so tests can name blocks. */
const stripIds = (value: JsonValue): JsonValue =>
  parseJsonText(
    JSON.stringify(value, (key, child) => (key === "id" ? undefined : child)),
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
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

const savedMap = {
  side: "head",
  commit: "head",
  elements: [],
  relationships: [],
  countsByElementPath: {},
  unmappedByElementPath: {},
};

/** The element each kind must leave in the DOM; an empty render is a failure too. */
const landmarks: Record<keyof typeof blockComponents, string> = {
  markdown: "h1",
  code: "pre",
  divider: "hr",
  code_peek: "[data-review-node-id]",
  sequence: "[data-review-node-id]",
  call_stack_diff: "[data-review-node-id]",
  database_lens: "[data-review-node-id]",
  image: "figure.review-image img",
  trace_quote: "[data-review-node-id]",
  software_map: "[data-review-node-id]",
  section: "button[aria-expanded]",
  callout: "blockquote[data-tone]",
};

beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), "review-blocks-"));
  store = new ReviewStore(path.join(directory, "review.db"), {
    validatePins: async () => {},
    validateSource: async () => {},
    validateResource: async () => {},
  });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  // jsdom has no object URLs; the image loader needs both.
  URL.createObjectURL = () => "blob:fixture";
  URL.revokeObjectURL = () => {};
});

afterEach(async () => {
  await act(async () => canvas?.dispose());
  canvas = undefined;
  await store.close();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  rmSync(directory, { recursive: true, force: true });
});

async function mountFixture(
  samples: JsonValue[],
  resources: { trace?: null } = {},
) {
  const review = await command({
    type: "create",
    title: "Fixture review",
    pins,
  });

  for (const content of samples)
    await command({
      type: "edit",
      reviewId: review.reviewId,
      edit: { type: "insert", content: stripIds(content) },
    });

  const app = new Hono().route("/reviews-api", createReviewApi(store));
  app.get("/reviews-api/:id/commits", (context) => context.json([]));
  app.get(`/reviews-api/resources/${FIXTURE_TRACE_ID}`, (context) =>
    resources.trace === null
      ? context.json({ error: "missing" }, 404)
      : context.json(trace),
  );
  app.get(
    `/reviews-api/resources/${FIXTURE_IMAGE_ID}`,
    () => new Response(png, { headers: { "content-type": "image/png" } }),
  );
  app.get(`/reviews-api/:id/maps/${FIXTURE_MAP_ID}`, (context) =>
    context.json(savedMap),
  );

  const container = document.createElement("div");
  document.body.append(container);
  await act(async () => {
    canvas = mount(container, {
      kind: "api",
      reviewId: review.reviewId,
      bridge: testReviewBridge(
        { wasmUrl },
        {
          request: async (url, init) => app.request(url, init),
          diffView: {
            files: async () => [],
            create: () => {
              throw new Error("Diff is not mounted by this test.");
            },
          },
        },
      ),
    });
  });

  return container;
}

async function unmount() {
  await act(async () => canvas?.dispose());
  canvas = undefined;
  document.body.innerHTML = "";
}

describe("block components", () => {
  it("has a component for every fixture kind", async () => {
    const fixtures = await readBlockFixtures();

    expect(Object.keys(blockComponents).sort()).toEqual(
      [...fixtures.keys()].sort(),
    );
  });

  it.each(Object.keys(blockComponents) as (keyof typeof blockComponents)[])(
    "renders the %s fixtures through the real canvas without throwing",
    async (type) => {
      const samples = (await readBlockFixtures()).get(type)!;
      const container = await mountFixture(samples);

      await act(async () => {
        await vi.waitFor(() =>
          expect(container.querySelector(landmarks[type])).toBeTruthy(),
        );
      });
      expect(container.textContent).not.toContain("Layout failed");

      // Every block in the fixture, nested ones included, mounts a node.
      const blocksInFixture = elements(documentSchema.parse(samples)).filter(
        (element) => element.type !== "step",
      ).length;

      expect(container.querySelectorAll("[data-review-node-id]").length).toBe(
        blocksInFixture,
      );
      await unmount();
    },
  );

  it("renders a trace quote whose trace fails to load as a placeholder, not an error", async () => {
    const [sample] = (await readBlockFixtures()).get("trace_quote")!;
    const container = await mountFixture([sample!], { trace: null });

    await act(async () => {
      await vi.waitFor(() =>
        expect(
          container.querySelector("blockquote[data-unavailable='trace']"),
        ).toBeTruthy(),
      );
    });
    expect(container.textContent).toContain("queue the order");
    expect(container.textContent).not.toContain("Layout failed");
  });
});
