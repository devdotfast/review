// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Frame } from "../../src/review-api/document";
import { CallStackDiff } from "./call-stack-diff";
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
    source: { side, file: `src/${id}.ts`, fromLine: 4, toLine: 9 },
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

describe("CallStackDiff", () => {
  it("renders frames as a unified stack and opens a frame's source on click", async () => {
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
            <CallStackDiff
              title="Checkout"
              base={[frame("reconcile"), frame("auth", "base")]}
              head={[
                frame("reconcile"),
                frame("enqueue", "head", {
                  kind: "queue",
                  reason: "via the workqueue",
                }),
              ]}
            />
          </ReviewPanelProvider>,
        ),
      );
    });

    const rows = [...container.querySelectorAll(".call-stack-row")];

    expect(
      rows.map((row) => [
        row.querySelector(".call-stack-gutter")?.textContent,
        row.querySelector(".call-stack-name")?.textContent,
      ]),
    ).toEqual([
      [" ", "Frame reconcile"],
      ["-", "Frame auth"],
      ["+", "Frame enqueue"],
    ]);
    expect(container.querySelector(".call-stack-asserted")?.textContent).toBe(
      "≈ queue: via the workqueue",
    );
    expect(container.querySelector(".call-stack-hunk-label")?.textContent).toBe(
      "@@ Checkout · base → head @@",
    );

    await act(async () => {
      (rows[1] as HTMLButtonElement).click();
    });

    expect(opened).toHaveBeenLastCalledWith(
      expect.objectContaining({
        kind: "peek",
        anchor: expect.objectContaining({ id: "auth", title: "Frame auth" }),
        content: {
          kind: "source",
          source: { side: "base", file: "src/auth.ts", fromLine: 4, toLine: 9 },
        },
      }),
    );
  });
});
