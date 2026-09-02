import { describe, expect, it } from "vitest";

import type { LiveReviewPage } from "../../src/live-review-types";
import { createLiveReviewDocument } from "./live-review-renderer";

describe("live Review renderer", () => {
  it("keeps one React component identity across accepted page updates", () => {
    const first = createLiveReviewDocument(fixturePage("First"));
    const second = createLiveReviewDocument(fixturePage("Second"));

    expect(second.Component).toBe(first.Component);
    expect(second.filePath).toBe(first.filePath);
    expect(second.liveSpec).not.toBe(first.liveSpec);
  });
});

function fixturePage(title: string): LiveReviewPage {
  return {
    id: "review-1",
    rootNodeId: "root",
    nodes: {
      root: { id: "root", title, source: "", children: [] },
    },
    version: title === "First" ? 0 : 1,
    updatedAt: "2026-09-02T00:00:00.000Z",
    projection: {
      root: "root",
      elements: {
        root: {
          type: "ReviewNode",
          props: { nodeId: "root", depth: 0, title },
          children: [],
        },
      },
    },
  };
}
