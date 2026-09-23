// Re-export barrel kept for one release. New code imports the four modules.
export {
  type TraceRepo,
  inferRepoFromGit,
  parseRepo,
  traceRepoName,
} from "./trace-repo";

export {
  type ReviewTraceCommitRef,
  type ReviewTraceSessionRef,
  type ReviewTracePullSession,
  type ReviewTracePullSessionResult,
  type ReviewTracePullResult,
  traceSearchCorpusDir,
  readTrailerSessions,
  listRepositoryTraceSessionIds,
  listFilesRecursive,
} from "./trace-corpus";

export {
  type LocalTraceDiscovery,
  type LocalTraceHarness,
  findLocalTrace,
  indexCodexTraceFiles,
  traceEnvValue,
  codexSessionsRoot,
} from "./trace-local-sessions";

export {
  type ReviewTraceSyncUpload,
  type ReviewTraceSyncResult,
  syncReviewTrace,
  writeReviewTraceCommitMapping,
} from "./trace-sync";

export {
  TUTORIAL_TRACE_SESSION_ID,
  type ReviewTraceSessionDescriptor,
  type TraceCacheStatus,
  type LoadedReviewAgentTrace,
  type ReviewTraceLookupSource,
  type ReviewTraceCommitLookupResult,
  type ReviewTraceSessionLookupResult,
  type ReviewTraceBlameLookupResult,
  listWhiteboardTraceSessions,
  describeTraceSession,
  loadWhiteboardAgentTrace,
  pullReviewTraceCorpus,
  lookupReviewTraceCommit,
  lookupReviewTraceSession,
  lookupReviewTraceBlame,
  clearTraceEnvCache,
} from "./trace-read";
