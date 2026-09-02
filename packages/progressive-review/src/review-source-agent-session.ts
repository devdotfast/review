import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { SessionRef } from "./authoring-session";
import { findClaudeTranscript } from "./native-agent/claude-transcript";
import { forkCodexThread } from "./native-agent/codex-app-server";
import { forkOpencodeSession } from "./native-agent/opencode";

/**
 * Fork the invoking session once and bind the frozen copy to the Review.
 *
 * Each harness writes a native fork without sending a user message. No model
 * is ever named here, so the fork keeps the invoking session's model.
 */
export async function createReviewSourceAgentSession(input: {
  agent: SessionRef;
  reviewUuid: string;
  rootPath: string;
}): Promise<SessionRef> {
  if (input.agent.harness === "claude-code") {
    return createClaudeReviewSourceSession(input);
  }
  if (input.agent.harness === "pi") {
    return createPiReviewSourceSession(input);
  }
  if (input.agent.harness === "opencode") {
    return {
      harness: "opencode",
      sessionId: await forkOpencodeSession({
        sourceSessionId: input.agent.sessionId,
        cwd: input.rootPath,
      }),
    };
  }
  return {
    harness: "codex",
    sessionId: await forkCodexThread({
      sourceThreadId: input.agent.sessionId,
      cwd: input.rootPath,
    }),
  };
}

/**
 * Claude does not persist a CLI fork until it receives a user message. Copy
 * its native transcript instead, so publish can pin the transcript without a
 * model turn. The first Review question then forks this frozen transcript
 * through the user's Claude binary.
 */
async function createClaudeReviewSourceSession(input: {
  agent: SessionRef;
  rootPath: string;
}): Promise<SessionRef> {
  const sourcePath = await findClaudeTranscript(input.agent.sessionId);
  const sessionId = randomUUID();
  const promptId = randomUUID();
  const source = await readFile(sourcePath, "utf8");
  const records = source
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const fork = records.map((record) => ({
    ...record,
    ...(record.sessionId === undefined ? {} : { sessionId }),
    ...(record.session_id === undefined ? {} : { session_id: sessionId }),
    ...(record.cwd === undefined ? {} : { cwd: input.rootPath }),
    ...(record.promptId === undefined ? {} : { promptId }),
  }));
  await writeFile(
    join(dirname(sourcePath), `${sessionId}.jsonl`),
    `${fork.map((record) => JSON.stringify(record)).join("\n")}\n`,
    { encoding: "utf8", flag: "wx" },
  );
  return { harness: "claude-code", sessionId };
}

/**
 * Run the Pi CLI with a closed stdin. `execFile` cannot work here: it always
 * pipes stdin and never closes it, and `pi --print` waits for stdin to close
 * before it starts, so the child would hang until the timeout.
 */
function runPiProcess(
  args: string[],
  options: { cwd: string; timeout: number },
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("pi", args, {
      cwd: options.cwd,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      const error = new Error(`Command timed out: pi ${args.join(" ")}`);
      (error as { stderr?: string }).stderr = stderr;
      reject(error);
    }, options.timeout);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
        return;
      }
      const error = new Error(`Command failed: pi ${args.join(" ")}`);
      (error as { stderr?: string }).stderr = stderr;
      reject(error);
    });
  });
}

/** Fork Pi through the user's installed command. */
async function createPiReviewSourceSession(input: {
  agent: SessionRef;
  reviewUuid: string;
  rootPath: string;
}): Promise<SessionRef> {
  const sessionId = randomUUID();
  try {
    await runPiProcess(
      [
        "--fork",
        input.agent.sessionId,
        "--session-id",
        sessionId,
        "--name",
        `Review ${input.reviewUuid} source`,
        // User extensions (pi-subagents) can block startup on a forked
        // session. The frozen source does not run any tools.
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        "--no-themes",
        "--no-context-files",
        "--offline",
        "--print",
      ],
      {
        cwd: input.rootPath,
        timeout: 120_000,
      },
    );
  } catch (error) {
    throw new Error(
      `Pi could not create the Review source session: ${commandError(error)}`,
      { cause: error },
    );
  }
  return { harness: "pi", sessionId };
}

function commandError(error: unknown): string {
  if (typeof error === "object" && error !== null && "stderr" in error) {
    const stderr = String(error.stderr).trim();
    if (stderr) return stderr;
  }
  return error instanceof Error ? error.message : String(error);
}
