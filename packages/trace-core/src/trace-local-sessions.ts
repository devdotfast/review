import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { sessionIdSchema } from "@dev.fast/trace-protocol";

import {
  exportOpenCodeTrace,
  isOpenCodeSessionId,
} from "./opencode-trace-export";
import { isFile, listFilesRecursive } from "./trace-corpus";
import { devWhiteboardHome } from "./trace-home";
import { traceEnvValue as s3EnvValue } from "./trace-storage/s3-config";

export interface LocalTraceDiscovery {
  tracePath: string;
  harness: LocalTraceHarness;
  subagentPaths: Array<{ name: string; path: string }>;
}

export type LocalTraceHarness = "claude" | "codex" | "opencode" | "pi";

/** Finds a local harness transcript and subagents, exporting OpenCode data when needed; it never publishes traces. */
export async function findLocalTrace(
  sessionId: string,
): Promise<LocalTraceDiscovery | null> {
  if (!sessionIdSchema.safeParse(sessionId).success) return null;

  const claudeRoot =
    traceEnvValue("TRACE_LOCAL_TRACE_ROOT") ||
    path.join(homedir(), ".claude", "projects");

  const codexRoot = codexSessionsRoot();

  const piRoot =
    traceEnvValue("TRACE_PI_SESSIONS_ROOT") ||
    path.join(homedir(), ".pi", "agent", "sessions");

  let harness: LocalTraceHarness = "claude";
  let tracePath = findClaudeTrace(claudeRoot, sessionId);

  if (!tracePath) {
    tracePath = findCodexTrace(codexRoot, sessionId);

    if (tracePath) harness = "codex";
  }

  if (!tracePath) {
    tracePath = findPiTrace(piRoot, sessionId);

    if (tracePath) harness = "pi";
  }

  if (!tracePath) {
    if (
      existsSync(claudeRoot) &&
      isFile(path.join(claudeRoot, `${sessionId}.jsonl`))
    ) {
      tracePath = path.join(claudeRoot, `${sessionId}.jsonl`);
      harness = "claude";
    }
  }

  // OpenCode has no transcript file to find; the session is rendered fresh
  // from its database each time so a sync sees everything up to now.
  if (!tracePath && isOpenCodeSessionId(sessionId)) {
    tracePath = await exportOpenCodeTrace({
      sessionId,
      root:
        process.env.TRACE_OPENCODE_TRACES_ROOT ||
        path.join(devWhiteboardHome(), "opencode-traces"),
    });

    if (tracePath) harness = "opencode";
  }

  if (!tracePath) return null;

  const subagentPaths = findSubagentBlobs(tracePath);

  return { tracePath, harness, subagentPaths };
}

function findClaudeTrace(root: string, sessionId: string): string | null {
  const fileName = `${sessionId}.jsonl`;

  if (!existsSync(root)) return null;
  const direct = path.join(root, fileName);

  if (isFile(direct)) return direct;

  try {
    const entries = readdirSync(root, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const candidate = path.join(root, entry.name, fileName);

        if (isFile(candidate)) return candidate;
      }
    }
  } catch {
    // Ignore read errors
  }

  return null;
}

function findCodexTrace(root: string, sessionId: string): string | null {
  if (!existsSync(root)) return null;
  const suffix = `-${sessionId}.jsonl`;

  return (
    listFilesRecursive(root)
      .sort()
      .find((entry) => {
        const name = path.basename(entry);

        return name.startsWith("rollout-") && name.endsWith(suffix);
      }) ?? null
  );
}

/** Indexes Codex rollout paths by session ID, keeping the first sorted path for each ID without modifying the input. */
export function indexCodexTraceFiles(files: string[]): Map<string, string> {
  const index = new Map<string, string>();

  for (const entry of [...files].sort()) {
    const name = path.basename(entry);

    const match =
      /^rollout-.*-([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.jsonl$/i.exec(
        name,
      );

    if (match && !index.has(match[1])) index.set(match[1], entry);
  }

  return index;
}

function findPiTrace(root: string, sessionId: string): string | null {
  if (!existsSync(root)) return null;

  try {
    const entries = readdirSync(root, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const subDir = path.join(root, entry.name);

        for (const file of readdirSync(subDir)) {
          if (
            file.endsWith(`_${sessionId}.jsonl`) ||
            file === `${sessionId}.jsonl`
          ) {
            const candidate = path.join(subDir, file);

            if (isFile(candidate)) return candidate;
          }
        }
      } else if (entry.isFile()) {
        if (
          entry.name.endsWith(`_${sessionId}.jsonl`) ||
          entry.name === `${sessionId}.jsonl`
        ) {
          return path.join(root, entry.name);
        }
      }
    }
  } catch {
    // Ignore read errors
  }

  return null;
}

function findSubagentBlobs(
  tracePath: string,
): Array<{ name: string; path: string }> {
  const results: Array<{ name: string; path: string }> = [];

  const stem = tracePath.endsWith(".jsonl")
    ? tracePath.slice(0, -".jsonl".length)
    : tracePath;

  const subagentsDir = path.join(stem, "subagents");

  if (existsSync(subagentsDir)) {
    try {
      for (const name of readdirSync(subagentsDir)) {
        if (name.endsWith(".jsonl")) {
          results.push({ name, path: path.join(subagentsDir, name) });
        }
      }
    } catch {
      // Ignore directory read errors
    }
  }

  if (existsSync(stem)) {
    try {
      for (const childEntry of readdirSync(stem, { withFileTypes: true })) {
        if (childEntry.isDirectory() && childEntry.name !== "subagents") {
          const childDir = path.join(stem, childEntry.name);

          for (const runEntry of readdirSync(childDir, {
            withFileTypes: true,
          })) {
            if (runEntry.isDirectory() && runEntry.name.startsWith("run-")) {
              const runFile = path.join(
                childDir,
                runEntry.name,
                "session.jsonl",
              );

              if (isFile(runFile)) {
                const shortChild = childEntry.name.slice(0, 8);
                results.push({
                  name: `pi-${runEntry.name}-${shortChild}.jsonl`,
                  path: runFile,
                });
              }
            }
          }
        }
      }
    } catch {
      // Ignore Pi child directory read errors
    }
  }

  return results.sort((a, b) => a.name.localeCompare(b.name));
}

/** Reads a trace setting through the existing environment and saved-file resolver without changing configuration. */
export function traceEnvValue(name: string): string | undefined {
  return s3EnvValue(name);
}

/** Resolves the Codex session directory using the trace override or process CODEX_HOME, without reading CODEX_HOME from the trace env file. */
export function codexSessionsRoot(): string {
  const codexHome = process.env.CODEX_HOME;

  return (
    traceEnvValue("TRACE_CODEX_SESSIONS_ROOT") ||
    path.join(
      codexHome ? path.resolve(codexHome) : path.join(homedir(), ".codex"),
      "sessions",
    )
  );
}
