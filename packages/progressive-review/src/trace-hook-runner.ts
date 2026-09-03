import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { git } from "@dev.fast/local-vcs";
import {
  jsonObject,
  jsonString,
  parseJsonText,
} from "@dev.fast/review-protocol";

import type { CliInputStream } from "./cli-output";
import { inferRepoFromGit } from "./review-agent-traces";
import { devReviewHome } from "./review-storage";
import {
  readActiveTraceSessions,
  writeTraceSessions,
} from "./trace-agent-sessions";
import { enableTraceRepository } from "./trace-repository-hooks";
import {
  type TraceRepositoryEntry,
  findTraceRepository,
  readTraceUserConfig,
} from "./trace-user-config";

const execFileAsync = promisify(execFile);

const SESSION_ID_REGEX = /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/;

/**
 * The repository the current user allowed for trace publishing, or null
 * when this directory is not a GitHub repository or has no allow entry.
 * The session hook gate and `review trace status` both read this.
 */
export async function resolveAllowedTraceRepository(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<TraceRepositoryEntry | null> {
  let owner: string;
  let repo: string;
  try {
    ({ owner, repo } = await inferRepoFromGit(cwd));
  } catch {
    return null;
  }
  const config = await readTraceUserConfig(devReviewHome(env));
  return findTraceRepository(config, `${owner}/${repo}`);
}

export interface RunReviewTraceHookInput {
  cwd: string;
  event: string;
  sessionId?: string;
  stdin?: CliInputStream;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
}

export async function runReviewTraceHook(
  input: RunReviewTraceHookInput,
): Promise<number> {
  if (process.env.TRACE_DISABLE === "1") {
    return 0;
  }
  const entry = await resolveAllowedTraceRepository(input.cwd, input.env);
  if (!entry) return 0;

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

  sessionId = (sessionId || process.env.AGENT_SESSION_ID || "").trim();
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

  if (isStart) {
    await enableTraceRepository({
      cwd: input.cwd,
      homeDir: input.homeDir,
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

  // 3. On SessionEnd: detached background sync to the hosted trace store
  if (isEnd) {
    try {
      const installedCommand = path.join(
        input.homeDir ?? process.env.TRACE_HOME_DIR ?? os.homedir(),
        ".local",
        "bin",
        "review",
      );
      const command =
        process.env.REVIEW_TRACE_COMMAND ??
        (existsSync(installedCommand) ? installedCommand : "review");
      const child = spawn(command, ["trace", "sync", sessionId], {
        cwd: input.cwd,
        detached: true,
        stdio: "ignore",
      });
      child.unref();
    } catch {
      // Ignore sync spawn errors
    }
  }

  return 0;
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
