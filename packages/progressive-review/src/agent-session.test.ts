import { describe, expect, it } from "vitest";

import {
  freshSourceSessionKey,
  parseFreshSourceSessionHarness,
  resolveAuthoringSessionRef,
} from "./authoring-session";

describe("fresh tutorial source sessions", () => {
  it("round-trips supported harnesses and rejects other source sessions", () => {
    expect(freshSourceSessionKey("claude-code")).toBe("fresh:claude-code");
    expect(parseFreshSourceSessionHarness("fresh:codex")).toBe("codex");
    expect(parseFreshSourceSessionHarness("fresh:pi:extra")).toBeUndefined();
    expect(parseFreshSourceSessionHarness("codex:thread-id")).toBeUndefined();
  });
});

describe("resolveAuthoringSessionRef", () => {
  it("detects Codex sessions", () => {
    expect(
      resolveAuthoringSessionRef({
        CODEX_THREAD_ID: "codex-thread",
      }),
    ).toEqual({ harness: "codex", sessionId: "codex-thread" });
  });

  it("detects Claude Code sessions", () => {
    expect(
      resolveAuthoringSessionRef({
        CLAUDE_CODE_SESSION_ID: "claude-session",
      }),
    ).toEqual({ harness: "claude-code", sessionId: "claude-session" });
  });

  it("falls back to the shorter Claude session env name", () => {
    expect(
      resolveAuthoringSessionRef({
        CLAUDE_SESSION_ID: "claude-session",
      }),
    ).toEqual({ harness: "claude-code", sessionId: "claude-session" });
  });

  it("uses exact OpenCode custom-tool context", () => {
    expect(
      resolveAuthoringSessionRef(
        { CODEX_THREAD_ID: "must-not-win" },
        {
          sessionId: "session-1",
          messageId: "message-1",
          directory: "/workspace/subdir",
          worktree: "/workspace",
        },
      ),
    ).toEqual({
      harness: "opencode",
      sessionId: "session-1",
      messageId: "message-1",
      directory: "/workspace/subdir",
      worktree: "/workspace",
    });
  });

  it("rejects incomplete OpenCode custom-tool context", () => {
    expect(() =>
      resolveAuthoringSessionRef({}, { sessionId: "session-1" }),
    ).toThrow("OpenCode invocation context is incomplete");
    expect(() =>
      resolveAuthoringSessionRef({
        DEV_FAST_AGENT_SESSION: "opencode:session-1",
      }),
    ).toThrow("cannot carry OpenCode invocation context");
  });
});
