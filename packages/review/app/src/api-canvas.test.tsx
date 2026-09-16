// @vitest-environment jsdom
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Hono } from "hono";
import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { createReviewApi } from "../../src/review-api/http";
import { ReviewStore } from "../../src/review-api/store";
import { sequenceFor } from "./api-document";
import { mountReviewCanvas as mount } from "./desktop-entry";
import { createSequenceTourEntry } from "./diagrams";
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
        children: [{ type: "markdown", markdown: "Original explanation" }],
      },
    },
  });

  const app = new Hono().route("/reviews-api", createReviewApi(store));
  app.get("/reviews-api/:id/commits", (context) => context.json([]));
  const ready = vi.fn<() => void>();
  const displayedVersion = vi.fn<(version: number) => void>();

  const bridge = testReviewBridge(
    {},
    {
      request: async (url, init) => app.request(url, init),
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
      setVersion: displayedVersion,
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

  expect(toggle).toBeTruthy();
  await act(async () => toggle.click());
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
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
    store.activity.update(review.reviewId, { action: "end", leaseId });
  });
  await vi.waitFor(async () => {
    await act(async () => {});
    expect(container.textContent).not.toContain("Agent working…");
  });
  await act(async () => {
    await command({
      type: "edit",
      reviewId: review.reviewId,
      edit: {
        type: "update",
        targetId: inserted.targetId,
        changes: { title: "Updated details" },
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
  const sequence = sequenceFor(node, { anchors: new Map() });
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

it("adds a retained trace live and opens its full conversation in the existing Trace tab", async () => {
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
  expect(traceTab()).toBeUndefined();
  await act(async () => {
    await command({
      type: "edit",
      reviewId: review.reviewId,
      edit: {
        type: "insert",
        content: {
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
});
