// @vitest-environment jsdom

import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RepairReview, repairReviewPrompt } from "./republish-review";

const reviewUuid = "11111111-1111-4111-8111-111111111111";
const command = `review repair --review ${reviewUuid}`;
const prompt = `Repair the currently presented Review with id \`${reviewUuid}\`. Run \`${command} --json\`. If it reports validation errors, fix only the reported authoring inputs without changing what the current review says, then rerun. Reconcile any unpublished authoring edits before using source-based repair. Preserve the review status, pinned commits, and threads; do not republish or repair older historical revisions.`;
let root: Root;
let container: HTMLDivElement;
const writeText = vi.fn<(text: string) => Promise<void>>(async () => {});

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  Reflect.deleteProperty(navigator, "clipboard");
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("RepairReview", () => {
  it("offers repair for legacy recovery without offering publication commands", async () => {
    await act(async () =>
      root.render(<RepairReview reviewUuid={reviewUuid} mapStale />),
    );
    expect(container.textContent).toContain("Repair this review");
    expect(container.textContent).toContain(
      "The published software map also needs repair.",
    );
    expect(container.querySelector("code")?.textContent).toBe(command);
    expect(container.textContent).not.toContain("review publish");
  });
  it.each([false, true])(
    "copies the exact commands and prompt with mapStale=%s",
    async (mapStale) => {
      const expectedPrompt = mapStale
        ? `${prompt} The published software map also needs repair.`
        : prompt;
      expect(repairReviewPrompt({ reviewUuid, mapStale })).toBe(expectedPrompt);
      await act(async () =>
        root.render(
          <RepairReview reviewUuid={reviewUuid} mapStale={mapStale} />,
        ),
      );
      expect(container.querySelector("h2")?.textContent).toBe(
        "Repair this review",
      );
      expect(
        Array.from(
          container.querySelectorAll("code"),
          (node) => node.textContent,
        ),
      ).toEqual([command]);
      expect(container.querySelector("p")?.textContent).toBe(
        "This review's published artifacts must be regenerated. Repair keeps its review status, pinned commits, and threads.",
      );
      const buttons = container.querySelectorAll<HTMLButtonElement>(
        'button[aria-label="Copy command"]',
      );
      expect(buttons).toHaveLength(1);
      await act(async () => buttons[0]!.click());
      expect(writeText).toHaveBeenLastCalledWith(command);
      expect(buttons[0]!.getAttribute("aria-label")).toBe("Command copied");
      expect(writeText.mock.calls.map(([text]) => text)).toEqual([command]);
      await act(async () =>
        container
          .querySelector<HTMLButtonElement>('button[aria-label="Copy prompt"]')!
          .click(),
      );
      expect(writeText).toHaveBeenLastCalledWith(expectedPrompt);
    },
  );
});
