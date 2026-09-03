// @vitest-environment jsdom

import {
  type JsonObject,
  type ReviewCanvasTutorialBridge,
  isJsonObject,
  parseJsonText,
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

import { BugReportControl } from "./bug-report-dialog";
import {
  captureWindowScreenshot,
  imageFileFromDataTransfer,
  normalizeScreenshot,
} from "./bug-report-screenshot";
import {
  type ReviewSession,
  ReviewSessionProvider,
} from "./host/review-session";
import { testReviewSession } from "./review-session-test-utils";
import { TutorialProvider } from "./tutorial-context";

vi.mock("./bug-report-screenshot", () => ({
  ScreenshotTooLargeError: class ScreenshotTooLargeError extends Error {},
  captureWindowScreenshot: vi.fn<typeof captureWindowScreenshot>(),
  imageFileFromDataTransfer: vi.fn<typeof imageFileFromDataTransfer>(),
  normalizeScreenshot: vi.fn<typeof normalizeScreenshot>(),
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const captureScreenshotMock = vi.mocked(captureWindowScreenshot);
const imageFileMock = vi.mocked(imageFileFromDataTransfer);
const normalizeScreenshotMock = vi.mocked(normalizeScreenshot);
const screenshotDataUrl = "data:image/jpeg;base64,c2NyZWVuc2hvdA==";

describe("BugReportControl", () => {
  let container: HTMLDivElement;
  let root: Root;
  let request: Mock<(url: string, init?: RequestInit) => Promise<Response>>;
  let session: ReviewSession;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    request = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(
      async (url) => {
        if (url.includes("/telemetry/bug-report")) {
          return jsonResponse({
            ok: true,
            report_id: "00000000-0000-4000-8000-000000000000",
            short_id: "123456789012",
          });
        }
        return jsonResponse({ ok: true });
      },
    );
    session = testReviewSession({}, { request });
    captureScreenshotMock.mockResolvedValue(null);
    imageFileMock.mockReturnValue(null);
    normalizeScreenshotMock.mockResolvedValue(screenshotDataUrl);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("enables Send with an empty description", async () => {
    await renderAndOpen();

    expect(sendButton().disabled).toBe(false);
  });

  it("disables Send when the description exceeds the byte limit", async () => {
    await renderAndOpen();

    await setDescription("a".repeat(64 * 1024 + 1));

    expect(sendButton().disabled).toBe(true);
  });

  it("maps the Review checkbox to both wire flags", async () => {
    await renderAndOpen();

    await act(async () => checkbox("Review").click());
    await act(async () => sendButton().click());

    expect(reportBody()).toMatchObject({
      description: "",
      include_review: false,
      include_map: false,
      include_diff: true,
      include_trace: false,
    });
  });

  it("requires trace consent and exposes its privacy tooltip", async () => {
    await renderAndOpen();
    const traceCheckbox = checkbox("Agent session trace");
    const privacyButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Agent session trace privacy information"]',
    );
    const tooltipId = privacyButton?.getAttribute("aria-describedby") ?? "";
    const tooltip = document.getElementById(tooltipId);

    expect(traceCheckbox.checked).toBe(false);
    expect(privacyButton).not.toBeNull();
    expect(tooltip?.getAttribute("role")).toBe("tooltip");
    expect(tooltip?.textContent).toContain(
      "complete, uncapped authoring session trace",
    );
    expect(tooltip?.textContent).toContain(
      "each ancestor session up to its fork point",
    );
    expect(tooltip?.textContent).toContain("tail-capped subagent traces");

    await act(async () => traceCheckbox.click());

    expect(traceCheckbox.checked).toBe(true);

    await act(async () => sendButton().click());
    expect(reportBody()).toMatchObject({ include_trace: true });

    await act(async () => reportButton().click());
    expect(checkbox("Agent session trace").checked).toBe(false);
  });

  it("explains how to send when the complete trace is unavailable", async () => {
    request.mockImplementation(async (url) =>
      url.includes("/telemetry/bug-report")
        ? jsonResponse({ error: "Trace unavailable." }, 422)
        : jsonResponse({ ok: true }),
    );
    await renderAndOpen();
    await act(async () => checkbox("Agent session trace").click());

    await act(async () => sendButton().click());

    expect(container.textContent).toContain(
      "The complete agent session trace couldn't be read. Uncheck 'Agent session trace' to send the report without it.",
    );
  });

  it("shows an automatic screenshot and omits it after removal", async () => {
    captureScreenshotMock.mockResolvedValue(screenshotDataUrl);
    await renderAndOpen();

    expect(
      container.querySelector<HTMLImageElement>('img[alt="Screenshot preview"]')
        ?.src,
    ).toBe(screenshotDataUrl);

    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Remove screenshot"]',
        )
        ?.click(),
    );
    expect(container.querySelector('img[alt="Screenshot preview"]')).toBeNull();

    await act(async () => sendButton().click());
    expect(reportBody()).not.toHaveProperty("screenshot");
  });

  it("still opens when automatic capture returns no result", async () => {
    captureScreenshotMock.mockResolvedValue(null);

    await renderAndOpen();

    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(container.textContent).toContain(
      "Paste or drop an image to attach a screenshot.",
    );
  });

  it("disables reporting in the tutorial", async () => {
    await renderControl(tutorialBridge());

    expect(reportButton().disabled).toBe(true);
    await act(async () => reportButton().click());

    expect(captureScreenshotMock).not.toHaveBeenCalled();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(request).not.toHaveBeenCalledWith(
      expect.stringContaining("/telemetry/event"),
      expect.anything(),
    );
  });

  async function renderControl(tutorial?: ReviewCanvasTutorialBridge) {
    await act(async () => {
      root.render(
        <ReviewSessionProvider session={session}>
          <TutorialProvider tutorial={tutorial}>
            <BugReportControl />
          </TutorialProvider>
        </ReviewSessionProvider>,
      );
    });
  }

  async function renderAndOpen() {
    await renderControl();
    await act(async () => reportButton().click());
  }

  async function setDescription(value: string) {
    const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
    await act(async () => {
      if (!textarea) return;
      const valueSetter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      valueSetter?.call(textarea, value);
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  function sendButton() {
    const button = [
      ...container.querySelectorAll<HTMLButtonElement>("button"),
    ].find((candidate) => candidate.textContent === "Send");
    if (!button) throw new Error("Send button not found");
    return button;
  }

  function reportButton() {
    const button = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Report a bug"]',
    );
    if (!button) throw new Error("Report bug button not found");
    return button;
  }

  function checkbox(labelText: string) {
    const input = [...container.querySelectorAll("label")]
      .find((label) => label.textContent?.trim() === labelText)
      ?.querySelector<HTMLInputElement>('input[type="checkbox"]');
    if (!input) throw new Error(labelText + " checkbox not found");
    return input;
  }

  function reportBody(): JsonObject {
    const call = request.mock.calls.find(([url]) =>
      String(url).includes("/telemetry/bug-report"),
    );
    if (!call) throw new Error("Bug-report request not found");
    const body = parseJsonText(String(call[1]?.body));
    if (!isJsonObject(body))
      throw new Error("Bug-report body is not an object");
    return body;
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

function jsonResponse(body: JsonObject, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
