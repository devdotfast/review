// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

import { CodexSelectionSchema } from "../../src/codex-selection";
import { CodexSelectionProvider, useCodexSelection } from "./codex-context";
import { ReviewSessionProvider } from "./host/review-session";
import { testReviewSession } from "./review-session-test-utils";
import { buildDocumentTextTarget } from "./target-fingerprint";

it("shares only when enabled, retains selection on window blur, and clears on revision change", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  const session = testReviewSession();
  const published: ReturnType<typeof CodexSelectionSchema.parse>[] = [];
  vi.spyOn(session, "fetch").mockImplementation(async (_url, init) => {
    published.push(CodexSelectionSchema.parse(JSON.parse(String(init?.body))));

    return new Response(
      JSON.stringify({
        connected: true,
        context: "Published context\nincluding metadata",
      }),
    );
  });
  const ask = vi.spyOn(session.bridge.comments, "askAgent");
  const save = vi.spyOn(session.bridge.comments, "saveComment");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  function Pick() {
    const select = useCodexSelection();

    return (
      <button
        onClick={() =>
          select({
            title: "Selected prose",
            target: buildDocumentTextTarget({
              text: "a selected paragraph",
              start: 2,
              length: 8,
            }),
          })
        }
      >
        Select prose
      </button>
    );
  }

  const render = (revision: string) =>
    root.render(
      <ReviewSessionProvider session={session}>
        <CodexSelectionProvider revision={revision}>
          <Pick />
        </CodexSelectionProvider>
      </ReviewSessionProvider>,
    );

  const tick = () =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });

  try {
    await act(async () => render("one"));
    await act(async () => container.querySelector("button")!.click());
    await tick();
    expect(published.every((p) => p.selection === null)).toBe(true);
    await act(async () =>
      container.querySelector<HTMLInputElement>("input")!.click(),
    );
    await tick();
    expect(published.at(-1)?.selection?.target).toMatchObject({
      kind: "text",
      selection: { quote: "selected" },
    });
    await act(async () => window.dispatchEvent(new Event("blur")));
    await tick();
    expect(published.at(-1)?.selection?.title).toBe("Selected prose");
    await act(async () => render("two"));
    await tick();
    expect(published.at(-1)?.selection).toBeNull();
    expect(ask).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});
