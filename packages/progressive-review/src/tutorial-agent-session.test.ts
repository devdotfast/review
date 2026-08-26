import { describe, expect, it, vi } from "vitest";

import {
  type RunTutorialAgentCommand,
  TUTORIAL_AGENT_INTRO_PROMPT,
  createTutorialAgentSession,
} from "./tutorial-agent-session";

describe("createTutorialAgentSession", () => {
  it("creates a persisted Claude source session without tools", async () => {
    const runCommand = vi.fn<RunTutorialAgentCommand>(async () => ({
      stdout: "Ready",
      stderr: "",
    }));

    const session = await createTutorialAgentSession({
      harness: "claude-code",
      rootPath: "/tutorial/head",
      runCommand,
    });

    expect(session).toEqual({
      harness: "claude-code",
      sessionId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    expect(runCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        executable: "claude",
        cwd: "/tutorial/head",
        args: expect.arrayContaining([
          "--print",
          "--session-id",
          "--tools",
          "",
          TUTORIAL_AGENT_INTRO_PROMPT,
        ]),
        env: expect.objectContaining({
          CLAUDE_CODE_FORCE_SESSION_PERSISTENCE: "1",
        }),
      }),
    );
  });

  it("reads the genuine Codex thread ID from exec events", async () => {
    const runCommand = vi.fn<RunTutorialAgentCommand>(async () => ({
      stdout:
        '{"type":"thread.started","thread_id":"codex-tutorial"}\n' +
        '{"type":"turn.completed"}\n',
      stderr: "",
    }));

    await expect(
      createTutorialAgentSession({
        harness: "codex",
        rootPath: "/tutorial/head",
        runCommand,
      }),
    ).resolves.toEqual({
      harness: "codex",
      sessionId: "codex-tutorial",
    });
    expect(runCommand).toHaveBeenCalledWith({
      executable: "codex",
      cwd: "/tutorial/head",
      args: [
        "exec",
        "--json",
        "--sandbox",
        "read-only",
        "--skip-git-repo-check",
        TUTORIAL_AGENT_INTRO_PROMPT,
      ],
    });
  });

  it("creates a persisted Pi source session with project resources disabled", async () => {
    const runCommand = vi.fn<RunTutorialAgentCommand>(async () => ({
      stdout: "Ready",
      stderr: "",
    }));

    const session = await createTutorialAgentSession({
      harness: "pi",
      rootPath: "/tutorial/head",
      runCommand,
    });

    expect(session).toEqual({
      harness: "pi",
      sessionId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    expect(runCommand).toHaveBeenCalledWith({
      executable: "pi",
      cwd: "/tutorial/head",
      args: expect.arrayContaining([
        "--print",
        "--session-id",
        "--no-tools",
        "--no-context-files",
        TUTORIAL_AGENT_INTRO_PROMPT,
      ]),
    });
  });
});
