import { describe, expect, it, vi } from "vitest";

import {
  type RunTutorialAuthoringCommand,
  createTutorialAuthoringSession,
  tutorialAuthoringPrompt,
} from "./tutorial-authoring-session";

const expectedPrompt =
  "You are continuing from a pre-bundled Review tutorial. The review encompases a sample codebase and is meant to show the new user the various featurs of Review. Because the user installed Review, they are thoughtful about the code they ship and want to take ownership of their architecture! the next message will be the user commenting on the sample commit diff";

describe("createTutorialAuthoringSession", () => {
  it("creates a persisted Claude source session without tools", async () => {
    const runCommand = successfulCommand();

    const session = await createTutorialAuthoringSession({
      harness: "claude-code",
      rootPath: "/tutorial/head",
      runCommand,
    });

    expect(session).toEqual({
      harness: "claude-code",
      sessionId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    const command = runCommand.mock.calls[0]?.[0];
    expect(command?.executable).toBe("claude");
    expect(command?.cwd).toBe("/tutorial/head");
    expect(command?.args).toEqual(
      expect.arrayContaining([
        "--print",
        "--session-id",
        "--tools",
        "",
        expectedPrompt,
      ]),
    );
    expect(command?.env?.CLAUDE_CODE_FORCE_SESSION_PERSISTENCE).toBe("1");
  });

  it("reads the genuine Codex thread ID from exec events", async () => {
    const runCommand = vi.fn<RunTutorialAuthoringCommand>(async () => ({
      stdout:
        '{"type":"thread.started","thread_id":"codex-tutorial"}\n' +
        '{"type":"turn.completed"}\n',
      stderr: "",
    }));

    await expect(
      createTutorialAuthoringSession({
        harness: "codex",
        rootPath: "/tutorial/head",
        runCommand,
      }),
    ).resolves.toEqual({
      harness: "codex",
      sessionId: "codex-tutorial",
    });
    expect(runCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        executable: "codex",
        cwd: "/tutorial/head",
        args: expect.arrayContaining([
          "exec",
          "--json",
          "--sandbox",
          "read-only",
        ]),
      }),
    );
  });

  it("creates a persisted Pi session with project resources disabled", async () => {
    const runCommand = successfulCommand();

    const session = await createTutorialAuthoringSession({
      harness: "pi",
      rootPath: "/tutorial/head",
      runCommand,
    });

    expect(session).toEqual({
      harness: "pi",
      sessionId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    expect(runCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        executable: "pi",
        cwd: "/tutorial/head",
        args: expect.arrayContaining([
          "--print",
          "--session-id",
          "--tools",
          "",
          "--no-context-files",
        ]),
      }),
    );
  });

  it("passes cancellation through to the command runner", async () => {
    const controller = new AbortController();
    const runCommand = vi.fn<RunTutorialAuthoringCommand>(async (input) => {
      expect(input.signal).toBe(controller.signal);
      throw new Error("canceled");
    });
    controller.abort();

    await expect(
      createTutorialAuthoringSession({
        harness: "codex",
        rootPath: "/tutorial/head",
        signal: controller.signal,
        runCommand,
      }),
    ).rejects.toThrow("canceled");
  });
});

describe("tutorialAuthoringPrompt", () => {
  it("uses only the pre-bundled tutorial context", () => {
    expect(tutorialAuthoringPrompt()).toBe(expectedPrompt);
  });
});

function successfulCommand(): ReturnType<
  typeof vi.fn<RunTutorialAuthoringCommand>
> {
  return vi.fn<RunTutorialAuthoringCommand>(async () => ({
    stdout: "Ready",
    stderr: "",
  }));
}
