import { describe, expect, it } from "vitest";

import {
  CLAUDE_WINDOWS_MCP_ADD,
  REVIEW_MCP_LAUNCH,
  WINDOWS_MCP_LAUNCH,
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

  it("launches through cmd on Windows, which has no sh", () => {
    for (const hasShim of [true, false])
      expect(reviewMcpLaunch(hasShim, "win32")).toEqual(WINDOWS_MCP_LAUNCH);
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
      expect(enabled.includes("omp install npm:@ff-labs/pi-fff")).toBe(
        target === "omp",
      );
    }
  });

  it("registers Claude's MCP server directly on Windows instead of the plugin", () => {
    const prompt = connectPrompt("claude", { ...input, platform: "win32" });

    expect(prompt).toContain(CLAUDE_WINDOWS_MCP_ADD);
    expect(prompt).not.toContain("claude plugin install");
    expect(connectPrompt("claude", { ...input, platform: "darwin" })).toContain(
      "claude plugin install whiteboard@devfast",
    );
  });

  it("installs the Pi package in oh-my-pi and reloads its plugins", () => {
    const prompt = connectPrompt("omp", input);

    expect(prompt).toContain("omp install npm:@dev.fast/pi-whiteboard");
    expect(prompt).toContain("/reload-plugins");
    expect(prompt).toContain("whiteboard api session_get_instructions '{}'");
  });
});

describe("connectPrompts", () => {
  it("returns one prompt per target", () => {
    expect(Object.keys(connectPrompts(input)).sort()).toEqual(
      [...ALL_INSTALL_TARGETS].sort(),
    );
  });
});
