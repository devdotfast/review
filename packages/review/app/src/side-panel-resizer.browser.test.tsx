import { act, useRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { reviewPreferenceKey } from "./host/review-client";
import { ReviewSessionProvider } from "./host/review-session";
import { testReviewSession } from "./review-session-test-utils";
import { useRightPanelResize } from "./side-panel-resizer";

let root: ReturnType<typeof createRoot> | undefined;

let host: HTMLDivElement | undefined;

const session = testReviewSession();

function Panel({
  stateKey,
  cramped = false,
}: {
  stateKey: string;
  cramped?: boolean;
}) {
  // Exercise the pre-layout path with an explicit zero-width container.
  const containerRef = useRef<HTMLElement | null>(null);

  const resize = useRightPanelResize({
    stateKey,
    defaultWidth: 360,
    minWidth: 360,
    maxWidth: 920,
    minMainWidth: 560,
    separatorWidth: 10,
    label: "Resize test panel",
    containerRef: cramped ? containerRef : undefined,
  });

  return (
    <section ref={containerRef} style={cramped ? { width: 0 } : undefined}>
      <div className="side-panel-resizer" {...resize.separatorProps} />
    </section>
  );
}

function separator(): HTMLDivElement {
  const element = host?.querySelector<HTMLDivElement>(".side-panel-resizer");

  if (!element) throw new Error("Separator not rendered.");

  return element;
}

function widenWithKeyboard() {
  act(() => {
    separator().dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }),
    );
  });
}

function mountPanel(stateKey: string, options: { cramped?: boolean } = {}) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root?.render(
      <ReviewSessionProvider session={session}>
        <Panel stateKey={stateKey} cramped={options.cramped} />
      </ReviewSessionProvider>,
    );
  });
}

function unmountPanel() {
  act(() => {
    root?.unmount();
  });
  root = undefined;
  host?.remove();
  host = undefined;
}

beforeEach(() => {
  // Control ResizeObserver delivery so the resize behavior is deterministic.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private readonly callback: () => void) {}
      observe() {
        this.callback();
      }
      disconnect() {}
    },
  );
  window.localStorage.clear();
});

afterEach(() => {
  if (root) unmountPanel();
  window.localStorage.clear();
});

describe("useRightPanelResize persistence", () => {
  it("restores the width a reader set after the panel remounts", () => {
    mountPanel("test-panel-width");
    expect(separator().getAttribute("aria-valuenow")).toBe("360");
    widenWithKeyboard();
    expect(separator().getAttribute("aria-valuenow")).toBe("392");
    unmountPanel();

    mountPanel("test-panel-width");
    expect(separator().getAttribute("aria-valuenow")).toBe("392");
  });

  it("does not let a container too small to honour the width overwrite it", () => {
    mountPanel("test-panel-width");
    widenWithKeyboard();
    widenWithKeyboard();

    const requested = window.localStorage.getItem(
      reviewPreferenceKey("ui", "test-panel-width"),
    );

    expect(requested).toBe("424");
    unmountPanel();

    // Mounting against an unlaid-out container clamps the rendered width to the
    // minimum, but must leave the remembered width alone.
    mountPanel("test-panel-width", { cramped: true });
    expect(separator().getAttribute("aria-valuenow")).toBe("360");
    unmountPanel();

    mountPanel("test-panel-width");
    expect(separator().getAttribute("aria-valuenow")).toBe("424");
  });

  it("stores nothing for a panel the reader never resized", () => {
    mountPanel("test-panel-width");
    expect(
      window.localStorage.getItem(
        reviewPreferenceKey("ui", "test-panel-width"),
      ),
    ).toBeNull();

    widenWithKeyboard();
    expect(
      window.localStorage.getItem(
        reviewPreferenceKey("ui", "test-panel-width"),
      ),
    ).toBe("392");
  });

  it("keeps each panel's width separate", () => {
    mountPanel("test-panel-width");
    widenWithKeyboard();
    unmountPanel();

    mountPanel("other-panel-width");
    expect(separator().getAttribute("aria-valuenow")).toBe("360");
  });
});
