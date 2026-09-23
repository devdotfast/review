import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TraceQuote } from "./trace-quote";
import {
  WhiteboardPanelProvider,
  useWhiteboardPanelStore,
} from "./whiteboard-panel";
import type { WhiteboardPanelStore } from "./whiteboard-panel-store";

interface PanelStoreRef {
  current: WhiteboardPanelStore | null;
}

describe("TraceQuote", () => {
  let root: Root | null = null;
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    if (root) {
      await act(async () => root?.unmount());
      root = null;
    }

    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it("renders inert span when outside WhiteboardPanelProvider without breaking rules of hooks", () => {
    const html = renderToStaticMarkup(
      <TraceQuote sessionId="72b3d130-1234-5678-abcd-0123456789ab">
        Optimize database queries
      </TraceQuote>,
    );

    expect(html).toContain("whiteboard-trace-quote--inert");
    expect(html).toContain("Optimize database queries");
  });

  it("renders active link when inside WhiteboardPanelProvider", () => {
    const html = renderToStaticMarkup(
      <WhiteboardPanelProvider>
        <TraceQuote sessionId="72b3d130-1234-5678-abcd-0123456789ab">
          Optimize database queries
        </TraceQuote>
      </WhiteboardPanelProvider>,
    );

    expect(html).toContain('class="whiteboard-trace-quote"');
    expect(html).toContain("Optimize database queries");
    expect(html).not.toContain("whiteboard-trace-quote--inert");
  });

  it("replaces the active panel when opened", async () => {
    const storeRef: PanelStoreRef = { current: null };

    function TestConsumer() {
      storeRef.current = useWhiteboardPanelStore();

      return <TraceQuote sessionId="session-1">Inspect this trace</TraceQuote>;
    }

    await act(async () => {
      root?.render(
        <WhiteboardPanelProvider>
          <TestConsumer />
        </WhiteboardPanelProvider>,
      );
    });
    act(() =>
      storeRef.current?.getState().openPeek({
        kind: "peek",
        content: { kind: "inline-code", text: "start();" },
      }),
    );

    await act(async () => {
      container
        .querySelector<HTMLElement>(".whiteboard-trace-quote")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(storeRef.current?.getState().active).toMatchObject({
      kind: "peek",
      content: {
        kind: "trace-quote",
        sessionId: "session-1",
        quote: "Inspect this trace",
      },
    });
  });

  it("scrolls to the target quote mark when already open", async () => {
    const scrollCalls: Element[] = [];
    Element.prototype.scrollIntoView = vi
      .fn<typeof Element.prototype.scrollIntoView>()
      .mockImplementation(function (this: Element) {
        scrollCalls.push(this);
      });

    const targetTurn = document.createElement("div");
    targetTurn.id = "whiteboard-trace-target-event";
    const quoteMark = document.createElement("mark");
    quoteMark.className = "whiteboard-trace-quote-mark";
    targetTurn.append(quoteMark);
    document.body.append(targetTurn);

    let storeRef: ReturnType<typeof useWhiteboardPanelStore> | null = null;

    function TestConsumer() {
      storeRef = useWhiteboardPanelStore();

      return (
        <TraceQuote sessionId="session-1">Optimize database queries</TraceQuote>
      );
    }

    await act(async () => {
      root?.render(
        <WhiteboardPanelProvider>
          <TestConsumer />
        </WhiteboardPanelProvider>,
      );
    });

    // Manually open the quote so isOpen becomes true
    act(() => {
      storeRef?.getState().openPeek({
        kind: "peek",
        content: {
          kind: "trace-quote",
          sessionId: "session-1",
          quote: "Optimize database queries",
        },
      });
    });

    const link = container.querySelector(
      ".whiteboard-trace-quote",
    ) as HTMLElement;

    expect(link).not.toBeNull();

    // Click while already open
    await act(async () => {
      link.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(scrollCalls).toContain(quoteMark);
  });
});
