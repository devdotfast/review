// @vitest-environment jsdom

import type { ReviewDiffLayout } from "@dev.fast/review-protocol";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DiffLayoutControl } from "./diff-layout-control";
import { ReviewSessionProvider } from "./host/review-session";
import { testReviewSession } from "./review-session-test-utils";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe("DiffLayoutControl", () => {
  let container: HTMLDivElement;
  let root: Root;
  let layout: ReviewDiffLayout;
  let listeners: Set<(layout: ReviewDiffLayout) => void>;
  let setDiffLayout: ReturnType<
    typeof vi.fn<(next: ReviewDiffLayout) => Promise<void>>
  >;
  let posted: unknown[];

  beforeEach(async () => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    layout = "split";
    listeners = new Set();
    posted = [];
    // The desktop writes the setting and reports back through the change
    // event, so the fake applies the write the same way.
    setDiffLayout = vi.fn<(next: ReviewDiffLayout) => Promise<void>>(
      async (next) => {
        confirm(next);
      },
    );
    const session = testReviewSession(
      {},
      {
        currentDiffLayout: () => layout,
        setDiffLayout: (next) => setDiffLayout(next),
        onDidChangeDiffLayout: (listener) => {
          listeners.add(listener);
          return { dispose: () => listeners.delete(listener) };
        },
        request: async (url, init) => {
          if (url.includes("/telemetry/event"))
            posted.push(JSON.parse(String(init?.body)));
          return Response.json({ ok: true });
        },
      },
    );
    await act(async () => {
      root.render(
        <ReviewSessionProvider session={session}>
          <DiffLayoutControl />
        </ReviewSessionProvider>,
      );
    });
  });

  function confirm(next: ReviewDiffLayout) {
    layout = next;
    for (const listener of listeners) listener(next);
  }

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("shows the current layout and writes the chosen one", async () => {
    await act(async () => trigger().click());
    expect(radio("Split").getAttribute("aria-checked")).toBe("true");
    expect(radio("Unified").getAttribute("aria-checked")).toBe("false");

    await act(async () => radio("Unified").click());
    expect(setDiffLayout).toHaveBeenCalledWith("unified");
    expect(radio("Unified").getAttribute("aria-checked")).toBe("true");
    expect(radio("Split").getAttribute("aria-checked")).toBe("false");
  });

  it("shows the choice before the desktop confirms it", async () => {
    let finishWrite = () => {};
    setDiffLayout.mockImplementation(
      () => new Promise<void>((resolve) => (finishWrite = resolve)),
    );
    await act(async () => trigger().click());
    await act(async () => radio("Unified").click());
    expect(radio("Unified").getAttribute("aria-checked")).toBe("true");
    expect(layout).toBe("split");

    await act(async () => {
      confirm("unified");
      finishWrite();
    });
    expect(radio("Unified").getAttribute("aria-checked")).toBe("true");
  });

  it("drops back and reports it when the write fails", async () => {
    setDiffLayout.mockRejectedValue(new Error("settings.json is read-only"));
    await act(async () => trigger().click());
    await act(async () => radio("Unified").click());
    expect(radio("Split").getAttribute("aria-checked")).toBe("true");
    expect(radio("Unified").getAttribute("aria-checked")).toBe("false");
    expect(posted).toContainEqual(
      expect.objectContaining({
        name: "client_error",
        properties: expect.objectContaining({
          error_source: "settings",
          component: "diff_layout",
        }),
      }),
    );
  });

  it("does not rewrite the layout already in effect", async () => {
    await act(async () => trigger().click());
    await act(async () => radio("Split").click());
    expect(setDiffLayout).not.toHaveBeenCalled();
  });

  it("follows a layout change made outside the popover", async () => {
    await act(async () => trigger().click());
    // The Toggle Inline View command changes the same setting.
    await act(async () => {
      layout = "unified";
      for (const listener of listeners) listener(layout);
    });
    expect(radio("Unified").getAttribute("aria-checked")).toBe("true");
  });

  it("closes on Escape and on a pointer outside", async () => {
    await act(async () => trigger().click());
    expect(popover()).not.toBeNull();
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(popover()).toBeNull();

    await act(async () => trigger().click());
    await act(async () => {
      document.body.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true }),
      );
    });
    expect(popover()).toBeNull();
  });

  function trigger() {
    const button = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Diff settings"]',
    );
    if (!button) throw new Error("Diff settings button not found");
    return button;
  }

  function popover() {
    return container.querySelector('[role="dialog"]');
  }

  function radio(label: string) {
    const radios = [
      ...container.querySelectorAll<HTMLButtonElement>('[role="radio"]'),
    ];
    const match = radios.find((candidate) => candidate.textContent === label);
    if (!match) throw new Error(`${label} option not found`);
    return match;
  }
});
