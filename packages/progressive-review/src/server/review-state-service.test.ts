import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { LiveReviewPage } from "../live-review-types";
import { ReviewStateService } from "./review-state-service";

let reviewDir: string | undefined;

afterEach(async () => {
  if (reviewDir) await rm(reviewDir, { recursive: true, force: true });
  reviewDir = undefined;
});

describe("ReviewStateService", () => {
  it("persists before publishing a minimal document patch", async () => {
    reviewDir = await mkdtemp(path.join(tmpdir(), "review-state-service-"));
    const service = new ReviewStateService();
    const previous = fixturePage();
    service.initialize(reviewDir, previous);

    const listener = vi.fn();
    service.subscribe(previous.id, listener);
    const next: LiveReviewPage = {
      ...previous,
      nodes: {
        root: { ...previous.nodes.root!, children: ["new-section"] },
        "new-section": {
          id: "new-section",
          title: "New section",
          source: "## New section",
          children: [],
        },
      },
      version: 1,
      updatedAt: "2026-09-02T00:00:01.000Z",
      projection: {
        root: "root",
        elements: {
          root: {
            ...previous.projection.elements.root!,
            children: ["new-section"],
          },
          "new-section": {
            type: "ReviewNode",
            props: { nodeId: "new-section", depth: 1, title: "New section" },
            children: [],
          },
        },
      },
    };

    service.commitDocument(previous.id, reviewDir, previous, next);

    expect(service.readPage(reviewDir)).toEqual(next);
    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith({
      type: "document.committed",
      version: 1,
      updatedAt: "2026-09-02T00:00:01.000Z",
      upsertedNodes: [next.nodes.root, next.nodes["new-section"]],
      deletedNodeIds: [],
      projection: {
        root: "root",
        upsertedElements: {
          root: next.projection.elements.root,
          "new-section": next.projection.elements["new-section"],
        },
        deletedElementIds: [],
      },
    });
  });

  it("scopes subscriptions and authoring targets by review", () => {
    const service = new ReviewStateService();
    const first = vi.fn();
    const second = vi.fn();
    const unsubscribe = service.subscribe("review-1", first);
    service.subscribe("review-2", second);

    service.selectAuthoringTarget("review-1", {
      targetNodeId: "root",
      sectionNodeId: null,
    });
    unsubscribe();
    service.selectAuthoringTarget("review-1", {
      targetNodeId: "section",
      sectionNodeId: "section",
    });

    expect(first).toHaveBeenCalledOnce();
    expect(second).not.toHaveBeenCalled();
  });

  it("owns comment mutations and publishes their committed patch", async () => {
    reviewDir = await mkdtemp(path.join(tmpdir(), "review-state-service-"));
    const service = new ReviewStateService();
    const reviewPath = path.join(reviewDir, "review.mdx");
    service.initialize(reviewDir, fixturePage());
    const listener = vi.fn();
    service.subscribe("review-1", listener);

    const threads = service.threads("review-1", reviewPath, "Reviewer");
    const commit = threads.dispatch({
      command: "comment.create",
      mutationId: "mutation-1",
      input: {
        threadId: "thread-1",
        messageId: "message-1",
        target: {
          kind: "text",
          surface: {
            type: "block",
            tag: "p",
            index: 0,
            blockHash: "12345678",
          },
          selection: {
            start: 0,
            length: 6,
            hash: "12345678",
            quote: "Review",
          },
        },
        body: "One comment",
      },
    });

    expect(service.threads("review-1", reviewPath, "Other")).toBe(threads);
    expect(service.snapshot("review-1", reviewDir).threads).toHaveProperty(
      "thread-1",
    );
    expect(listener).toHaveBeenCalledWith({
      type: "threads.committed",
      commit,
    });
  });
});

function fixturePage(): LiveReviewPage {
  return {
    id: "review-1",
    rootNodeId: "root",
    nodes: {
      root: { id: "root", title: "Review", source: "", children: [] },
    },
    version: 0,
    updatedAt: "2026-09-02T00:00:00.000Z",
    projection: {
      root: "root",
      elements: {
        root: {
          type: "ReviewNode",
          props: { nodeId: "root", depth: 0, title: "Review" },
          children: [],
        },
      },
    },
  };
}
