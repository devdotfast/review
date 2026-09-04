import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { jsonObject, parseJsonText } from "@dev.fast/review-protocol";

import { withFileLock } from "./with-file-lock";

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
const PREPARE_LOCK_TIMEOUT_MS = 30 * 60_000;
const PREPARE_LOCK_UNOWNED_GRACE_MS = 1_000;
const PREPARE_OUTPUT_TAIL_LINES = 20;
const PREPARE_OUTPUT_BUFFER_BYTES = 256 * 1024;
// After the child exits, inherited stdio pipes may still emit `data` before
// `close`. Drain those post-exit bytes for this long, then settle, so a
// leaky descendant that writes after the shell exits appears in the captured
// output without risking a perpetual hang if a long-lived descendant holds
// the pipe open.
export const PREPARE_OUTPUT_DRAIN_GRACE_MS = 500;

export interface PrepareCommandResult {
  exitCode: number | null;
  /** Combined stdout+stderr, bounded to the most recent output. */
  output?: string;
}

export interface PrepareReviewPinnedCheckoutInput {
  checkoutPath: string;
  commit: string;
  commands: readonly string[];
  warning?: (message: string) => void;
  /** Test seam: replaces the shell execution of one prepare command. */
  runCommand?: (command: string, cwd: string) => Promise<PrepareCommandResult>;
}

/** The marker file that records a completed prepare, beside the worktree. */
export function reviewPrepareMarkerPath(checkoutPath: string): string {
  return `${checkoutPath}.prepared`;
}

/** The failure log written beside the worktree when a prepare command fails. */
export function reviewPrepareLogPath(checkoutPath: string): string {
  return `${checkoutPath}.prepare-log`;
}

export function reviewPrepareCommandsHash(commands: readonly string[]): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(commands))
    .digest("hex")
    .slice(0, 16);
}

// A tree that ceases to exist takes its prepare state with it: the caller
// removes these artifacts on every checkout removal or recreation, so a fresh
// bare tree can never inherit a marker that claims it is prepared.
export async function removeReviewPrepareArtifacts(
  checkoutPath: string,
): Promise<void> {
  await rm(reviewPrepareMarkerPath(checkoutPath), { force: true });
  await rm(reviewPrepareLogPath(checkoutPath), { force: true });
}

// Run the configured prepare commands in order inside the pinned checkout.
// Returns whether the tree is prepared for exactly this command list. On the
// first failing command: warn with the commit, the command, and the output
// tail; write the captured output beside the worktree; leave no marker; and
// return unprepared — the caller continues against the bare tree.
export async function prepareReviewPinnedCheckout(
  input: PrepareReviewPinnedCheckoutInput,
): Promise<{ prepared: boolean }> {
  if (input.commands.length === 0) return { prepared: false };
  const markerPath = reviewPrepareMarkerPath(input.checkoutPath);
  const expectedHash = reviewPrepareCommandsHash(input.commands);
  if (await markerMatches(markerPath, expectedHash)) {
    return { prepared: true };
  }
  const outcome = await withFileLock(
    `${input.checkoutPath}.prepare-lock`,
    {
      retryMs: PREPARE_LOCK_RETRY_MS,
      staleMs: PREPARE_LOCK_STALE_MS,
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
      const runCommand = input.runCommand ?? runPrepareShellCommand;
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
      await rm(reviewPrepareLogPath(input.checkoutPath), { force: true });
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
      `devfast.prepare skipped for commit ${input.commit.slice(0, 12)}: another process holds the prepare lock. Review indexes the unprepared tree.`,
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
  const logPath = reviewPrepareLogPath(checkoutPath);
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
  const base = `devfast.prepare failed for commit ${input.commit.slice(0, 12)} (${input.exit}): ${input.command}. Review indexes the unprepared tree.`;
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

export interface SpawnReviewPrepareBackgroundInput {
  checkoutPath: string;
  commit: string;
  cliEntryPath?: string;
  env?: NodeJS.ProcessEnv;
}

export function resolveReviewPrepareCliEntryPath(
  input: Pick<SpawnReviewPrepareBackgroundInput, "cliEntryPath" | "env">,
): string | undefined {
  const configuredEntry =
    input.cliEntryPath ??
    input.env?.DEV_FAST_REVIEW_CLI_ENTRY_PATH ??
    process.env.DEV_FAST_REVIEW_CLI_ENTRY_PATH;
  if (configuredEntry) return configuredEntry;

  const serverEntry =
    input.env?.DEV_FAST_REVIEW_SERVER_ENTRY ??
    process.env.DEV_FAST_REVIEW_SERVER_ENTRY;
  if (serverEntry) {
    return path.resolve(path.dirname(serverEntry), "..", "cli.js");
  }

  return process.argv[1];
}

export function spawnReviewPrepareBackground(
  input: SpawnReviewPrepareBackgroundInput,
): void {
  const cliEntryPath = resolveReviewPrepareCliEntryPath(input);
  if (!cliEntryPath) return;

  try {
    const child = spawn(
      process.execPath,
      [
        cliEntryPath,
        "prepare-worktree",
        path.resolve(input.checkoutPath),
        "--commit",
        input.commit,
      ],
      {
        cwd: input.checkoutPath,
        detached: true,
        env: {
          ...(input.env ?? process.env),
          DEV_FAST_REVIEW_CLI_NO_DELEGATE: "1",
          ELECTRON_RUN_AS_NODE: "1",
        },
        stdio: "ignore",
      },
    );
    child.unref();
  } catch {
    // Background preparation must never crash the caller.
  }
}

function runPrepareShellCommand(
  command: string,
  cwd: string,
): Promise<PrepareCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    // Keep only the most recent output so a chatty install cannot grow
    // memory without bound; the tail is what a failure warning needs.
    let output = "";
    const append = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.length > PREPARE_OUTPUT_BUFFER_BYTES) {
        output = output.slice(-PREPARE_OUTPUT_BUFFER_BYTES);
      }
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    // 'exit' means the child process ended; inherited stdio pipes may still
    // emit 'data' before 'close'. Resolving on 'exit' alone snapshots `output`
    // before those post-exit bytes, silently truncating the durable failure
    // log and warning. Settle on whichever comes first: 'close' (pipes
    // drained) or the bounded drain grace window — so a leaky descendant's
    // brief post-exit writes are captured, while a long-lived descendant
    // cannot hold the resolve open beyond the grace window.
    let exitCode: number | null = null;
    let settled = false;
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    const settle = (action: () => void) => {
      if (settled) return;
      settled = true;
      if (drainTimer) clearTimeout(drainTimer);
      action();
    };
    child.on("error", (cause) => settle(() => reject(cause)));
    child.on("exit", (code) => {
      exitCode = code;
      child.once("close", () => settle(() => resolve({ exitCode, output })));
      drainTimer = setTimeout(
        () => settle(() => resolve({ exitCode, output })),
        PREPARE_OUTPUT_DRAIN_GRACE_MS,
      );
    });
  });
}
