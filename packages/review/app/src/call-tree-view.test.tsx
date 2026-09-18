// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Frame } from "../../src/review-api/document";
import { DocumentCallTree } from "./call-tree-view";
import { ReviewPanelProvider, useReviewPanel } from "./review-panel";
import type { ReviewPanelStoreState } from "./review-panel-store";
import {
  reviewSessionElement,
  testReviewSession,
} from "./review-session-test-utils";

const frame = (
  id: string,
  side: "base" | "head" = "head",
  via?: Frame["via"],
): Frame => {
  const frame: Frame = {
    id,
    key: id,
    label: `Frame ${id}`,
    source: {
      file: `src/${id}.ts`,
      start: { side, line: 4 },
      end: { side, line: 9 },
    },
  };

  if (via) frame.via = via;

  return frame;
};

let root: ReturnType<typeof createRoot> | undefined;

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
});

describe("DocumentCallTree", () => {
  it("opens a removed frame on the base side from the shared tree", async () => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    const opened = vi.fn<(active: ReviewPanelStoreState["active"]) => void>();

    function PanelSpy() {
      const active = useReviewPanel((state) => state.active);

      if (active) opened(active);

      return null;
    }

    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root!.render(
        reviewSessionElement(
          testReviewSession(),
          <ReviewPanelProvider detailRevision={0}>
            <PanelSpy />
            <DocumentCallTree
              block={{
                type: "call_stack_diff",
                id: "checkout",
                title: "Checkout",
                base: [
                  frame("reconcile"),
                  {
                    ...frame("auth", "base"),
                    contextSources: [
                      {
                        file: "context.ts",
                        start: { side: "head", line: 1 },
                        end: { side: "head", line: 2 },
                      },
                    ],
                    callSite: {
                      file: "caller.ts",
                      start: { side: "base", line: 12 },
                      end: { side: "base", line: 12 },
                    },
                  },
                ],
                head: [
                  frame("reconcile"),
                  frame("enqueue", "head", {
                    kind: "queue",
                    reason: "via the workqueue",
                  }),
                ],
              }}
            />
          </ReviewPanelProvider>,
        ),
      );
    });

    const removed = container.querySelector<HTMLButtonElement>(
      '[data-review-anchor-id="auth"]',
    )!;

    await act(async () => {
      removed.click();
    });

    expect(opened).toHaveBeenLastCalledWith(
      expect.objectContaining({
        kind: "peek",
        anchor: expect.objectContaining({ id: "auth", title: "Frame auth" }),
        content: {
          kind: "source",
          source: {
            file: "src/auth.ts",
            start: { side: "base", line: 4 },
            end: { side: "base", line: 9 },
          },
        },
      }),
    );

    const edge = container.querySelector(
      '[aria-label="Go to call site of Frame auth"]',
    )!;
    await act(async () => {
      edge.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
    expect(opened).toHaveBeenLastCalledWith(
      expect.objectContaining({
        content: {
          kind: "source",
          source: {
            file: "caller.ts",
            start: { side: "base", line: 12 },
            end: { side: "base", line: 12 },
          },
        },
      }),
    );
  });
});
