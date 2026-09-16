// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

import { AgentSelectionProvider, useAgentSelection } from "./agent-selection";
import * as clipboard from "./copy-text";
import { ReviewSessionProvider } from "./host/review-session";
import { testReviewSession } from "./review-session-test-utils";

it("copies only on click or Shift+Cmd+C, reports failures, and clears on revision changes", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const session = testReviewSession();

  const fetch = vi
    .spyOn(session, "fetch")
    .mockResolvedValue(
      new Response(JSON.stringify({ text: "Review: /review.mdx\n\nselected" })),
    );

  // Each copy gets a fresh response body.
  fetch.mockImplementation(
    async () =>
      new Response(JSON.stringify({ text: "Review: /review.mdx\n\nselected" })),
  );
  const write = vi.spyOn(clipboard, "copyText").mockResolvedValue(true);
  const container = document.createElement("div");
  container.className = "review-canvas-root";
  const host = document.createElement("div");
  document.body.append(host);
  host.attachShadow({ mode: "open" }).append(container);
  const root = createRoot(container);

  function Pick() {
    const select = useAgentSelection();

    return (
      <article className="review-document" data-selection-scroller>
        <button
          onClick={(event) =>
            select({
              title: "Prose",
              anchor: { x: 100, y: 120 },
              anchorElement: event.currentTarget,
              target: { kind: "text", quote: "selected" },
            })
          }
        >
          Select
        </button>
      </article>
    );
  }

  const render = (revision: string) =>
    root.render(
      <ReviewSessionProvider session={session}>
        <AgentSelectionProvider revision={revision}>
          <Pick />
        </AgentSelectionProvider>
      </ReviewSessionProvider>,
    );

  const shortcut = () =>
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "C",
        metaKey: true,
        shiftKey: true,
        cancelable: true,
      }),
    );

  try {
    await act(async () => render("one"));
    await act(async () => container.querySelector("button")!.click());
    expect(fetch).not.toHaveBeenCalled();
    expect(
      container.querySelector('[aria-label="Copy for Agent"]'),
    ).not.toBeNull();

    const popover = () =>
      container.querySelector<HTMLButtonElement>(
        '[aria-label="Copy for Agent"]',
      )!;

    expect(popover().style.top).toBe("82px");
    await act(async () => {
      const scroller = container.querySelector<HTMLElement>(
        "[data-selection-scroller]",
      )!;

      scroller.scrollTop = 40;
      scroller.dispatchEvent(new Event("scroll"));
    });
    expect(popover().parentElement).toBe(
      container.querySelector("[data-selection-scroller]"),
    );
    expect(popover().style.top).toBe("82px");
    await act(async () => {
      const scroller = container.querySelector<HTMLElement>(
        "[data-selection-scroller]",
      )!;

      scroller.scrollTop = 140;
      scroller.dispatchEvent(new Event("scroll"));
    });
    // Its article-relative position stays constant: scrolling is browser-owned.
    expect(popover().style.position).toBe("absolute");
    expect(popover().style.top).toBe("82px");
    expect(fetch).not.toHaveBeenCalled();
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[aria-label="Copy for Agent"]')!
        .click(),
    );
    expect(write).toHaveBeenLastCalledWith("Review: /review.mdx\n\nselected");
    expect(
      JSON.parse(fetch.mock.calls[0]![1]!.body as string),
    ).not.toHaveProperty("anchorElement");
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      "copied to clipboard",
    );
    await act(async () => {
      shortcut();
    });
    expect(write).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[aria-label="Copy for Agent"]')).toBeNull();
    write.mockResolvedValue(false);
    await act(async () => {
      shortcut();
    });
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      "Could not copy",
    );
    await act(async () => render("two"));
    expect(container.querySelector('[aria-label="Copy for Agent"]')).toBeNull();
    await act(async () => {
      shortcut();
    });
    expect(write).toHaveBeenCalledTimes(3);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});
