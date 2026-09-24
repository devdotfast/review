import type { ReviewTooltipOptions } from "@dev.fast/review-protocol";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

import type { CoverageProgress } from "../../src/viewed-coverage";
import { ReviewSessionProvider } from "./host/review-session";
import { testReviewSession } from "./review-session-test-utils";
import { ViewedButton } from "./viewed-button";

const counts = (additions: number, deletions: number) => ({
  additions,
  deletions,
});

const progress = (
  state: CoverageProgress["state"],
  total: number,
): CoverageProgress => ({
  state,
  total: counts(total, 0),
  remaining: counts(state === "viewed" ? 0 : total, 0),
  folded: counts(0, 0),
});

async function render(value: CoverageProgress, onClick = () => {}) {
  const tooltips = new Map<HTMLElement, ReviewTooltipOptions | undefined>();

  const session = testReviewSession(
    {},
    {
      setupTooltip(target, _text, options) {
        tooltips.set(target, options);

        return { dispose: () => tooltips.delete(target) };
      },
    },
  );

  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  await act(async () =>
    root.render(
      <ReviewSessionProvider session={session}>
        <ViewedButton progress={value} label="Tests" onClick={onClick} />
      </ReviewSessionProvider>,
    ),
  );

  return {
    box: container.querySelector("button")!,
    tooltips,
    cleanup: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

it("a partly viewed box reads as mixed, toggles on click and shows its tooltip instantly", async () => {
  const onClick = vi.fn<() => void>();

  const { box, tooltips, cleanup } = await render(
    progress("partial", 4),
    onClick,
  );

  try {
    expect(box.getAttribute("aria-checked")).toBe("mixed");
    expect(box.getAttribute("aria-label")).toBe("Mark viewed: Tests");
    expect(tooltips.get(box)?.instant).toBe(true);
    box.click();
    expect(onClick).toHaveBeenCalledOnce();
  } finally {
    await cleanup();
  }
});

it("a box with nothing to view is disabled and offers no tooltip", async () => {
  const { box, tooltips, cleanup } = await render(progress("unread", 0));

  try {
    expect(box.disabled).toBe(true);
    expect(tooltips.size).toBe(0);
  } finally {
    await cleanup();
  }
});
