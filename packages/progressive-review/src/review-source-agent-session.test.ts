import { describe, expect, it, vi } from "vitest";

import { forkOpenCodeSourceSession as forkOpenCodeSourceSessionImpl } from "./native-agent/opencode-source";
import { createReviewSourceAgentSession } from "./review-source-agent-session";

describe("createReviewSourceAgentSession", () => {
  it("passes the validated OpenCode boundary and managed checkout", async () => {
    const forkOpenCodeSourceSession = vi.fn<
      typeof forkOpenCodeSourceSessionImpl
    >(async () => "frozen-session");
    await expect(
      createReviewSourceAgentSession({
        agent: {
          harness: "opencode",
          sessionId: "session-1",
          messageId: "message-1",
          directory: "/workspace/subdir",
          worktree: "/workspace",
        },
        reviewUuid: "review-1",
        rootPath: "/managed/head",
        forkOpenCodeSourceSession,
      }),
    ).resolves.toEqual({
      harness: "opencode",
      sessionId: "frozen-session",
    });
    expect(forkOpenCodeSourceSession).toHaveBeenCalledWith({
      sessionId: "session-1",
      messageId: "message-1",
      sourceDirectory: "/workspace/subdir",
      sourceWorktree: "/workspace",
      targetDirectory: "/managed/head",
    });
  });

  it("rejects unknown harnesses instead of using Codex", async () => {
    await expect(
      createReviewSourceAgentSession({
        agent: { harness: "unknown", sessionId: "session-1" } as never,
        reviewUuid: "review-1",
        rootPath: "/managed/head",
      }),
    ).rejects.toThrow("Unsupported Review agent harness");
  });
});
