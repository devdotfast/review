import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

import type { ReviewAgentHarness, SessionRef } from "./authoring-session";

export const TUTORIAL_AGENT_INTRO_PROMPT = `<dev-review-system>
You are working in a frozen example directory for the dev-review tutorial. The user’s questions will follow.
</dev-review-system>`;

interface TutorialAgentCommandResult {
  stdout: string;
  stderr: string;
}

export type RunTutorialAgentCommand = (input: {
  executable: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
}) => Promise<TutorialAgentCommandResult>;

/**
 * Starts the small, genuine source session that authors the hidden tutorial
 * Review. Later questions use the ordinary Review fork/resume path.
 */
export async function createTutorialAgentSession(input: {
  harness: ReviewAgentHarness;
  rootPath: string;
  runCommand?: RunTutorialAgentCommand;
}): Promise<SessionRef> {
  const runCommand = input.runCommand ?? runTutorialAgentCommand;
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
          "Review tutorial source",
          "--permission-mode",
          "dontAsk",
          "--tools",
          "",
          "--disable-slash-commands",
          TUTORIAL_AGENT_INTRO_PROMPT,
        ],
        cwd: input.rootPath,
        env: {
          ...process.env,
          CLAUDE_CODE_FORCE_SESSION_PERSISTENCE: "1",
        },
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
          TUTORIAL_AGENT_INTRO_PROMPT,
        ],
        cwd: input.rootPath,
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
          "Review tutorial source",
          "--no-tools",
          "--no-extensions",
          "--no-skills",
          "--no-prompt-templates",
          "--no-themes",
          "--no-context-files",
          "--no-approve",
          TUTORIAL_AGENT_INTRO_PROMPT,
        ],
        cwd: input.rootPath,
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

function runTutorialAgentCommand(input: {
  executable: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
}): Promise<TutorialAgentCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(input.executable, input.args, {
      cwd: input.cwd,
      env: input.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout = `${stdout}${chunk}`.slice(-1_000_000);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-100_000);
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        new Error(
          `${input.executable} timed out while creating the tutorial source session.`,
        ),
      );
    }, 120_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      const detail = stderr.trim();
      reject(
        new Error(
          `${input.executable} could not create the tutorial source session${detail ? `: ${detail}` : "."}`,
        ),
      );
    });
  });
}
