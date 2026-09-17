// @vitest-environment jsdom
import { randomUUID } from "node:crypto";

import { Hono } from "hono";
import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";

import { createReviewApi } from "../../src/review-api/http";
import { ReviewStore } from "../../src/review-api/store";
import { mountReviewCanvas } from "./desktop-entry";
import { testReviewBridge } from "./review-session-test-utils";

let canvas: ReturnType<typeof mountReviewCanvas> | undefined;

let store: ReviewStore;

afterEach(async () => {
  await act(async () => canvas?.dispose());
  await store?.close();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

it("exposes JSON section and Markdown headings plus imported PR and stack navigation", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
      unobserve() {}
    },
  );
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  store = new ReviewStore(":memory:", {
    validatePins: async () => {},
    validateSource: async () => {},
    validateResource: async () => {},
  });
  const reviewId = randomUUID();
  await store.importVersion({
    reviewId,
    title: "Navigation",
    pins: { repositoryId: "repo", base: "base", head: "head" },
    createdAt: new Date().toISOString(),
    origin: {
      pullRequestNumber: 42,
      pullRequestUrl: "https://github.com/example/repo/pull/42",
    },
    document: [
      { type: "markdown", markdown: "## Summary\n\nText\n\n### **Details**" },
      {
        type: "section",
        title: "Implementation",
        children: [{ type: "markdown", markdown: "## Details\n\nNested text" }],
      },
    ],
  });
  const app = new Hono();
  app.get("/reviews-api/:id/stack", (c) =>
    c.json({
      layers: [
        {
          branch: "first",
          pullRequestNumber: 41,
          pullRequestUrl: null,
          reviewUuid: "11111111-1111-4111-8111-111111111111",
          reviewTitle: "Earlier",
          relation: "earlier",
        },
        {
          branch: "second",
          pullRequestNumber: 42,
          pullRequestUrl: null,
          reviewUuid: reviewId,
          reviewTitle: "Navigation",
          relation: "current",
        },
      ],
    }),
  );
  app.route("/reviews-api", createReviewApi(store));
  app.get("/reviews-api/:id/commits", (c) => c.json([]));
  const post = vi.fn<() => Promise<{ ok: true }>>(async () => ({ ok: true }));

  const bridge = testReviewBridge(
    {},
    {
      request: async (url, init) => app.request(url, init),
      post,
      diffView: {
        files: async () => [],
        create: () => {
          throw new Error("Unused");
        },
      },
    },
  );

  const container = document.createElement("div");
  document.body.append(container);
  await act(async () => {
    canvas = mountReviewCanvas(container, { kind: "api", reviewId, bridge });
  });
  await act(async () => {
    await vi.waitFor(() =>
      expect(container.textContent).toContain("Nested text"),
    );
  });
  expect(
    container.querySelector('a[href="https://github.com/example/repo/pull/42"]')
      ?.textContent,
  ).toContain("42");
  const headings = [...container.querySelectorAll("article h2, article h3")];
  expect(headings.map((heading) => heading.textContent)).toEqual([
    "Summary",
    "Details",
    "Implementation",
    "Details",
  ]);
  // The slugs legacy MDX published, so imported `#fragment` links still land.
  expect(headings.map((heading) => heading.id)).toEqual([
    "summary",
    "details",
    "implementation",
    "details-2",
  ]);

  const contents =
    container.querySelector<HTMLButtonElement>(".review-toc-toggle")!;

  expect(contents).toBeTruthy();
  await act(async () => contents.click());

  const links = [
    ...container.querySelectorAll<HTMLButtonElement>(".review-toc-link"),
  ];

  expect(
    links.map((link) => link.querySelector(".review-toc-text")?.textContent),
  ).toEqual(headings.map((heading) => heading.textContent));
  const scroll = vi.fn<() => void>();
  container.querySelectorAll<HTMLElement>("*").forEach((element) => {
    element.scrollTo = scroll;
    element.scrollIntoView = scroll;
  });

  for (const link of links) await act(async () => link.click());
  expect(scroll).toHaveBeenCalledTimes(4);
  expect(container.textContent).toContain("2 of 2");
});
