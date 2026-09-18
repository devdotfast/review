import { execFile, spawn } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { jsonObject, jsonString, parseJsonText } from "@dev.fast/json";
import { git } from "@dev.fast/local-vcs";

import type { CliInputStream } from "./cli-output";
import { readStoreAuth } from "./store-auth";
import {
  readActiveTraceSessions,
  writeTraceSessions,
} from "./trace-agent-sessions";
import {
  type TraceCommand,
  type TraceScope,
  resolveTraceCommand,
  traceCliName,
} from "./trace-command";
import {
  type TraceRepositoryConsent,
  findTraceRepository,
  readTraceUserConfig,
} from "./trace-consent";
import { traceHooksDisabled } from "./trace-hook-ownership";
import { traceMachineEnabled } from "./trace-machine-setup";
import { inferRepoFromGit, traceRepoName } from "./trace-repo";
import { enableTraceRepository } from "./trace-repository-hooks";
import { gitCommonDirectory } from "./trace-repository-target";
import {
  type TraceCaptureIdentity,
  recordTraceSessionProvenance,
  traceCaptureIdentity,
} from "./trace-session-provenance";
import {
  selectTraceStorage,
  traceStorageExpectation,
} from "./trace-storage/resolve";

const execFileAsync = promisify(execFile);

const SESSION_ID_REGEX = /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/;

/**
 * Starts `review trace sync` detached for one session. The attempt names
 * the destination it was started for; the sync rechecks the selection and
 * consent before any transfer. A missing CLI reports asynchronously and
 * never fails the caller.
 */
export function spawnDetachedTraceSync(input: {
  sessionId: string;
  cwd: string;
  scope: TraceScope;
  /** The binary to re-enter; the resolved default when absent. */
  command?: TraceCommand;
}): void {
  try {
    const command = resolveTraceCommand({
      explicit: input.command,
      env: input.scope.env,
      homeDir: input.scope.homeDir,
    });

    const expectation = traceStorageExpectation(input.scope);

    const child = spawn(
      command.file,
      [
        ...(command.args ?? []),
        "trace",
        "sync",
        input.sessionId,
        "--expect-storage",
        expectation,
      ],
      { cwd: input.cwd, detached: true, stdio: "ignore" },
    );

    child.on("error", () => {});
    child.unref();
  } catch {
    // Ignore sync spawn errors
  }
}

export interface RunTraceHookInput {
  cwd: string;
  event: string;
  sessionId?: string;
  stdin?: CliInputStream;
  scope: TraceScope;
  /** The command installed in repository hooks and used for detached sync. */
  traceCommand?: TraceCommand;
}

export async function runTraceHook(input: RunTraceHookInput): Promise<number> {
  const owner = traceCliName();

  if (
    (owner === "review" || owner === "dev-traces") &&
    traceHooksDisabled(owner, input.scope.homeDir)
  )
    return 0;

  if (input.scope.env.TRACE_DISABLE === "1") {
    return 0;
  }

  // The machine switch comes first and has one owner. Hosted capture is
  // gated again per repository below, after the session is known, because
  // provenance must be recorded either way.
  const selection = selectTraceStorage(input.scope);

  if (selection.error || selection.mode === "none") return 0;

  if (!(await traceMachineEnabled(input.scope))) {
    return 0;
  }

  let event = input.event;
  let sessionId = input.sessionId;

  // If stdin is provided, attempt to read JSON payload (Claude Code / Codex hook format)
  if (input.stdin && !input.stdin.isTTY) {
    try {
      const chunks: Buffer[] = [];

      for await (const chunk of input.stdin) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }

      const raw = Buffer.concat(chunks).toString("utf8").trim();

      if (raw) {
        const parsed = jsonObject(parseJsonText(raw));
        const hookEventName = jsonString(parsed?.hook_event_name);
        const parsedSessionId = jsonString(parsed?.session_id);

        if (hookEventName) event = hookEventName;

        if (parsedSessionId) sessionId = parsedSessionId;
      }
    } catch {
      // Ignore JSON parse errors from stdin
    }
  }

  sessionId = (sessionId || input.scope.env.AGENT_SESSION_ID || "").trim();

  if (!sessionId || !SESSION_ID_REGEX.test(sessionId)) {
    return 0;
  }

  const normalizedEvent = event.toLowerCase().replaceAll(/[_-]/g, "");
  const isStart = normalizedEvent === "sessionstart";
  const isEnd = normalizedEvent === "sessionend";

  const isHeartbeat =
    normalizedEvent === "userpromptsubmit" || normalizedEvent === "turnstart";

  if (!isStart && !isEnd && !isHeartbeat) {
    return 0;
  }

  if (selection.mode === "hosted") {
    // Every checkout the session touches leaves a mark, allowed or not, so
    // a later publication can tell a session that stayed in one allowed
    // repository from one that also ran somewhere the user did not allow.
    const origin = selection.hosted?.origin ?? "";

    const entry = await resolveAllowedTraceRepository(input.cwd, input.scope);

    await recordCaptureProvenance({
      cwd: input.cwd,
      sessionId,
      entry,
      origin,
      scope: input.scope,
    }).catch(() => undefined);

    if (!entry || !entry.enabledOrigins.includes(origin)) return 0;
  }

  if (isStart) {
    await enableTraceRepository({
      cwd: input.cwd,
      scope: input.scope,
      reviewCommand: input.traceCommand,
    }).catch(() => undefined);
  }

  // 1. Git agent-session file handling
  const gitPathResult = await git(
    input.cwd,
    ["rev-parse", "--git-path", "agent-session"],
    { allowFailure: true },
  );

  let sessionFilePath: string | null = null;

  if (gitPathResult.ok && gitPathResult.stdout.trim()) {
    sessionFilePath = gitPathResult.stdout.trim();
  }

  const jjRootResult = await execFileAsync("jj", ["root"], {
    cwd: input.cwd,
  }).catch(() => null);

  if (!sessionFilePath && jjRootResult?.stdout.trim()) {
    sessionFilePath = path.join(
      jjRootResult.stdout.trim(),
      ".jj",
      "agent-session",
    );
  }

  let remainingSessions: string[] = [];

  if (sessionFilePath) {
    const now = Date.now();
    const currentSessions = await readActiveTraceSessions(sessionFilePath, now);

    if (isStart || isHeartbeat) {
      currentSessions.set(sessionId, now);
      remainingSessions = [...currentSessions.keys()];
      await writeTraceSessions(sessionFilePath, currentSessions).catch(
        () => undefined,
      );
    } else if (isEnd) {
      currentSessions.delete(sessionId);
      remainingSessions = [...currentSessions.keys()];
      await writeTraceSessions(sessionFilePath, currentSessions).catch(
        () => undefined,
      );
    }
  }

  // 2. Jujutsu (jj) templates.commit_trailers mirror handling
  if (jjRootResult?.stdout.trim()) {
    if ((isStart || isHeartbeat) && remainingSessions.length > 0) {
      const templateVal = jjCommitTrailersConfigValue(remainingSessions);
      await execFileAsync(
        "jj",
        ["config", "set", "--repo", "templates.commit_trailers", templateVal],
        { cwd: input.cwd },
      ).catch(() => undefined);
    } else if (isEnd) {
      if (remainingSessions.length > 0) {
        const templateVal = jjCommitTrailersConfigValue(remainingSessions);
        await execFileAsync(
          "jj",
          ["config", "set", "--repo", "templates.commit_trailers", templateVal],
          { cwd: input.cwd },
        ).catch(() => undefined);
      } else {
        await execFileAsync(
          "jj",
          ["config", "unset", "--repo", "templates.commit_trailers"],
          { cwd: input.cwd },
        ).catch(() => undefined);
      }
    }
  }

  // 3. On SessionEnd: detached background trace sync to the selected store
  if (isEnd) {
    spawnDetachedTraceSync({
      sessionId,
      cwd: input.cwd,
      scope: input.scope,
      command: input.traceCommand,
    });
  }

  return 0;
}

/**
 * The consent entry for this checkout's repository, or null when the
 * directory is not a GitHub repository or has no entry.
 */
export async function resolveAllowedTraceRepository(
  cwd: string,
  scope: TraceScope,
): Promise<TraceRepositoryConsent | null> {
  let name: string;

  try {
    name = traceRepoName(await inferRepoFromGit(cwd));
  } catch {
    return null;
  }

  const config = await readTraceUserConfig(scope.devHome);

  return findTraceRepository(config, name);
}

/**
 * Records where this session ran. The identity is the allowed target when
 * the entry names the selected store and the login matches it; otherwise
 * the repository, or the Git directory of a checkout without a remote.
 */
async function recordCaptureProvenance(input: {
  cwd: string;
  sessionId: string;
  entry: TraceRepositoryConsent | null;
  origin: string;
  scope: TraceScope;
}): Promise<void> {
  const auth = await readStoreAuth(input.scope.env);
  let identity: TraceCaptureIdentity;

  if (
    input.entry &&
    input.entry.enabledOrigins.includes(input.origin) &&
    auth &&
    auth.origin === input.origin
  ) {
    identity = traceCaptureIdentity({
      target: {
        origin: input.origin,
        repositoryId: input.entry.repositoryId,
      },
    });
  } else {
    const repo = await inferRepoFromGit(input.cwd).catch(() => null);

    if (repo) {
      identity = traceCaptureIdentity({ repositoryName: traceRepoName(repo) });
    } else {
      const gitDir = await gitCommonDirectory(input.cwd);

      if (!gitDir) return;
      identity = traceCaptureIdentity({ gitDir });
    }
  }

  await recordTraceSessionProvenance({
    sessionId: input.sessionId,
    ...identity,
    devHome: input.scope.devHome,
  });
}

function jjCommitTrailersConfigValue(sessionIds: readonly string[]): string {
  const trailers = `${sessionIds
    .map((id) => `Agent-Session: ${id}`)
    .join("\n")}\n`;

  // `jj config set` parses TOML first. Jujutsu then parses the stored string
  // as a template, so the trailer text needs one quote layer for each parser.
  const templateExpression = JSON.stringify(trailers);

  return JSON.stringify(templateExpression);
}
