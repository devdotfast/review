import {
  TraceConfigurationError,
  TraceStorageDeniedError,
  type TraceStorageKind,
  isS3MockMode,
  isTraceStorageConfigured,
  listReviewTraceSessions,
  loadReviewAgentTrace,
  resolveTraceStorage,
  selectTraceStorage,
} from "@dev.fast/trace-core";

import type { Pins } from "./document.js";

export async function listPinnedTraces(
  cwd: string,
  pins: Pins,
  override?: TraceStorageKind,
) {
  const selection = selectTraceStorage();
  const sources: TraceStorageKind[] = [];

  if (selection.s3?.credentials || isS3MockMode()) sources.push("s3");

  if (selection.hosted) sources.push("hosted");

  const result = {
    ok: true as const,
    configured: isTraceStorageConfigured(),
    storage: override ?? selection.mode,
    sources,
  };

  try {
    if (selection.error)
      return { ...result, storageError: selection.error, sessions: [] };
    const storage = await resolveTraceStorage({ cwd, override });

    if (!storage && (override ?? selection.mode) === "hosted")
      return {
        ...result,
        storageError:
          "The hosted trace store has no login on this machine. Run `review login` and open the review again.",
        sessions: [],
      };

    return {
      ...result,
      sessions: await listReviewTraceSessions({
        rootPath: cwd,
        baseCommit: pins.base,
        headCommit: pins.head,
        storage,
      }),
    };
  } catch (error) {
    if (
      error instanceof TraceStorageDeniedError ||
      error instanceof TraceConfigurationError
    )
      return { ...result, storageError: error.message, sessions: [] };
    throw error;
  }
}

export async function readStoredTrace(
  cwd: string,
  sessionId: string,
  trace?: string,
  override?: TraceStorageKind,
) {
  try {
    const storage = await resolveTraceStorage({ cwd, override });

    const loaded = await loadReviewAgentTrace({
      cwd,
      sessionId,
      trace,
      storage,
    });

    if (!loaded)
      return {
        ok: false as const,
        error: `Trace not found for session ${sessionId}.`,
      };

    return {
      ok: true as const,
      parserVersion: loaded.parserVersion,
      session: loaded.descriptor,
      trace: loaded.traceName,
      cacheStatus: loaded.cacheStatus,
      subagents: loaded.subagents,
      title: loaded.trace.title,
      startedAt: loaded.trace.startedAt,
      endedAt: loaded.trace.endedAt,
      activeMs: loaded.trace.activeMs,
      userTurns: loaded.trace.userTurns,
      toolCalls: loaded.trace.toolCalls,
      events: loaded.trace.events,
    };
  } catch (error) {
    if (
      error instanceof TraceStorageDeniedError ||
      error instanceof TraceConfigurationError
    )
      return { ok: false as const, error: error.message };
    throw error;
  }
}
