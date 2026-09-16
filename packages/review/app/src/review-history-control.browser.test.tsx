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
import {
  DisplayedReviewVersionContext,
  ReviewHistoryControl,
} from "./review-history-control";
import { testReviewSession } from "./review-session-test-utils";
import { TutorialProvider } from "./tutorial-context";

const versions: ReviewDocumentVersionWire[] = [
  {
    revision: "a".repeat(40),
    sealedAt: Date.UTC(2026, 7, 19),
    isCurrent: true,
  },
];

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

  it("distinguishes versions saved at the same time and opens the selected one", async () => {
    const saved = [2, 3].map((revision) => ({
      revision: String(revision),
      sealedAt: Date.UTC(2026, 7, 19),
      isCurrent: revision === 3,
    }));

    request.mockImplementation(async (url) =>
      url.includes("/revisions")
        ? jsonResponse({ ok: true, versions: saved })
        : jsonResponse({ ok: true }),
    );
    const post = vi.fn<() => Promise<{ ok: true }>>(async () => ({ ok: true }));
    await renderControl(undefined, post);
    await expect.poll(() => historyButton().disabled).toBe(false);
    await act(async () => historyButton().click());

    const items = [
      ...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
    ];

    expect(items[0]!.textContent).toContain("Version 2 · ");
    expect(items[1]!.textContent).toContain("Version 3 · ");
    expect(items[1]!.disabled).toBe(true);
    await act(async () => items[0]!.click());
    expect(post).toHaveBeenCalledWith({
      name: "openReviewRevision",
      args: { revision: "2", sealedAt: saved[0]!.sealedAt },
    });
  });

  it("steps through saved versions and returns to the live latest version", async () => {
    const saved = [3, 1, 2].map((revision) => ({
      revision: String(revision),
      sealedAt: Date.UTC(2026, 7, revision),
      isCurrent: revision === 3,
    }));

    request.mockImplementation(async (url) =>
      url.includes("/revisions")
        ? jsonResponse({ ok: true, versions: saved })
        : jsonResponse({ ok: true }),
    );
    const post = vi.fn<() => Promise<{ ok: true }>>(async () => ({ ok: true }));

    const arrow = (label: string) =>
      container.querySelector<HTMLButtonElement>(
        `[aria-label="${label} version"]`,
      )!;

    await renderControl(undefined, post, 3);
    await expect.poll(() => historyButton().textContent).toContain("Version 3");
    expect(arrow("Next").disabled).toBe(true);
    await act(async () => arrow("Previous").click());
    expect(post).toHaveBeenLastCalledWith({
      name: "openReviewRevision",
      args: { revision: "2", sealedAt: Date.UTC(2026, 7, 2) },
    });

    await renderControl(undefined, post, 2);
    await expect.poll(() => historyButton().textContent).toContain("Version 2");
    expect(historyButton().querySelector("time")?.dateTime).toBe(
      new Date(Date.UTC(2026, 7, 2)).toISOString(),
    );
    expect(arrow("Previous").disabled).toBe(false);
    expect(arrow("Next").disabled).toBe(false);
    await act(async () => arrow("Next").click());
    expect(post).toHaveBeenLastCalledWith({
      name: "openReviewRevision",
      args: {},
    });

    await renderControl(undefined, post, 1);
    expect(arrow("Previous").disabled).toBe(true);
    await act(async () => arrow("Next").click());
    expect(post).toHaveBeenLastCalledWith({
      name: "openReviewRevision",
      args: { revision: "2", sealedAt: Date.UTC(2026, 7, 2) },
    });
  });

  async function renderControl(
    tutorial?: ReviewCanvasTutorialBridge,
    post?: ReturnType<typeof testReviewSession>["bridge"]["post"],
    displayedVersion?: number,
  ) {
    await act(async () => {
      root.render(
        <ReviewSessionProvider
          session={testReviewSession({}, { request, post })}
        >
          <ReviewProvider>
            <TutorialProvider tutorial={tutorial}>
              <DisplayedReviewVersionContext.Provider value={displayedVersion}>
                <ReviewHistoryControl />
              </DisplayedReviewVersionContext.Provider>
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
