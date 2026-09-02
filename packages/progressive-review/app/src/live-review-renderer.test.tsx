// @vitest-environment jsdom

import type { ReviewAuthoringTarget } from "@dev.fast/review-protocol";
import { type ReactNode, act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";

import type { LiveReviewPage } from "../../src/live-review-types";
import { ReviewSessionProvider } from "./host/review-session";
import {
  LiveReviewAuthoringTargetContext,
  ReviewNode,
  createLiveReviewDocument,
} from "./live-review-renderer";
import { testReviewSession } from "./review-session-test-utils";

const activeClass = "review-live-node--authoring-active";
const nestedTarget: ReviewAuthoringTarget = {
  targetNodeId: "nested",
  sectionNodeId: "section",
};

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe("live Review renderer", () => {
  it("keeps one React component identity across accepted page updates", () => {
    const first = createLiveReviewDocument(fixturePage("First"));
    const second = createLiveReviewDocument(fixturePage("Second"));

    expect(second.Component).toBe(first.Component);
    expect(second.filePath).toBe(first.filePath);
    expect(second.liveSpec).not.toBe(first.liveSpec);
  });

  it("opens stored Markdown projections created before interactive links", () => {
    const page = fixturePage("Legacy");
    page.projection.elements.root!.children = ["legacy-markdown"];
    page.projection.elements["legacy-markdown"] = {
      type: "Markdown",
      props: { source: "Stored prose" },
      children: [],
    };

    expect(() => createLiveReviewDocument(page)).not.toThrow();
  });

  it("stamps the exact target and outlines only its top-level section", () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    act(() => {
      root.render(
        <ReviewSessionProvider session={testReviewSession()}>
          <LiveReviewAuthoringTargetContext.Provider value={nestedTarget}>
            <ReviewNode nodeId="section" depth={1} title="Section">
              <ReviewNode nodeId="nested" depth={2} title="Nested" />
            </ReviewNode>
          </LiveReviewAuthoringTargetContext.Provider>
        </ReviewSessionProvider>,
      );
    });

    const section = container.querySelector('[data-review-node-id="section"]');
    const nested = container.querySelector('[data-review-node-id="nested"]');
    expect(section?.classList.contains(activeClass)).toBe(true);
    expect(section?.getAttribute("data-review-authoring-target")).toBeNull();
    expect(nested?.getAttribute("data-review-authoring-target")).toBe("true");

    act(() => root.unmount());
    container.remove();
  });

  it("visibly targets the root node", () => {
    const { container, unmount } = renderNode(
      { targetNodeId: "root", sectionNodeId: null },
      <ReviewNode nodeId="root" depth={0} title="Review" />,
    );

    const root = container.querySelector('[data-review-node-id="root"]');
    expect(root?.classList.contains(activeClass)).toBe(true);
    expect(root?.getAttribute("data-review-authoring-target")).toBe("true");
    unmount();
  });

  it("visibly targets an untitled top-level section", () => {
    const { container, unmount } = renderNode(
      { targetNodeId: "section", sectionNodeId: "section" },
      <ReviewNode nodeId="section" depth={1} />,
    );

    const section = container.querySelector('[data-review-node-id="section"]');
    expect(section?.classList.contains(activeClass)).toBe(true);
    expect(section?.getAttribute("data-review-authoring-target")).toBe("true");
    unmount();
  });
});

function renderNode(target: ReviewAuthoringTarget, node: ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <ReviewSessionProvider session={testReviewSession()}>
        <LiveReviewAuthoringTargetContext.Provider value={target}>
          {node}
        </LiveReviewAuthoringTargetContext.Provider>
      </ReviewSessionProvider>,
    );
  });
  return {
    container,
    unmount() {
      act(() => root.unmount());
      container.remove();
    },
  };
}

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
