import { describe, expect, it } from "vitest";

import {
  REVIEW_MCP_LAUNCH,
  connectPrompt,
  connectPrompts,
  reviewMcpLaunch,
} from "./connect-prompts";
import { ALL_INSTALL_TARGETS } from "./install";

const input = {
  hasShim: true,
  legacyPaths: [],
  traceEnabled: false,
  fffBinaryPath: "/Users/u/.local/bin/fff-mcp",
  fffCorpusRoot: "/Users/u/.dev/trace-search",
};

describe("reviewMcpLaunch", () => {
  it("is the shared sh form with a shim and a bare whiteboard without one", () => {
    expect(reviewMcpLaunch(true)).toEqual(REVIEW_MCP_LAUNCH);
    expect(reviewMcpLaunch(false)).toEqual({
      command: "whiteboard",
      args: ["mcp"],
    });
  });
});

describe("connectPrompt", () => {
  it("adds optional trace search only for supported harnesses when enabled", () => {
    for (const target of ALL_INSTALL_TARGETS) {
      const disabled = connectPrompt(target, input);
      const enabled = connectPrompt(target, { ...input, traceEnabled: true });
      expect(disabled).not.toContain(input.fffCorpusRoot);
      expect(disabled).not.toContain("npm:@ff-labs/pi-fff");

      const mcpTrace = target === "claude" || target === "codex";

      expect(enabled.includes(input.fffCorpusRoot)).toBe(mcpTrace);
      expect(enabled.includes(input.fffBinaryPath)).toBe(mcpTrace);
      expect(enabled.includes("pi install npm:@ff-labs/pi-fff")).toBe(
        target === "pi",
      );
    }
  });
});

describe("connectPrompts", () => {
  it("returns one prompt per target", () => {
    expect(Object.keys(connectPrompts(input)).sort()).toEqual(
      [...ALL_INSTALL_TARGETS].sort(),
    );
  });
});
