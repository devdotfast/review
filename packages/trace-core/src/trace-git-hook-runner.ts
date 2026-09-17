import type { Writable } from "node:stream";

import { git } from "@dev.fast/local-vcs";
import { sessionIdSchema } from "@dev.fast/trace-protocol";

import { errorMessage } from "./error-message";
import {
  readTrailerSessions,
  syncReviewTrace,
  writeReviewTraceCommitMapping,
} from "./review-agent-traces";
import {
  readActiveTraceSessions,
  writeTraceSessions,
} from "./trace-agent-sessions";
import type { TraceCommand, TraceScope } from "./trace-command";
import { spawnDetachedTraceSync } from "./trace-hook-runner";
import { findLocalTrace } from "./trace-local-sessions";
import { traceMachineEnabled } from "./trace-machine-setup";
import { selectTraceStorage } from "./trace-storage/resolve";

const ZERO_OID = /^0+$/;

export async function runTraceGitHook(input: {
  cwd: string;
  hook: string;
  args: string[];
  stdin?: NodeJS.ReadableStream;
  stderr: Writable;
  /** The resolved machine state for this CLI run. */
  scope: TraceScope;
  /** The command used for detached hosted sync. */
  traceCommand?: TraceCommand;
}): Promise<number> {
  if (input.scope.env.TRACE_DISABLE === "1") return 0;
  // The machine switch owns every capture path, including the git hooks.

  if (!(await traceMachineEnabled(input.scope))) return 0;

  try {
    if (input.hook === "prepare-commit-msg") {
      return runPrepareCommitMessage(input.cwd, input.args[0]);
    }

    if (input.hook === "pre-push") {
      await runPrePush(input);

      return 0;
    }
  } catch (cause) {
    input.stderr.write(`trace-sync: warning: ${errorMessage(cause)}\n`);
  }

  return 0;
}

async function runPrepareCommitMessage(
  cwd: string,
  messagePath: string | undefined,
): Promise<number> {
  if (!messagePath) return 0;
  const sessions = await activeSessions(cwd);

  for (const session of sessions) {
    await git(
      cwd,
      [
        "interpret-trailers",
        "--in-place",
        "--if-exists",
        "addIfDifferent",
        "--trailer",
        `Agent-Session: ${session}`,
        messagePath,
      ],
      { allowFailure: true },
    );
  }

  return 0;
}

async function activeSessions(cwd: string): Promise<string[]> {
  const fromEnv = (process.env.AGENT_SESSION_ID ?? "").trim();

  if (sessionIdSchema.safeParse(fromEnv).success) return [fromEnv];

  const fileResult = await git(
    cwd,
    ["rev-parse", "--git-path", "agent-session"],
    {
      allowFailure: true,
    },
  );

  if (!fileResult.ok) return [];
  const filePath = fileResult.stdout.trim();

  if (!filePath) return [];
  const sessions = await readActiveTraceSessions(filePath);
  await writeTraceSessions(filePath, sessions).catch(() => undefined);

  return [...sessions.keys()];
}

async function runPrePush(input: {
  cwd: string;
  stdin?: NodeJS.ReadableStream;
  stderr: Writable;
  scope: TraceScope;
  traceCommand?: TraceCommand;
}): Promise<void> {
  const raw = await readStdin(input.stdin);

  const commits = new Map<
    string,
    { branch: string | null; sessions: string[] }
  >();

  for (const line of raw.split("\n")) {
    const [localRef, localSha, remoteRef, remoteSha] = line.trim().split(/\s+/);

    if (
      !localRef ||
      !localSha ||
      !remoteRef ||
      !remoteSha ||
      ZERO_OID.test(localSha)
    )
      continue;

    const branch = remoteRef.startsWith("refs/heads/")
      ? remoteRef.slice("refs/heads/".length)
      : null;

    const revisionArgs = await revisionRange(input.cwd, localSha, remoteSha);

    const listed = await git(
      input.cwd,
      ["rev-list", "--max-count=500", ...revisionArgs],
      { allowFailure: true },
    );

    if (!listed.ok) continue;

    for (const commit of listed.stdout
      .split("\n")
      .map((value) => value.trim())
      .filter(Boolean)) {
      const sessions = await readTrailerSessions(input.cwd, commit);

      if (sessions.length > 0) commits.set(commit, { branch, sessions });
    }
  }

  if (commits.size === 0) return;

  const sessionCommits = new Map<string, string[]>();

  for (const [commit, value] of commits) {
    await writeReviewTraceCommitMapping({
      cwd: input.cwd,
      commit,
      sessions: value.sessions,
      branch: value.branch,
    }).catch((cause) => warn(input.stderr, cause));

    for (const session of value.sessions) {
      sessionCommits.set(session, [
        ...(sessionCommits.get(session) ?? []),
        commit,
      ]);
    }
  }

  const selection = selectTraceStorage(input.scope);

  for (const [sessionId, values] of sessionCommits) {
    // Pushed history can include sessions authored on another machine. Keep
    // their commit links, but only publish transcripts that exist locally.
    if (!(await findLocalTrace(sessionId))) continue;

    if (selection.mode === "hosted") {
      // A hosted publish may take minutes; a push never waits for it. The
      // detached sync discovers this session's commits from the trailers.
      spawnDetachedTraceSync({
        sessionId,
        cwd: input.cwd,
        scope: input.scope,
        command: input.traceCommand,
      });
      continue;
    }

    await syncReviewTrace({ sessionId, cwd: input.cwd, commits: values }).catch(
      (cause) => warn(input.stderr, cause),
    );
  }
}

async function revisionRange(
  cwd: string,
  localSha: string,
  remoteSha: string,
): Promise<string[]> {
  if (ZERO_OID.test(remoteSha)) return [localSha, "--not", "--remotes"];

  const remoteExists = await git(cwd, ["cat-file", "-e", remoteSha], {
    allowFailure: true,
  });

  return remoteExists.ok
    ? [`${remoteSha}..${localSha}`]
    : [localSha, "--not", "--remotes"];
}

async function readStdin(
  stdin: NodeJS.ReadableStream | undefined,
): Promise<string> {
  if (!stdin) return "";
  const chunks: Buffer[] = [];

  for await (const chunk of stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString("utf8");
}

function warn(stderr: Writable, cause: unknown): void {
  stderr.write(`trace-sync: warning: ${errorMessage(cause)}\n`);
}
