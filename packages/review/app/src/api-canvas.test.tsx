// @vitest-environment jsdom
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type {
  ReviewCanvasBridge,
  ReviewInlineEditorSpec,
  ReviewSurfaceEvent,
} from "@dev.fast/review-protocol";
import { Hono } from "hono";
import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { createReviewApi } from "../../src/review-api/http";
import { LocalReviewData } from "../../src/review-api/local-data";
import { ReviewStore } from "../../src/review-api/store";
import * as clipboard from "./copy-text";
import { mountReviewCanvas as mount } from "./desktop-entry";
import { createSequenceTourEntry, sequenceView } from "./diagrams";
import { testReviewBridge } from "./review-session-test-utils";

let store: ReviewStore, directory: string;

let canvas: ReturnType<typeof mount> | undefined;

const pins = { repositoryId: "repo", base: "base", head: "head" };

const command = <Operation,>(operation: Operation) =>
  store.execute({ commandId: randomUUID(), operation });

beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), "review-api-canvas-"));
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

it("mounts the existing canvas and preserves a section's DOM and collapsed state through live edits", async () => {
  const review = await command({ type: "create", title: "Live review", pins });

  const inserted = await command({
    type: "edit",
    reviewId: review.reviewId,
    edit: {
      type: "insert",
      content: {
        type: "section",
        title: "Details",
        status: "pending",
        children: [{ type: "markdown", markdown: "Original explanation" }],
      },
    },
  });

  const app = new Hono().route("/reviews-api", createReviewApi(store));
  app.get("/reviews-api/:id/commits", (context) => context.json([]));
  const requests: string[] = [];
  const ready = vi.fn<() => void>();
  const displayedVersion = vi.fn<(version: number) => void>();

  const bridge = testReviewBridge(
    {},
    {
      request: async (url, init) => {
        requests.push(new URL(url).pathname);

        return app.request(url, init);
      },
      ready,
      diffView: {
        files: async () => [],
        create: () => {
          throw new Error("Diff is not mounted by this test.");
        },
      },
    },
  );

  const container = document.createElement("div");
  document.body.append(container);
  await act(async () => {
    canvas = mount(container, {
      kind: "api",
      reviewId: review.reviewId,
      bridge,
      setSourceView: (_selection, view) => displayedVersion(view.version),
    });
  });
  await act(async () => {
    await vi.waitFor(() =>
      expect(container.textContent).toContain("Original explanation"),
    );
  });
  expect(ready).toHaveBeenCalled();
  expect(displayedVersion).toHaveBeenLastCalledWith(inserted.version);
  expect(container.querySelector("h1")?.textContent).toBe("Live review");

  const node = container.querySelector(
    `[data-review-node-id="${inserted.targetId}"]`,
  )!;

  const toggle = node.querySelector<HTMLButtonElement>(
    "button[aria-expanded]",
  )!;

  expect(
    node.querySelector(".review-section-progress")?.getAttribute("aria-label"),
  ).toBe("Pending");
  expect(toggle).toBeTruthy();
  await act(async () => toggle.click());
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(node.textContent).toContain("1 paragraph");
  const leaseId = randomUUID();
  await act(async () => {
    store.activity.update(review.reviewId, { action: "begin", leaseId });
  });
  await vi.waitFor(async () => {
    await act(async () => {});
    expect(container.textContent).toContain("Agent working…");
  });
  expect(
    container.querySelector(`[data-review-node-id="${inserted.targetId}"]`),
  ).toBe(node);
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  await act(async () => {
    store.activity.update(review.reviewId, {
      action: "renew",
      leaseId,
      focus: { targetId: inserted.targetId, description: "Adding details" },
    });
  });
  await vi.waitFor(async () => {
    await act(async () => {});
    expect(
      node.querySelector('[role="status"]')?.getAttribute("aria-label"),
    ).toContain("Adding details");
  });
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(displayedVersion).toHaveBeenLastCalledWith(inserted.version);
  await act(async () => {
    store.activity.update(review.reviewId, {
      action: "renew",
      leaseId,
      focus: { description: "Checking the outline" },
    });
  });
  await vi.waitFor(async () => {
    await act(async () => {});
    expect(
      node.querySelector('[role="status"]')?.getAttribute("aria-label"),
    ).toBe("Pending");
    expect(container.textContent).toContain("Checking the outline");
  });
  await act(async () => {
    store.activity.update(review.reviewId, { action: "end", leaseId });
  });
  await vi.waitFor(async () => {
    await act(async () => {});
    expect(container.textContent).not.toContain("Agent working…");
    expect(container.textContent).not.toContain("Checking the outline");
    expect(
      node
        .querySelector(".review-section-progress")
        ?.getAttribute("aria-label"),
    ).toBe("Pending");
  });
  await act(async () => {
    await command({
      type: "edit",
      reviewId: review.reviewId,
      edit: {
        type: "update",
        targetId: inserted.targetId,
        changes: { title: "Updated details", status: "complete" },
      },
    });
  });
  await act(async () => {
    await vi.waitFor(() =>
      expect(container.textContent).toContain("Updated details"),
    );
  });
  expect(
    container.querySelector(`[data-review-node-id="${inserted.targetId}"]`),
  ).toBe(node);
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(node.querySelector(".review-section-progress")).toBeNull();
  expect(
    node.querySelector(".review-section-header")?.textContent,
  ).not.toContain("Complete");
  const section = store.read(review.reviewId).document[0]!;

  if (section.type !== "section") throw new Error("Expected section");
  await act(async () => {
    await command({
      type: "edit",
      reviewId: review.reviewId,
      edit: {
        type: "update",
        targetId: section.children[0]!.id,
        changes: { markdown: "Original explanation\n\nAnother paragraph" },
      },
    });
  });
  await act(async () => {
    await vi.waitFor(() => expect(node.textContent).toContain("2 paragraphs"));
  });
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  await act(async () => {
    await command({
      type: "edit",
      reviewId: review.reviewId,
      edit: {
        type: "insert",
        content: {
          type: "markdown",
          markdown: "## Next section\n\n<script>window.bad = true</script>",
        },
      },
    });
  });
  await act(async () => {
    await vi.waitFor(() =>
      expect(container.textContent).toContain("Next section"),
    );
  });
  expect(container.querySelector("script")).toBeNull();
  expect(container.querySelector("h2")?.textContent).toContain(
    "Updated details",
  );
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>('button[aria-label="Version history"]')!
      .click(),
  );
  await act(async () => {
    await vi.waitFor(() =>
      expect(
        container.querySelectorAll('[role="menuitem"]').length,
      ).toBeGreaterThan(1),
    );
  });
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[role="menuitem"]')!.click(),
  );
  await act(async () => {
    await vi.waitFor(() =>
      expect(container.textContent).toContain("Back to latest"),
    );
  });
  expect(container.textContent).not.toContain("Next section");
  await act(async () => {
    store.activity.update(review.reviewId, { action: "begin", leaseId });
  });
  expect(container.textContent).not.toContain("Agent working…");
  await act(async () => {
    await command({
      type: "edit",
      reviewId: review.reviewId,
      edit: {
        type: "insert",
        content: {
          type: "markdown",
          markdown: "Written while viewing history",
        },
      },
    });
  });
  expect(container.textContent).not.toContain("Written while viewing history");

  const latest = [
    ...container.querySelectorAll<HTMLButtonElement>("button"),
  ].filter((button) => button.textContent === "Back to latest");

  expect(latest).toHaveLength(1);
  await act(async () => latest[0]!.click());
  await act(async () => {
    await vi.waitFor(() =>
      expect(container.textContent).toContain("Written while viewing history"),
    );
  });
  expect(container.textContent).toContain("Agent working…");
  expect(requests.some((route) => route.endsWith("/history"))).toBe(true);
});

it("keeps sequence step identities and supports explanation/code steps without invented source anchors", async () => {
  const review = await command({ type: "create", title: "Diagram", pins });

  const inserted = await command({
    type: "edit",
    reviewId: review.reviewId,
    edit: {
      type: "insert",
      content: {
        type: "sequence",
        title: "Flow",
        actors: { app: "App", db: "Database" },
        steps: [
          {
            from: "app",
            to: "db",
            label: "Save",
            explanation: "The server commits the edit.",
          },
          {
            from: "db",
            to: "app",
            label: "Done",
            code: { text: "return ok", language: "ts" },
            style: "return",
          },
        ],
      },
    },
  });

  const node = store.read(review.reviewId).document[0]!;

  if (node.type !== "sequence") throw new Error("Expected sequence");

  const sequence = sequenceView({
    id: node.id!,
    title: node.title,
    actors: node.actors,
    steps: node.steps,
  });

  const tour = createSequenceTourEntry(sequence);
  expect(sequence.id).toBe(inserted.targetId);
  expect(tour.stops.map((stop) => stop.anchor.id)).toEqual(
    node.steps.map((step) => step.id),
  );
  expect(tour.stops.map((stop) => stop.content)).toEqual([
    { kind: "explanation", text: "The server commits the edit." },
    { kind: "inline-code", text: "return ok", language: "ts" },
  ]);
});

it("dismisses through the API without changing the document or promising automatic deletion", async () => {
  const { reviewId } = await command({
    type: "create",
    title: "Dismiss me",
    pins,
  });

  const app = new Hono().route("/reviews-api", createReviewApi(store));
  app.get("/reviews-api/:id/commits", (context) => context.json([]));

  const bridge = testReviewBridge(
    {},
    { request: async (url, init) => app.request(url, init) },
  );

  const container = document.createElement("div");
  document.body.append(container);
  await act(async () => {
    canvas = mount(container, { kind: "api", reviewId, bridge });
  });
  await act(async () => {
    await vi.waitFor(() =>
      expect(container.querySelector("h1")?.textContent).toBe("Dismiss me"),
    );
  });

  const dismiss = [
    ...container.querySelectorAll<HTMLButtonElement>("button"),
  ].find((button) => button.textContent === "Dismiss")!;

  await act(async () => dismiss.click());

  const dialog = container.querySelector(
    '[role="dialog"][aria-label="Dismiss this review"]',
  )!;

  expect(dialog.textContent).toContain("stays saved");
  await act(async () =>
    dialog.querySelector<HTMLButtonElement>("button")!.click(),
  );
  await vi.waitFor(() =>
    expect(store.list()[0]?.dismissedAt).toEqual(expect.any(String)),
  );
  expect(store.read(reviewId).version).toBe(0);
});

it.each([false, true])(
  "adds a retained trace (inline=%s) live and opens its full conversation",
  async (inline) => {
    const review = await command({
      type: "create",
      title: "Retained conversation",
      pins,
    });

    const traceId = randomUUID();

    const trace = {
      label: "Imported authoring conversation",
      events: [
        { id: "question", role: "user", text: "Keep the original components." },
        {
          id: "answer",
          role: "assistant",
          text: "The source remains pinned while the canvas changes.",
        },
        { id: "result", role: "tool", text: "Saved successfully." },
      ],
    };

    const app = new Hono().route("/reviews-api", createReviewApi(store));
    app.get("/reviews-api/:id/commits", (context) => context.json([]));
    app.get("/reviews-api/:id/agent-traces", (context) =>
      context.json({ ok: true, sessions: [] }),
    );
    app.get(`/reviews-api/resources/${traceId}`, (context) =>
      context.json(trace),
    );

    const bridge = testReviewBridge(
      {},
      {
        request: async (url, init) => app.request(url, init),
        diffView: {
          files: async () => [],
          create: () => {
            throw new Error("Diff is not used here.");
          },
        },
      },
    );

    const container = document.createElement("div");
    document.body.append(container);
    await act(async () => {
      canvas = mount(container, {
        kind: "api",
        reviewId: review.reviewId,
        bridge,
      });
    });

    const traceTab = () =>
      [...container.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent === "Trace",
      );

    await act(async () => {
      await vi.waitFor(() =>
        expect(container.querySelector("h1")?.textContent).toBe(
          "Retained conversation",
        ),
      );
    });
    await vi.waitFor(() => expect(traceTab()).toBeUndefined());
    await act(async () => {
      await command({
        type: "edit",
        reviewId: review.reviewId,
        edit: {
          type: "insert",
          content: inline
            ? {
                type: "markdown",
                markdown: `- Before [source remains pinned](review-trace:${traceId}#answer) after.`,
              }
            : {
                type: "trace_quote",
                traceId,
                eventId: "answer",
                text: "source remains pinned",
              },
        },
      });
    });
    await act(async () => {
      await vi.waitFor(() => expect(traceTab()).toBeTruthy());
    });
    expect(container.querySelector(".review-trace-quote")).toBeTruthy();

    expect(container.querySelector("li")?.textContent).toBe(
      inline ? "Before source remains pinned after." : undefined,
    );
    await act(async () => traceTab()!.click());
    await act(async () => {
      await vi.waitFor(() =>
        expect(container.textContent).toContain(
          "Imported authoring conversation",
        ),
      );
    });
    expect(container.textContent).toContain("Keep the original components.");
    expect(container.textContent).toContain(
      "The source remains pinned while the canvas changes.",
    );
    expect(container.textContent).not.toContain("Unable to load trace");
  },
);

it("renders a code peek block on its pinned side without fetching source text", async () => {
  const review = await command({ type: "create", title: "Peek review", pins });

  await command({
    type: "edit",
    reviewId: review.reviewId,
    edit: {
      type: "insert",
      content: {
        type: "code_peek",
        source: { side: "base", file: "src/old.ts", fromLine: 7, toLine: 9 },
      },
    },
  });

  const app = new Hono().route("/reviews-api", createReviewApi(store));
  app.get("/reviews-api/:id/commits", (context) => context.json([]));
  const requested: string[] = [];
  const created: ReviewInlineEditorSpec[] = [];

  const bridge = testReviewBridge(
    {},
    {
      request: async (url, init) => {
        requested.push(String(url));

        return app.request(url, init);
      },
      inlineEditors: {
        async find() {
          return { matchCount: 0 };
        },
        create: (spec) => {
          created.push(spec);
          const editor = document.createElement("div");
          editor.className = "fixture-inline-editor";
          spec.container.appendChild(editor);

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
            onDidChangeHeight: () => ({ dispose() {} }),
            onDidError: () => ({ dispose() {} }),
            dispose: () => {
              editor.remove();
            },
          };
        },
      },
    },
  );

  const container = document.createElement("div");
  document.body.append(container);
  await act(async () => {
    canvas = mount(container, {
      kind: "api",
      reviewId: review.reviewId,
      bridge,
      setSourceView: () => {},
    });
  });
  await act(async () => {
    await vi.waitFor(() => expect(created).toHaveLength(1));
  });
  expect(created[0]).toMatchObject({
    path: "src/old.ts",
    side: "base",
    ranges: [{ startLine: 7, endLine: 9 }],
  });
  expect(requested.filter((url) => url.includes("/source"))).toEqual([]);
});

it("copies prose and code from the displayed historical JSON review", async () => {
  const review = await command({ type: "create", title: "Copy review", pins });

  const inserted = await command({
    type: "edit",
    reviewId: review.reviewId,
    edit: {
      type: "insert",
      content: { type: "markdown", markdown: "Selected historical prose" },
    },
  });

  await command({
    type: "repin",
    reviewId: review.reviewId,
    pins: { ...pins, head: "new-head" },
  });
  const data = new LocalReviewData(store);
  vi.spyOn(data, "commits").mockResolvedValue([]);
  vi.spyOn(data, "quote").mockImplementation(async (sourcePins, source) => {
    expect(source).toEqual({
      side: "head",
      file: "example.ts",
      fromLine: 2,
      toLine: 2,
    });

    return {
      ...source,
      commit: sourcePins.head,
      text: sourcePins.head === "head" ? "historical source" : "latest source",
    };
  });
  const app = new Hono().route("/reviews-api", createReviewApi(store, data));
  const listeners = new Set<Parameters<ReviewCanvasBridge["subscribe"]>[0]>();

  const bridge = testReviewBridge(
    {},
    {
      request: async (url, init) => app.request(url, init),
      subscribe: (listener) => {
        listeners.add(listener);

        return {
          dispose: () => {
            listeners.delete(listener);
          },
        };
      },
    },
  );

  const write = vi.spyOn(clipboard, "copyText").mockResolvedValue(true);
  const container = document.createElement("div");
  document.body.append(container);

  try {
    await act(async () => {
      canvas = mount(container, {
        kind: "api",
        reviewId: review.reviewId,
        version: inserted.version,
        bridge,
      });
    });
    await act(async () => {
      await vi.waitFor(() =>
        expect(container.textContent).toContain("Selected historical prose"),
      );
    });

    const prose = [...container.querySelectorAll("p")].find(
      (node) => node.textContent === "Selected historical prose",
    )!;

    const range = document.createRange();
    range.selectNodeContents(prose);
    range.getBoundingClientRect = () => new DOMRect(10, 50, 100, 20);
    document.getSelection()!.removeAllRanges();
    document.getSelection()!.addRange(range);
    await act(async () => document.dispatchEvent(new Event("selectionchange")));

    const copy = async () => {
      await act(async () =>
        container
          .querySelector<HTMLButtonElement>('[aria-label="Copy for Agent"]')!
          .click(),
      );

      return write.mock.lastCall![0];
    };

    const text = await copy();
    expect(text).toContain(
      `Review ID: ${review.reviewId}\nVersion: ${inserted.version}`,
    );
    expect(text).toContain("> Selected historical prose");
    expect(text).toContain(
      `review_get({"reviewId":"${review.reviewId}","version":${inserted.version},"full":true})`,
    );
    expect(text).not.toContain("review.mdx");

    const selected: ReviewSurfaceEvent = {
      event: "editorSelectionChanged",
      reviewId: bridge.config.reviewId,
      path: "example.ts",
      range: { fromLine: 2, toLine: 2 },
      sideContext: "head",
      isEmpty: false,
    };

    await act(async () => {
      for (const listener of listeners) listener(selected);
    });
    const code = await copy();
    expect(code).toContain("historical source");
    expect(code).toContain("example.ts:2-2 (head)");
    expect(code).not.toContain("latest source");
    expect(code).not.toContain("new-head");
    await act(async () => {
      for (const listener of listeners)
        listener({
          ...selected,
          reviewId: "another-review",
          path: "unrelated.ts",
        });
    });
    expect(container.querySelector('[aria-label="Copy for Agent"]')).toBeNull();
    await act(async () => {
      for (const listener of listeners)
        listener({
          ...selected,
          selectedDiff: {
            oldPath: "old.ts",
            newPath: "example.ts",
            oldStart: 2,
            newStart: 2,
            rows: [
              { kind: "deleted", text: "before" },
              { kind: "added", text: "after" },
            ],
          },
        });
    });
    const diff = await copy();
    expect(diff).toContain("Base: a/old.ts\nHead: b/example.ts");
    expect(diff).toContain("-before\n+after");
  } finally {
    await data.close();
    write.mockRestore();
    document.getSelection()!.removeAllRanges();
  }
});
