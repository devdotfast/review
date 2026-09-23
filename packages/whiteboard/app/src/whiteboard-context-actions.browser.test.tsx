import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WhiteboardSessionProvider } from "./host/whiteboard-session";
import { WhiteboardProvider, useWhiteboard } from "./whiteboard-context";
import { testWhiteboardSession } from "./whiteboard-session-test-utils";

const roots: Array<ReturnType<typeof createRoot>> = [];

let review: ReturnType<typeof useWhiteboard> | null = null;

function CaptureWhiteboard() {
  review = useWhiteboard();

  return null;
}

describe("WhiteboardProvider session facts", () => {
  beforeEach(() => {
    review = null;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(async () => {
    await act(async () => {
      for (const root of roots.splice(0)) root.unmount();
    });
    document.body.replaceChildren();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("uses the pins from the displayed native review", async () => {
    vi.stubGlobal("fetch", undefined);

    const statusSession = testWhiteboardSession();
    statusSession.review!.pins = { base: "base-sha", head: "head-sha" };

    await renderProvider(statusSession);

    await vi.waitFor(() => {
      expect(requireWhiteboard()).toMatchObject({
        submissionOutcome: null,
        resolvedBaseRef: "base-sha",
        resolvedHeadRef: "head-sha",
      });
    });
  });
});

async function renderProvider(
  whiteboardSession: ReturnType<typeof testWhiteboardSession>,
) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(
      <WhiteboardSessionProvider session={whiteboardSession}>
        <WhiteboardProvider>
          <CaptureWhiteboard />
        </WhiteboardProvider>
      </WhiteboardSessionProvider>,
    );
    await Promise.resolve();
    await Promise.resolve();
  });
}

function requireWhiteboard(): ReturnType<typeof useWhiteboard> {
  if (!review) throw new Error("Review context was not captured");

  return review;
}
