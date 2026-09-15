// Temporary app-free entry for standalone trace preparation.
// The closure guard enforces eager isolation until trace-core owns this surface.

export {
  DEFAULT_STORE_ORIGIN,
  readStoreAuth,
  runStoreLogin,
  runStoreLogout,
  runStoreWhoami,
} from "./store-auth";

export { StoreApiError, StoreClient } from "./store-client";

export {
  DEFAULT_TRACE_SESSIONS_LIMIT,
  runTraceAllow,
  runTraceDeny,
  runTraceOnboard,
  runTraceSessions,
  writeHostedTraceStatus,
} from "./trace-hosted-cli";

export {
  runTraceDisable,
  runTraceEnable,
  runTraceGitHook,
  runTraceHook,
  runTraceRepair,
  runTraceStatus,
  runTraceSync,
} from "./trace-capture-cli";

export {
  type TraceListScope,
  type TracePullScope,
  type TraceReviewScope,
  runTraceBlame,
  runTraceList,
  runTracePull,
  runTraceShow,
} from "./trace-read-cli";

export {
  type RegisterTraceCommandsOptions,
  type TraceCommandRuntime,
  type TraceListCommandInput,
  type TracePullCommandInput,
  registerTraceCommands,
} from "./trace-commands";

export {
  type TraceCommand,
  type TraceScope,
  renderTraceCommand,
  resolveTraceCommand,
  setTraceCliName,
  traceCliName,
  traceHomeDir,
  traceScope,
} from "./trace-command";

export {
  type AgentTraceHookAgent,
  type TraceHookOwner,
  type TraceHookOwners,
  describeTraceHookOwners,
  removeAgentTraceHook,
  traceHookCommandOwner,
} from "./agent-trace-hooks";

export {
  disableTraceRepository,
  enableTraceRepository,
  listTraceRepositoryRoots,
  traceRepositoryStatus,
} from "./trace-repository-hooks";

export { gitCommonDirectory } from "./trace-repository-target";

export { clearTraceEnvCache } from "./trace-storage/s3-config";

export {
  type CliInputStream,
  collectingWritable,
  jsonRequestedInArgv,
} from "./cli-output";

export { devReviewHome } from "./review-storage";

export { selectTraceStorage } from "./trace-storage/resolve";

export {
  hostedCaptureEnabled,
  hostedOrigin,
  readTraceConfigFile,
} from "./trace-storage/config";

export { findTraceRepository, readTraceUserConfig } from "./trace-user-config";

export {
  describeTraceSyncFailure,
  listTraceSyncFailures,
} from "./trace-sync-status";

export { readActiveTraceSessions } from "./trace-agent-sessions";

export { type TraceRepo, inferRepoFromGit, traceRepoName } from "./trace-repo";

export { findProgressiveReviewPackageRoot } from "./package-paths";
