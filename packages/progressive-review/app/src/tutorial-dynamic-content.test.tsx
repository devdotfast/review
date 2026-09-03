// @vitest-environment jsdom

import {
  type JsonObject,
  type ReviewCanvasTutorialBridge,
} from "@dev.fast/review-protocol";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ReviewSessionProvider } from "./host/review-session";
import { ReviewProvider } from "./review-context";
import { testReviewSession } from "./review-session-test-utils";
import { TutorialProvider } from "./tutorial-context";
import {
  TutorialFeature,
  TutorialViewButton,
} from "./tutorial-dynamic-content";

const session = testReviewSession(
  {},
  { request: async () => jsonResponse({ ok: true }) },
);

const tutorial: ReviewCanvasTutorialBridge = {
  content: {
    reviewUuid: "tutorial-review",
    progress: { version: 1, checked: [], dismissed: false },
    keymap: "none",
  },
  setStep() {},
  dismiss() {},
  reopen() {},
  async selectKeymap() {},
  close() {},
};

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function render(input: { softwareMapEnabled: boolean }): string {
  return renderToStaticMarkup(
    <ReviewSessionProvider session={session}>
      <ReviewProvider softwareMapEnabled={input.softwareMapEnabled}>
        <TutorialProvider tutorial={tutorial}>
          <TutorialFeature feature="softwareMap">
            <p>Map guidance</p>
            <TutorialViewButton view="map">Open Map</TutorialViewButton>
          </TutorialFeature>
          <TutorialViewButton view="commits">Open Commits</TutorialViewButton>
        </TutorialProvider>
      </ReviewProvider>
    </ReviewSessionProvider>,
  );
}

describe("tutorial dynamic content", () => {
  it("omits software-map guidance when the feature is disabled", () => {
    const html = render({ softwareMapEnabled: false });

    expect(html).not.toContain("Map guidance");
    expect(html).not.toContain("Open Map");
    expect(html).toContain("Open Commits");
  });

  it("shows software-map guidance when the feature is enabled", () => {
    const html = render({ softwareMapEnabled: true });

    expect(html).toContain("Map guidance");
    expect(html).toContain("Open Map");
  });

  it("opens the requested native Review view", () => {
    const container = document.createElement("div");
    const nativeView = document.createElement("button");
    nativeView.className = "review-segment";
    nativeView.setAttribute("aria-label", "Commits");
    const openView = vi.fn<() => void>();
    nativeView.addEventListener("click", openView);
    document.body.append(nativeView, container);
    const root = createRoot(container);
    act(() => {
      root.render(
        <ReviewSessionProvider session={session}>
          <ReviewProvider>
            <TutorialProvider tutorial={tutorial}>
              <TutorialViewButton view="commits">
                Open Commits
              </TutorialViewButton>
            </TutorialProvider>
          </ReviewProvider>
        </ReviewSessionProvider>,
      );
    });

    const button = container.querySelector("button");
    expect(button).not.toBeNull();
    act(() => button?.click());
    expect(openView).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
    document.body.replaceChildren();
  });
});

function jsonResponse(body: JsonObject): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
}
