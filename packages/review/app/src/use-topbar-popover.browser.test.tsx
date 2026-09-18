import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

import { DiffLayoutControl } from "./diff-layout-control";
import { ReviewSessionProvider } from "./host/review-session";
import { testReviewSession } from "./review-session-test-utils";

import "./styles.css";

it("keeps view tabs reachable while actions scroll and renders their popovers outside the scroll clip", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const session = testReviewSession();

  try {
    await act(async () =>
      root.render(
        <ReviewSessionProvider session={session}>
          <div
            className="review-canvas-root"
            style={{ width: 460, height: 300 }}
          >
            <div className="review-app">
              <main className="review-document-shell">
                <header className="review-topbar">
                  <div className="review-topbar-left">
                    <div className="review-segmented">
                      {["Review", "Commits", "Diff"].map((label) => (
                        <button key={label} className="review-segment">
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="review-topbar-actions">
                    <span style={{ width: 400 }}>Other toolbar actions</span>
                    <DiffLayoutControl />
                  </div>
                </header>
              </main>
            </div>
          </div>
        </ReviewSessionProvider>,
      ),
    );

    const actions = container.querySelector<HTMLElement>(
      ".review-topbar-actions",
    )!;

    const tabs = container.querySelector<HTMLElement>(".review-topbar-left")!;
    const original = tabs.getBoundingClientRect();
    expect(actions.scrollWidth).toBeGreaterThan(actions.clientWidth);
    expect(original.right).toBeLessThanOrEqual(
      actions.getBoundingClientRect().left,
    );
    actions.scrollLeft = actions.scrollWidth;

    const trigger = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Diff settings"]',
    )!;

    await act(async () => trigger.click());

    const popover = container.querySelector<HTMLElement>('[role="dialog"]')!;
    await vi.waitFor(() => {
      expect(popover.matches(":popover-open")).toBe(true);
      const bounds = popover.getBoundingClientRect();
      expect(bounds.bottom).toBeGreaterThan(
        actions.getBoundingClientRect().bottom,
      );
      expect(
        popover.contains(
          document.elementFromPoint(
            bounds.left + bounds.width / 2,
            bounds.bottom - 4,
          ),
        ),
      ).toBe(true);
      expect(tabs.getBoundingClientRect().left).toBe(original.left);
      expect(tabs.getBoundingClientRect().right).toBe(original.right);
    });
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
