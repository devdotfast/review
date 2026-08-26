import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("tutorial architecture boundary", () => {
  it.each([
    "InlineCodeEditor.tsx",
    "diagrams.tsx",
    "review-context.tsx",
    "thread-card.tsx",
  ])("keeps tutorial state out of %s", (path) => {
    const source = readFileSync(new URL(path, import.meta.url), "utf8");

    expect(source).not.toMatch(/tutorial-context|useTutorial|TutorialStep/);
  });
});
