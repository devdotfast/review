import { describe, expect, it } from "vitest";

import { resolveAuthoringSessionRef } from "./authoring-session";

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
});
