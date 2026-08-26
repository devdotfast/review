import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

import { type ReviewAgentHarness, type SessionRef } from "./authoring-session";

const TUTORIAL_AUTHORING_TIMEOUT_MS = 120_000;

interface TutorialAuthoringCommandResult {
  stdout: string;
  stderr: string;
}

export type RunTutorialAuthoringCommand = (input: {
  executable: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}) => Promise<TutorialAuthoringCommandResult>;

export function tutorialAuthoringPrompt(): string {
  return "You are continuing from a pre-bundled Review tutorial. The review encompases a sample codebase and is meant to show the new user the various featurs of Review. Because the user installed Review, they are thoughtful about the code they ship and want to take ownership of their architecture! the next message will be the user commenting on the sample commit diff";
}

/** Creates the genuine source session that later tutorial questions fork. */
export async function createTutorialAuthoringSession(input: {
  harness: ReviewAgentHarness;
  rootPath: string;
  signal?: AbortSignal;
  runCommand?: RunTutorialAuthoringCommand;
}): Promise<SessionRef> {
  const runCommand = input.runCommand ?? runTutorialAuthoringCommand;
  const prompt = tutorialAuthoringPrompt();
  switch (input.harness) {
    case "claude-code": {
      const sessionId = randomUUID();
      await runCommand({
        executable: "claude",
        args: [
          "--print",
          "--session-id",
          sessionId,
          "--name",
          "Review tutorial authoring",
          "--permission-mode",
          "dontAsk",
          "--tools",
          "",
          "--disable-slash-commands",
          prompt,
        ],
        cwd: input.rootPath,
        env: {
          ...process.env,
          CLAUDE_CODE_FORCE_SESSION_PERSISTENCE: "1",
        },
        signal: input.signal,
      });
      return { harness: input.harness, sessionId };
    }
    case "codex": {
      const result = await runCommand({
        executable: "codex",
        args: [
          "exec",
          "--json",
          "--sandbox",
          "read-only",
          "--skip-git-repo-check",
          prompt,
        ],
        cwd: input.rootPath,
        signal: input.signal,
      });
      return {
        harness: input.harness,
        sessionId: codexThreadId(result.stdout),
      };
    }
    case "pi": {
      const sessionId = randomUUID();
      await runCommand({
        executable: "pi",
        args: [
          "--print",
          "--session-id",
          sessionId,
          "--name",
          "Review tutorial authoring",
          "--tools",
          "",
          "--no-extensions",
          "--no-skills",
          "--no-prompt-templates",
          "--no-themes",
          "--no-context-files",
          prompt,
        ],
        cwd: input.rootPath,
        signal: input.signal,
      });
      return { harness: input.harness, sessionId };
    }
  }
}

function codexThreadId(output: string): string {
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (
      typeof value === "object" &&
      value !== null &&
      "type" in value &&
      value.type === "thread.started" &&
      "thread_id" in value &&
      typeof value.thread_id === "string" &&
      value.thread_id
    ) {
      return value.thread_id;
    }
  }
  throw new Error("Codex did not report the tutorial source thread ID.");
}

function runTutorialAuthoringCommand(input: {
  executable: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}): Promise<TutorialAuthoringCommandResult> {
  return new Promise((resolve, reject) => {
    if (input.signal?.aborted) {
      reject(new Error("Tutorial authoring session creation was canceled."));
      return;
    }
    const child = spawn(input.executable, input.args, {
      cwd: input.cwd,
      env: input.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const settle = (operation: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", onAbort);
      operation();
    };
    const onAbort = () => {
      child.kill("SIGKILL");
      settle(() =>
        reject(new Error("Tutorial authoring session creation was canceled.")),
      );
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      settle(() =>
        reject(
          new Error(
            `${input.executable} timed out while creating the tutorial authoring session.`,
          ),
        ),
      );
    }, TUTORIAL_AUTHORING_TIMEOUT_MS);
    input.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout = `${stdout}${chunk}`.slice(-1_000_000);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-100_000);
    });
    child.once("error", (error) => settle(() => reject(error)));
    child.once("close", (code) => {
      settle(() => {
        if (code === 0) {
          resolve({ stdout, stderr });
          return;
        }
        const detail = stderr.trim();
        reject(
          new Error(
            `${input.executable} could not create the tutorial authoring session${detail ? `: ${detail}` : "."}`,
          ),
        );
      });
    });
  });
}
