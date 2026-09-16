// @vitest-environment jsdom
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

import { Hono } from "hono";
import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import {
  listLegacyReviewFixtures,
  readLegacyReviewGolden,
} from "../../src/fixtures/legacy-reviews/legacy-review-fixture";
import { documentSchema, elements } from "../../src/review-api/document";
import { createReviewApi } from "../../src/review-api/http";
import { ReviewStore } from "../../src/review-api/store";
import { mountReviewCanvas as mount } from "./desktop-entry";
import { testReviewBridge } from "./review-session-test-utils";

let store: ReviewStore, directory: string;

let canvas: ReturnType<typeof mount> | undefined;

const pins = { repositoryId: "repo", base: "base", head: "head" };

// A lens routes its edges through libavoid's wasm, which the desktop serves
// over the review API; the test hands the canvas the file on disk.
const wasmUrl = path.join(
  path.dirname(
    createRequire(import.meta.url).resolve("@mr_mint/elkjs-libavoid"),
  ),
  "libavoid.wasm",
);

/** The title heading of each archived review's golden document. */
const phrases = {
  "schema4-bug-report-dialog": "Bug reports: screenshots and simpler consent",
  "schema4-opencode-agentserver": "OpenCode on AgentServer",
  "schema4-three-minute-tour": "Review Desktop: three-minute tour",
};

beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), "review-real-"));
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
});

afterEach(async () => {
  await act(async () => canvas?.dispose());
  canvas = undefined;
  await store.close();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  rmSync(directory, { recursive: true, force: true });
});

it.each(listLegacyReviewFixtures().map((fixture) => fixture.name))(
  "imports and renders the real review %s through the JSON canvas",
  async (name) => {
    const golden = documentSchema.parse(
      await readLegacyReviewGolden(name, "blocks"),
    );

    const reviewId = `real-${name}`;
    await store.importVersion({
      reviewId,
      title: name,
      pins,
      document: golden,
      createdAt: new Date().toISOString(),
    });

    const app = new Hono().route("/reviews-api", createReviewApi(store));
    app.get("/reviews-api/:id/commits", (context) => context.json([]));

    const container = document.createElement("div");
    document.body.append(container);
    await act(async () => {
      canvas = mount(container, {
        kind: "api",
        reviewId,
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

    await act(async () => {
      await vi.waitFor(() =>
        expect(container.textContent).toContain(
          phrases[name as keyof typeof phrases],
        ),
      );
    });
    expect(container.textContent).not.toContain("Layout failed");

    // No golden collapses a section, so every block must be in the DOM.
    const missing = elements(store.read(reviewId).document)
      .filter(
        (element) =>
          element.type !== "step" &&
          !container.querySelector(`[data-review-node-id="${element.id}"]`),
      )
      .map((element) => element.id);

    expect(missing).toEqual([]);
  },
);
