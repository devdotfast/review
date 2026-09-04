// @vitest-environment jsdom

import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RepublishReview, republishReviewPrompt } from "./republish-review";

const reviewUuid = "11111111-1111-4111-8111-111111111111";
const command = `review publish --review ${reviewUuid}`;
const mapCommand = `review map publish --review ${reviewUuid}`;
const prompt = `Republish the Review with id \`${reviewUuid}\`. It was published by an earlier version of Review and its document must be regenerated. Run \`${command} --json\`. If it reports validation errors, fix them in that Review's \`review.mdx\` or \`data.ts\` without changing what the review says, and rerun until it succeeds.`;
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

describe("RepublishReview", () => {
  it.each([false, true])(
    "copies the exact commands and prompt with mapStale=%s",
    async (mapStale) => {
      const expectedPrompt = mapStale
        ? `${prompt} Then run \`${mapCommand} --json\`.`
        : prompt;
      expect(republishReviewPrompt({ reviewUuid, mapStale })).toBe(
        expectedPrompt,
      );
      await act(async () =>
        root.render(
          <RepublishReview reviewUuid={reviewUuid} mapStale={mapStale} />,
        ),
      );
      expect(container.querySelector("h2")?.textContent).toBe(
        "Republish this review",
      );
      expect(
        Array.from(
          container.querySelectorAll("code"),
          (node) => node.textContent,
        ),
      ).toEqual(mapStale ? [command, mapCommand] : [command]);
      const buttons = container.querySelectorAll<HTMLButtonElement>(
        'button[aria-label="Copy command"]',
      );
      expect(buttons).toHaveLength(mapStale ? 2 : 1);
      await act(async () => buttons[0]!.click());
      expect(writeText).toHaveBeenLastCalledWith(command);
      expect(buttons[0]!.getAttribute("aria-label")).toBe("Command copied");
      if (mapStale) {
        await act(async () => buttons[1]!.click());
      }
      expect(writeText.mock.calls.map(([text]) => text)).toEqual(
        mapStale ? [command, mapCommand] : [command],
      );
      await act(async () =>
        container
          .querySelector<HTMLButtonElement>('button[aria-label="Copy prompt"]')!
          .click(),
      );
      expect(writeText).toHaveBeenLastCalledWith(expectedPrompt);
    },
  );
});
