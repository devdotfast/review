import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";

import { withFileLock } from "@dev.fast/trace-core";
import { jsonObject, parseJsonText } from "@dev.fast/whiteboard-protocol";

// Dependency preparation for pinned worktrees. The repo owner configures the
// commands once per clone (`git config devfast.prepare '<command>'`, the key
// is multi-valued and ordered); Review runs them opaquely with the worktree as
// the working directory. A marker beside the worktree records the command-list
// hash, so a tree prepares once per commit and re-prepares when the
// configuration changes. Failure is soft by design: the caller warns and
// indexes the unprepared tree, which is today's quality — a broken install
// must never block review.

const PREPARE_LOCK_RETRY_MS = 250;

const PREPARE_LOCK_STALE_MS = 30 * 60_000;

const PREPARE_LOCK_TIMEOUT_MS = 1000;

const PREPARE_LOCK_UNOWNED_GRACE_MS = 1_000;

const PREPARE_OUTPUT_TAIL_LINES = 20;

export interface PrepareCommandResult {
  exitCode: number | null;
  /** Combined stdout+stderr, bounded to the most recent output. */
  output?: string;
}

export interface PrepareWhiteboardPinnedCheckoutInput {
  checkoutPath: string;
  commit: string;
  commands: readonly string[];
  warning?: (message: string) => void;
  signal?: AbortSignal;
  progress?: (log: string) => void;
  timeoutMs?: number;
  /** Test seam: replaces the shell execution of one prepare command. */
  runCommand?: (command: string, cwd: string) => Promise<PrepareCommandResult>;
}

/** The marker file that records a completed prepare, beside the worktree. */
export function whiteboardPrepareMarkerPath(checkoutPath: string): string {
  return `${checkoutPath}.prepared`;
}

/** The failure log written beside the worktree when a prepare command fails. */
export function whiteboardPrepareLogPath(checkoutPath: string): string {
  return `${checkoutPath}.prepare-log`;
}

export function whiteboardPrepareCommandsHash(
  commands: readonly string[],
): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(commands))
    .digest("hex")
    .slice(0, 16);
}

// A tree that ceases to exist takes its prepare state with it: the caller
// removes these artifacts on every checkout removal or recreation, so a fresh
// bare tree can never inherit a marker that claims it is prepared.
export async function removeWhiteboardPrepareArtifacts(
  checkoutPath: string,
): Promise<void> {
  await rm(whiteboardPrepareMarkerPath(checkoutPath), { force: true });
  await rm(whiteboardPrepareLogPath(checkoutPath), { force: true });
}

// Run the configured prepare commands in order inside the pinned checkout.
// Returns whether the tree is prepared for exactly this command list. On the
// first failing command: warn with the commit, the command, and the output
// tail; write the captured output beside the worktree; leave no marker; and
// return unprepared — the caller continues against the bare tree.
export async function prepareWhiteboardPinnedCheckout(
  input: PrepareWhiteboardPinnedCheckoutInput,
): Promise<{ prepared: boolean }> {
  if (input.commands.length === 0) return { prepared: false };
  const markerPath = whiteboardPrepareMarkerPath(input.checkoutPath);
  const expectedHash = whiteboardPrepareCommandsHash(input.commands);

  if (await markerMatches(markerPath, expectedHash)) {
    return { prepared: true };
  }

  const outcome = await withFileLock(
    `${input.checkoutPath}.prepare-lock`,
    {
      retryMs: PREPARE_LOCK_RETRY_MS,
      staleMs: PREPARE_LOCK_STALE_MS,
      heartbeatMs: 5000,
      timeoutMs: PREPARE_LOCK_TIMEOUT_MS,
      unownedGraceMs: PREPARE_LOCK_UNOWNED_GRACE_MS,
    },
    async () => {
      if (await markerMatches(markerPath, expectedHash)) {
        return { prepared: true };
      }

      // A stale marker from an older command list must not survive a failed
      // re-prepare: remove it before the first command runs.
      await rm(markerPath, { force: true });

      const runCommand =
        input.runCommand ??
        (async (command: string, cwd: string) => {
          const output = await runPrepareCommand(
            command,
            cwd,
            input.progress ?? (() => {}),
            input.signal ?? new AbortController().signal,
            input.timeoutMs,
          );

          return { exitCode: 0, output };
        });

      for (const command of input.commands) {
        const result = await runCommand(command, input.checkoutPath).catch(
          (cause: unknown) => ({
            exitCode: null,
            output: cause instanceof Error ? cause.message : String(cause),
          }),
        );

        if (result.exitCode !== 0) {
          const exit =
            result.exitCode === null
              ? "no exit code"
              : `exit ${result.exitCode}`;

          // The log is written whether or not anyone listens for warnings:
          // it is the durable diagnostic for a failure the caller soft-skips.
          const logNote = await writePrepareFailureLog(
            input.checkoutPath,
            result.output,
          );

          input.warning?.(
            formatPrepareFailure({
              commit: input.commit,
              command,
              exit,
              output: result.output,
              logNote,
            }),
          );

          return { prepared: false };
        }
      }

      await rm(whiteboardPrepareLogPath(input.checkoutPath), { force: true });
      await writeFile(
        markerPath,
        JSON.stringify({ commandsHash: expectedHash, preparedAt: Date.now() }),
        "utf8",
      );

      return { prepared: true };
    },
  );

  if (!outcome.acquired) {
    input.warning?.(
      `devfast.prepare skipped for commit ${input.commit.slice(0, 12)}: another process holds the prepare lock. Language features use the unprepared pinned checkout.`,
    );

    return { prepared: false };
  }

  return outcome.result;
}

async function writePrepareFailureLog(
  checkoutPath: string,
  output: string | undefined,
): Promise<string> {
  const trimmed = output?.trimEnd();

  if (!trimmed) return "";
  const logPath = whiteboardPrepareLogPath(checkoutPath);

  return writeFile(logPath, `${trimmed}\n`, "utf8")
    .then(() => ` Full output: ${logPath}.`)
    .catch(() => "");
}

function formatPrepareFailure(input: {
  commit: string;
  command: string;
  exit: string;
  output: string | undefined;
  logNote: string;
}): string {
  const base = `devfast.prepare failed for commit ${input.commit.slice(0, 12)} (${input.exit}): ${input.command}. Language features use the unprepared pinned checkout.`;
  const output = input.output?.trimEnd();

  if (!output) return base;
  const lines = output.split("\n");
  const tail = lines.slice(-PREPARE_OUTPUT_TAIL_LINES).join("\n");
  const elided = lines.length > PREPARE_OUTPUT_TAIL_LINES ? "…\n" : "";

  return `${base} Last output:\n${elided}${tail}${input.logNote}`;
}

export async function markerMatches(
  markerPath: string,
  expectedHash: string,
): Promise<boolean> {
  return readFile(markerPath, "utf8")
    .then(
      (contents) =>
        jsonObject(parseJsonText(contents))?.commandsHash === expectedHash,
    )
    .catch(() => false);
}

// Process lifecycle adapted from Milan’s managed-workspaces implementation (#334).
export function runPrepareCommand(
  command: string,
  cwd: string,
  progress: (log: string) => void,
  signal: AbortSignal,
  timeoutMs = 15 * 60_000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    let output = "";

    const child = spawn(command, {
      cwd,
      shell: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });

    let interrupted: Error | undefined;
    let force: ReturnType<typeof setTimeout> | undefined;

    const kill = (signal: NodeJS.Signals) => {
      try {
        if (process.platform !== "win32" && child.pid)
          process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        /* The process may already have exited. */
      }
    };

    const stop = (reason: Error) => {
      interrupted = reason;
      kill("SIGTERM");
      force ??= setTimeout(() => kill("SIGKILL"), 2000);
      force.unref();
    };

    const abort = () =>
      stop(new Error("Project command interrupted by shutdown."));

    signal.addEventListener("abort", abort, { once: true });

    const timeout = setTimeout(
      () => stop(new Error("Project preparation timed out.")),
      timeoutMs,
    );

    timeout.unref();

    const append = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-64_000);
      progress(output);
    };

    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timeout);
      clearTimeout(force);
      signal.removeEventListener("abort", abort);

      if (interrupted) reject(new Error(`${interrupted.message}\n${output}`));
      else if (code === 0) resolve(output);
      else reject(new Error(`Command exited with ${code}.\n${output}`));
    });
  });
}
