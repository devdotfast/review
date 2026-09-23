// @vitest-environment jsdom
import { randomUUID } from "node:crypto";

import { Hono } from "hono";
import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { createSessionApi } from "../../src/review-api/http";
import { SessionStore } from "../../src/review-api/store";
import { mountReviewCanvas } from "./desktop-entry";
import { testReviewBridge } from "./review-session-test-utils";

let canvas: ReturnType<typeof mountReviewCanvas> | undefined;

let store: SessionStore;

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(async () => {
  await act(async () => canvas?.dispose());
  await store?.close();
  document.body.replaceChildren();
  localStorage.clear();
  sessionStorage.clear();
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
  store = new SessionStore(":memory:", {
    validatePins: async () => {},
    validateSource: async () => {},
    validateResource: async () => {},
  });
  const sessionId = randomUUID();
  await store.importVersion({
    sessionId,
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
          sessionId: "11111111-1111-4111-8111-111111111111",
          reviewTitle: "Earlier",
          relation: "earlier",
        },
        {
          branch: "second",
          pullRequestNumber: 42,
          pullRequestUrl: null,
          sessionId: sessionId,
          reviewTitle: "Navigation",
          relation: "current",
        },
      ],
    }),
  );
  app.route("/reviews-api", createSessionApi(store));
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
    canvas = mountReviewCanvas(container, { kind: "api", sessionId, bridge });
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
