import { describe, expect, it } from "vitest";

import {
  WHITEBOARD_MCP_LAUNCH,
  connectPrompt,
  connectPrompts,
  whiteboardMcpLaunch,
} from "./connect-prompts";
import { ALL_INSTALL_TARGETS } from "./install";

const input = {
  hasShim: true,
  traceEnabled: false,
  fffBinaryPath: "/Users/u/.local/bin/fff-mcp",
  fffCorpusRoot: "/Users/u/.dev/trace-search",
};

const LAUNCH_TEXT = `command "sh", args ["-c","exec \\"$HOME/.local/bin/whiteboard\\" mcp"]`; // JSON.stringify spacing

describe("whiteboardMcpLaunch", () => {
  it("is the shared sh form with a shim and a bare whiteboard without one", () => {
    expect(whiteboardMcpLaunch(true)).toEqual(WHITEBOARD_MCP_LAUNCH);
    expect(whiteboardMcpLaunch(false)).toEqual({
      command: "whiteboard",
      args: ["mcp"],
    });
  });
});

describe("connectPrompt", () => {
  it("tells MCP harnesses to register the whiteboard server with the shared launch form", () => {
    for (const target of ["claude", "codex", "cursor", "opencode"] as const) {
      const prompt = connectPrompt(target, input);
      expect(prompt).toContain('MCP server named "whiteboard"');
      expect(prompt).toContain(LAUNCH_TEXT);
      expect(prompt).toContain(
        "Skip step 1 if the Whiteboard plugin is already installed",
      );
      expect(prompt).toContain("session_get_instructions");
      expect(prompt).toContain("dev-review-batch");
      expect(prompt).toContain("Keep `$HOME` literal");
      expect(prompt).not.toContain("fff");
    }
  });

  it("adds the AGENTS.md line for Codex only", () => {
    expect(connectPrompt("codex", input)).toContain("~/.codex/AGENTS.md");
    expect(connectPrompt("claude", input)).not.toContain("AGENTS.md");
  });

  it("writes the Codex AGENTS.md line before the reload step", () => {
    const prompt = connectPrompt("codex", input);
    expect(prompt.indexOf("AGENTS.md")).toBeLessThan(
      prompt.indexOf("session_get_instructions"),
    );
  });

  it("names each harness's skills directory for the legacy cleanup", () => {
    expect(connectPrompt("claude", input)).toContain("~/.claude/skills");
    expect(connectPrompt("codex", input)).toContain("~/.agents/skills");
    expect(connectPrompt("cursor", input)).toContain("~/.cursor/skills");
    expect(connectPrompt("opencode", input)).toContain(
      "~/.config/opencode/skills",
    );
  });

  it("gives Pi a pointer skill instead of an MCP server", () => {
    const prompt = connectPrompt("pi", input);
    expect(prompt).toContain("~/.agents/skills/whiteboard/SKILL.md");
    expect(prompt).toContain('description: "Explain code in Whiteboard');
    expect(prompt).toContain(
      `"$HOME/.local/bin/whiteboard" api session_get_instructions '{}'`,
    );
    expect(prompt).not.toContain("MCP server named");
    expect(prompt).not.toContain("whiteboard-version");
    expect(prompt).toContain(
      "Skip step 2 if the Whiteboard package for Pi is already installed.",
    );
  });

  it("deletes Pi's old stamped skills before writing the new one", () => {
    const prompt = connectPrompt("pi", input);
    expect(prompt.indexOf("dev-review-batch")).toBeLessThan(
      prompt.indexOf("whiteboard/SKILL.md"),
    );
  });

  it("adds the fff paragraph for Claude, Codex and Pi only while trace capture is on", () => {
    const traced = { ...input, traceEnabled: true };
    expect(connectPrompt("claude", traced)).toContain('MCP server named "fff"');
    expect(connectPrompt("claude", traced)).toContain(
      "/Users/u/.dev/trace-search",
    );
    expect(connectPrompt("codex", traced)).toContain("install-mcp.sh");
    expect(connectPrompt("pi", traced)).toContain(
      "pi install npm:@ff-labs/pi-fff",
    );
    expect(connectPrompt("cursor", traced)).not.toContain("fff");
    expect(connectPrompt("opencode", traced)).not.toContain("fff");
    expect(connectPrompt("claude", input)).not.toContain("fff");
  });

  it("registers fff before the reload step", () => {
    const traced = { ...input, traceEnabled: true };
    const claude = connectPrompt("claude", traced);
    expect(claude.indexOf('named "fff"')).toBeLessThan(
      claude.indexOf("Reload your MCP tools"),
    );
    const pi = connectPrompt("pi", traced);
    expect(pi.indexOf("pi install")).toBeLessThan(
      pi.indexOf("once and confirm it answered"),
    );
  });

  it("falls back to a bare whiteboard command without a shim", () => {
    const prompt = connectPrompt("claude", { ...input, hasShim: false });
    expect(prompt).toContain('command "whiteboard", args ["mcp"]');
    expect(prompt).toContain("whiteboard must be on the PATH of the agent");
    const pi = connectPrompt("pi", { ...input, hasShim: false });
    expect(pi).toContain("whiteboard api session_get_instructions '{}'");
    expect(pi).toContain("must be on the PATH");
  });
});

describe("connectPrompts", () => {
  it("returns one prompt per target", () => {
    expect(Object.keys(connectPrompts(input)).sort()).toEqual(
      [...ALL_INSTALL_TARGETS].sort(),
    );
  });
});
