// @vitest-environment jsdom

import {
  type JsonObject,
  type ReviewCanvasTutorialBridge,
  type ReviewDocumentVersionWire,
} from "@dev.fast/review-protocol";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import {
  type Mock,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { ReviewSessionProvider } from "./host/review-session";
import { ReviewProvider } from "./review-context";
import { ReviewHistoryControl } from "./review-history-control";
import { testReviewSession } from "./review-session-test-utils";
import { TutorialProvider } from "./tutorial-context";

const versions: ReviewDocumentVersionWire[] = [
  {
    revision: "a".repeat(40),
    sealedAt: Date.UTC(2026, 7, 19),
    isCurrent: true,
  },
];

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe("ReviewHistoryControl", () => {
  let container: HTMLDivElement;
  let root: Root;
  let request: Mock<(url: string, init?: RequestInit) => Promise<Response>>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    request = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(
      async (url) =>
        url.includes("/revisions")
          ? jsonResponse({ ok: true, versions })
          : jsonResponse({ ok: true }),
    );
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("stays visible and disabled without loading versions in the tutorial", async () => {
    await renderControl(tutorialBridge());

    expect(historyButton().disabled).toBe(true);
    expect(revisionRequests()).toHaveLength(0);

    await act(async () => historyButton().click());
    expect(container.querySelector('[role="menu"]')).toBeNull();
  });

  it("loads versions and stays enabled for a regular Review", async () => {
    await renderControl();
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });

    expect(revisionRequests()).toHaveLength(1);
    expect(historyButton().disabled).toBe(false);
  });

  async function renderControl(tutorial?: ReviewCanvasTutorialBridge) {
    await act(async () => {
      root.render(
        <ReviewSessionProvider session={testReviewSession({}, { request })}>
          <ReviewProvider>
            <TutorialProvider tutorial={tutorial}>
              <ReviewHistoryControl />
            </TutorialProvider>
          </ReviewProvider>
        </ReviewSessionProvider>,
      );
    });
  }

  function historyButton() {
    const button = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Version history"]',
    );
    if (!button) throw new Error("Version history button not found");
    return button;
  }

  function revisionRequests() {
    return request.mock.calls.filter(([url]) => url.includes("/revisions"));
  }
});

function tutorialBridge(): ReviewCanvasTutorialBridge {
  return {
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
}

function jsonResponse(body: JsonObject): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
}
