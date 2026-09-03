import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  type JsonObject,
  isJsonObject,
  parseJsonText,
} from "@dev.fast/review-protocol";

import type { SessionRef } from "./authoring-session";
import { errorMessage } from "./error-message";
import { findClaudeTranscript } from "./native-agent/claude-transcript";
import { forkCodexThread } from "./native-agent/codex-app-server";

/**
 * Fork the invoking session at publish and bind the frozen copy to the
 * Review. Every new thread forks that copy, so it must hold the finished
 * authoring context: the change, the drafted document, and the publish.
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
    .map((line) => {
      const record = parseJsonText(line);
      if (!isJsonObject(record)) {
        throw new Error(
          `Claude transcript ${sourcePath} has a non-object line.`,
        );
      }
      return record;
    });
  const fork = records.map((record) => {
    const forked: JsonObject = { ...record };
    if (record.sessionId !== undefined) forked.sessionId = sessionId;
    if (record.session_id !== undefined) forked.session_id = sessionId;
    if (record.cwd !== undefined) forked.cwd = input.rootPath;
    if (record.promptId !== undefined) forked.promptId = promptId;
    return forked;
  });
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
      reject(
        Object.assign(new Error(`Command timed out: pi ${args.join(" ")}`), {
          stderr,
        }),
      );
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
      reject(
        Object.assign(new Error(`Command failed: pi ${args.join(" ")}`), {
          stderr,
        }),
      );
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
      `Pi could not create the Review source session: ${commandFailure(error)}`,
      { cause: error },
    );
  }
  return { harness: "pi", sessionId };
}

/** The stderr a failed pi command reported, else its error message. */
function commandFailure(cause: unknown): string {
  if (cause instanceof Error && "stderr" in cause) {
    const stderr = String(cause.stderr).trim();
    if (stderr) return stderr;
  }
  return errorMessage(cause);
}
