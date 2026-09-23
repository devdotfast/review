import type {
  WhiteboardSurfaceEvent,
  WhiteboardVerbRequest,
} from "@dev.fast/whiteboard-protocol";
import { describe, expect, it, vi } from "vitest";

import { testWhiteboardBridge } from "../whiteboard-session-test-utils";
import { createWhiteboardSurface } from "./whiteboard-host";

describe("review surface", () => {
  it("calls the typed workbench bridge directly", () => {
    const posted: WhiteboardVerbRequest[] = [];
    const listeners = new Set<(event: WhiteboardSurfaceEvent) => void>();
    const ready = vi.fn<() => void>();

    const bridge = testWhiteboardBridge(
      {},
      {
        post: async (request) => {
          posted.push(request);

          return { ok: true };
        },
        subscribe: (listener) => {
          listeners.add(listener);

          return { dispose: () => listeners.delete(listener) };
        },
        ready,
      },
    );

    const whiteboardSurface = createWhiteboardSurface(bridge);
    const events: WhiteboardSurfaceEvent[] = [];

    const unsubscribe = whiteboardSurface.subscribe((event) =>
      events.push(event),
    );

    bridge.ready();
    whiteboardSurface.openFileDiff({
      path: "src/new.ts",
      previousPath: "src/old.ts",
      status: "renamed",
      additions: 1,
      deletions: 1,
    });
    whiteboardSurface.revealAnchor(
      "src/old.ts",
      { fromLine: 7, toLine: 9 },
      "base",
    );

    for (const listener of listeners) {
      listener({ event: "themeChanged", theme: "dark" });
    }

    expect(ready).toHaveBeenCalledOnce();
    expect(posted).toEqual([
      {
        name: "openDiff",
        args: { path: "src/new.ts", previousPath: "src/old.ts" },
      },
      {
        name: "reveal",
        args: {
          path: "src/old.ts",
          startLine: 7,
          endLine: 9,
          side: "base",
          highlight: true,
          preserveFocus: false,
        },
      },
    ]);
    expect(events).toEqual([{ event: "themeChanged", theme: "dark" }]);
    unsubscribe();
  });
});
