import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ReviewVerbRequest } from "@dev.fast/review-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  NativeReviewTurnLauncher,
  type NativeReviewTurnLauncherInput,
} from "./native-turn-launcher";

type NativeTerminalInput = Extract<
  ReviewVerbRequest,
  { name: "openNativeAgentTerminal" }
>["args"];

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("NativeReviewTurnLauncher new routes", () => {
  it("resumes Claude as a normal interactive terminal", async () => {
    const { launcher, openTerminal } = await createLauncher();

    const handle = await launcher.openSession({
      launchId: "claude-resume",
      cwd: "/tmp/tutorial",
      binding: { harness: "claude-code", sessionId: "tutorial-thread" },
    });

    const terminal = terminalInput(openTerminal);
    expect(terminal.args).not.toContain("--print");
    expect(terminal.args).toEqual(
      expect.arrayContaining(["--resume", "tutorial-thread"]),
    );
    expect(terminal.args.at(-1)).toBe("tutorial-thread");
    await handle.detach();
  });

  it("forks a Claude source session in the normal interactive terminal", async () => {
    const { launcher, openTerminal } = await createLauncher();

    const handle = await launcher.launchTurn({
      launchId: "claude-fork",
      threadId: "thread-1",
      reviewMessageId: "message-1",
      cwd: "/tmp/tutorial",
      prompt: "Explain this Review",
      route: {
        kind: "fork",
        source: { harness: "claude-code", sessionId: "tutorial-source" },
      },
    });

    const terminal = terminalInput(openTerminal);
    expect(terminal.args).not.toContain("--print");
    expect(terminal.args).toEqual(
      expect.arrayContaining(["--resume", "tutorial-source", "--fork-session"]),
    );
    expect(terminal.args.at(-1)).toBe("Explain this Review");
    await handle.detach();
  });

  it("starts a fresh Claude session without resuming or forking", async () => {
    const { launcher, openTerminal } = await createLauncher();

    const handle = await launcher.launchTurn({
      launchId: "claude-new",
      threadId: "thread-1",
      reviewMessageId: "message-1",
      cwd: "/tmp/tutorial",
      prompt: "Explain this code",
      route: { kind: "new", harness: "claude-code" },
    });

    const terminal = terminalInput(openTerminal);
    expect(terminal.executable).toBe("claude");
    expect(terminal.args).not.toContain("--print");
    expect(terminal.args).toContain("--session-id");
    expect(terminal.args).not.toContain("--resume");
    expect(terminal.args).not.toContain("--fork-session");
    expect(terminal.args.at(-1)).toBe("Explain this code");
    expect(sessionIdAfter(terminal.args, "--session-id")).toMatch(
      /^[0-9a-f-]{36}$/,
    );
    await handle.detach();
  });

  it("starts a fresh Pi session with a generated session ID", async () => {
    const { launcher, openTerminal } = await createLauncher();

    const handle = await launcher.launchTurn({
      launchId: "pi-new",
      threadId: "thread-1",
      reviewMessageId: "message-1",
      cwd: "/tmp/tutorial",
      prompt: "Explain this code",
      route: { kind: "new", harness: "pi" },
    });

    const terminal = terminalInput(openTerminal);
    expect(terminal.executable).toBe("pi");
    expect(terminal.args).toContain("--session-id");
    expect(terminal.args).not.toContain("--session");
    expect(terminal.args).not.toContain("--fork");
    expect(sessionIdAfter(terminal.args, "--session-id")).toMatch(
      /^[0-9a-f-]{36}$/,
    );
    await handle.detach();
  });

  it("creates a Codex thread before opening it in the terminal", async () => {
    const { launcher, openTerminal, startCodexThread, forkCodexThread } =
      await createLauncher();

    const handle = await launcher.launchTurn({
      launchId: "codex-new",
      threadId: "thread-1",
      reviewMessageId: "message-1",
      cwd: "/tmp/tutorial",
      prompt: "Explain this code",
      route: { kind: "new", harness: "codex" },
    });

    expect(startCodexThread).toHaveBeenCalledWith({
      cwd: "/tmp/tutorial",
    });
    expect(forkCodexThread).not.toHaveBeenCalled();
    const terminal = terminalInput(openTerminal);
    expect(terminal.executable).toBe("codex");
    expect(terminal.args).toEqual(
      expect.arrayContaining([
        "resume",
        "codex-new-thread",
        "Explain this code",
      ]),
    );
    await handle.detach();
  });
});

async function createLauncher(): Promise<{
  launcher: NativeReviewTurnLauncher;
  openTerminal: ReturnType<typeof vi.fn<(input: NativeTerminalInput) => void>>;
  startCodexThread: ReturnType<
    typeof vi.fn<NonNullable<NativeReviewTurnLauncherInput["startCodexThread"]>>
  >;
  forkCodexThread: ReturnType<
    typeof vi.fn<NonNullable<NativeReviewTurnLauncherInput["forkCodexThread"]>>
  >;
}> {
  const runtimeDirectory = await mkdtemp(
    path.join(tmpdir(), "review-native-launcher-"),
  );
  temporaryDirectories.push(runtimeDirectory);
  const openTerminal = vi.fn<(input: NativeTerminalInput) => void>();
  const startCodexThread = vi.fn<
    NonNullable<NativeReviewTurnLauncherInput["startCodexThread"]>
  >(async () => "codex-new-thread");
  const forkCodexThread = vi.fn<
    NonNullable<NativeReviewTurnLauncherInput["forkCodexThread"]>
  >(async () => "codex-forked-thread");
  return {
    launcher: new NativeReviewTurnLauncher({
      hookBaseUrl: "http://127.0.0.1:4000/hooks",
      hookToken: "secret",
      runtimeDirectory,
      startCodexThread,
      forkCodexThread,
      openTerminal: async (input) => openTerminal(input),
    }),
    openTerminal,
    startCodexThread,
    forkCodexThread,
  };
}

function terminalInput(
  openTerminal: ReturnType<typeof vi.fn<(input: NativeTerminalInput) => void>>,
): NativeTerminalInput {
  const input = openTerminal.mock.calls[0]?.[0];
  if (!input) throw new Error("Expected the native terminal to open.");
  return input;
}

function sessionIdAfter(args: readonly string[], flag: string): string {
  const index = args.indexOf(flag);
  const sessionId = args[index + 1];
  if (index < 0 || !sessionId) throw new Error(`Missing ${flag}.`);
  return sessionId;
}
