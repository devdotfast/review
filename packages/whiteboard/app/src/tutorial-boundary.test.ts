import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("tutorial architecture boundary", () => {
  it.each(["DocumentCodeView.tsx", "diagrams.tsx", "whiteboard-context.tsx"])(
    "keeps tutorial state out of %s",
    (path) => {
      const source = readFileSync(new URL(path, import.meta.url), "utf8");

      expect(source).not.toMatch(/tutorial-context|useTutorial|TutorialStep/);
    },
  );
});
