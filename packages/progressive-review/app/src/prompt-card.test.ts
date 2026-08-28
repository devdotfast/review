// @vitest-environment jsdom

import type { ReviewCliInstallStatus } from "@dev.fast/review-protocol";
import { describe, expect, it } from "vitest";

import { PROMPT_VARIANTS, promptAgent } from "./prompt-card";

describe("OpenCode prompt wording", () => {
  it("uses the installed OpenCode skill when it is the available agent", () => {
    const status = {
      agents: [{ target: "opencode", present: true, installed: true }],
      stamp: null,
    } as ReviewCliInstallStatus;

    expect(promptAgent(status)).toBe("opencode");
    expect(PROMPT_VARIANTS.change.opencode).toContain("dev-review skill");
    expect(PROMPT_VARIANTS.architecture.opencode).toContain("dev-review skill");
  });
});
