// @vitest-environment jsdom

import type {
  ReviewCanvasTutorialBridge,
  ReviewDocumentVersionWire,
} from "@dev.fast/review-protocol";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ReviewSessionProvider } from "./host/review-session";
import { ReviewHistoryControl } from "./review-history-control";
import { testReviewSession } from "./review-session-test-utils";
import { TutorialProvider } from "./tutorial-context";

const { listVersionsMock } = vi.hoisted(() => ({
  listVersionsMock: vi.fn<() => Promise<ReviewDocumentVersionWire[] | null>>(),
}));

vi.mock("./review-context", () => ({
  useReview: () => ({
    historicalRevision: null,
    listVersions: listVersionsMock,
  }),
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe("ReviewHistoryControl", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    listVersionsMock.mockResolvedValue([
      {
        revision: "a".repeat(40),
        sealedAt: Date.UTC(2026, 7, 19),
        isCurrent: true,
      },
    ]);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("stays visible and disabled without loading versions in the tutorial", async () => {
    await renderControl(tutorialBridge());

    expect(historyButton().disabled).toBe(true);
    expect(listVersionsMock).not.toHaveBeenCalled();

    await act(async () => historyButton().click());
    expect(container.querySelector('[role="menu"]')).toBeNull();
  });

  it("loads versions and stays enabled for a regular Review", async () => {
    await renderControl();
    await act(async () => {
      await Promise.resolve();
    });

    expect(listVersionsMock).toHaveBeenCalledTimes(1);
    expect(historyButton().disabled).toBe(false);
  });

  async function renderControl(tutorial?: ReviewCanvasTutorialBridge) {
    await act(async () => {
      root.render(
        <ReviewSessionProvider session={testReviewSession()}>
          <TutorialProvider tutorial={tutorial}>
            <ReviewHistoryControl />
          </TutorialProvider>
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
