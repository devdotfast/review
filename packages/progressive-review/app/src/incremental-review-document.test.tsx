// @vitest-environment jsdom

import type {
  ReviewDocumentSnapshot,
  ReviewDocumentStoreBridge,
} from "@dev.fast/review-protocol";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { IncrementalReviewDocument } from "./incremental-review-document";

class TestDocumentStore implements ReviewDocumentStoreBridge {
  private readonly listeners = new Set<() => void>();

  constructor(private snapshot: ReviewDocumentSnapshot) {}

  getSnapshot(): ReviewDocumentSnapshot {
    return this.snapshot;
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  replace(snapshot: ReviewDocumentSnapshot): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }
}

const roots: Array<ReturnType<typeof createRoot>> = [];

afterEach(() => {
  act(() => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.innerHTML = "";
});

describe("incremental review document", () => {
  it("preserves unchanged keyed DOM while applying document snapshots", () => {
    const firstNode = {
      id: "overview",
      kind: "markdown" as const,
      content: "# Overview",
    };
    const store = new TestDocumentStore(
      snapshot(1, [
        firstNode,
        { id: "details", kind: "markdown", content: "Initial details" },
      ]),
    );
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    act(() => root.render(<IncrementalReviewDocument store={store} />));

    const overview = container.querySelector(
      '[data-review-node-id="overview"]',
    );
    const details = container.querySelector('[data-review-node-id="details"]');
    expect(overview).not.toBeNull();
    expect(details?.textContent).toContain("Initial details");

    act(() => {
      store.replace(
        snapshot(2, [
          { id: "intro", kind: "callout", title: "Note", content: "Inserted" },
          firstNode,
          { id: "details", kind: "markdown", content: "Updated details" },
        ]),
      );
    });

    expect(container.querySelector('[data-review-node-id="overview"]')).toBe(
      overview,
    );
    expect(container.querySelector('[data-review-node-id="details"]')).toBe(
      details,
    );
    expect(details?.textContent).toContain("Updated details");
    expect(
      container
        .querySelector(".review-incremental-document")
        ?.getAttribute("data-review-document-revision"),
    ).toBe("2");
  });

  it("renders callout and code node kinds without evaluating document source", () => {
    const store = new TestDocumentStore(
      snapshot(1, [
        {
          id: "warning",
          kind: "callout",
          tone: "warning",
          title: "Heads up",
          content: "**Check** the migration.",
        },
        {
          id: "example",
          kind: "code",
          language: "ts",
          content: "const ready = true;",
        },
      ]),
    );
    const container = document.createElement("div");
    const root = createRoot(container);
    roots.push(root);
    act(() => root.render(<IncrementalReviewDocument store={store} />));

    expect(container.querySelector("strong")?.textContent).toBe("Heads up");
    expect(container.innerHTML).toContain("<strong>Check</strong>");
    expect(
      container.querySelector("[data-language='ts']")?.textContent,
    ).toContain("const ready = true;");
  });
});

function snapshot(
  revision: number,
  nodes: NonNullable<ReviewDocumentSnapshot["nodes"]>,
): ReviewDocumentSnapshot {
  return {
    reviewId: "123e4567-e89b-42d3-a456-426614174000",
    routePath: "/",
    mode: "incremental",
    revision,
    sourceHash: `hash-${revision}`,
    source: "",
    nodes,
  };
}
