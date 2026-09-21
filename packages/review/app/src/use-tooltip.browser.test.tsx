import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";

import { ReviewSessionProvider } from "./host/review-session";
import { testReviewSession } from "./review-session-test-utils";
import { useTooltip } from "./use-tooltip";

function Control({ label }: { label: string }) {
  return <button ref={useTooltip(label)} aria-label={label} />;
}

it("replaces stale host tooltips when a label changes and removes them on unmount", async () => {
  const active = new Map<HTMLElement, string>();

  const session = testReviewSession(
    {},
    {
      setupTooltip(target, label) {
        active.set(target, label);

        return {
          dispose: () => {
            active.delete(target);
          },
        };
      },
    },
  );

  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  const render = (label: string) =>
    act(async () =>
      root.render(
        <ReviewSessionProvider session={session}>
          <Control label={label} />
        </ReviewSessionProvider>,
      ),
    );

  try {
    await render("Shared by Alice");
    const button = container.querySelector("button")!;
    expect(active.get(button)).toBe("Shared by Alice");
    expect(button.hasAttribute("title")).toBe(false);
    await render("Shared by Bob");
    expect(active.size).toBe(1);
    expect(active.get(button)).toBe("Shared by Bob");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }

  expect(active.size).toBe(0);
});

it("keeps native tooltip labels current without a Desktop host", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  try {
    await act(async () => root.render(<Control label="Share review" />));
    expect(container.querySelector("button")!.title).toBe("Share review");
    await act(async () => root.render(<Control label="Shared by Alice" />));
    expect(container.querySelector("button")!.title).toBe("Shared by Alice");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
