// Public app-free surface shared by the Review and standalone trace CLIs.

export {
  DEFAULT_STORE_ORIGIN,
  readStoreAuth,
  runStoreLogin,
  runStoreLogout,
  runStoreWhoami,
  writeStoreAuth,
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
  runTraceDoctor,
} from "./trace-capture-cli";

export {
  type TraceListScope,
  type TracePullScope,
  type TraceReviewScope,
  runTraceBlame,
  runTraceList,
  runTracePull,
  runTraceShow,
  resolveTraceReadStorage,
  runTraceLookupBlame,
  runTraceLookupCommit,
  runTraceLookupSession,
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
  installClaudeTraceHook,
  installCodexTraceHook,
  installOpenCodeTraceExtension,
  installPiTraceExtension,
} from "./agent-trace-hooks";

export {
  disableTraceRepository,
  enableTraceRepository,
  listTraceRepositoryRoots,
  traceRepositoryStatus,
  disableAllTraceRepositories,
} from "./trace-repository-hooks";

export {
  gitCommonDirectory,
  type TraceRepositoryTarget,
  requireTraceConsent,
  resolveTraceRepositoryTarget,
  traceTargetKey,
} from "./trace-repository-target";

export {
  clearTraceEnvCache,
  type S3Credentials,
  S3_DEFAULT_REGION,
  describeS3Setup,
  isS3MockMode,
  readTraceEnvFile,
  resolveS3Setup,
  traceSettingsPath,
} from "./trace-storage/s3-config";

export {
  type CliInputStream,
  collectingWritable,
  jsonRequestedInArgv,
  type CliJsonEvent,
  type CliJsonOutput,
  emitJsonEvent,
  failWithJsonError,
  humanStream,
} from "./cli-output";

export { DEV_REVIEW_HOME_ENV, devReviewHome } from "./trace-home";

export {
  selectTraceStorage,
  describeSelection,
  isTraceStorageConfigured,
  resolveTraceStorage,
  loadS3TraceStorage,
} from "./trace-storage/resolve";

export {
  hostedCaptureEnabled,
  hostedOrigin,
  readTraceConfigFile,
  DEFAULT_HOSTED_ORIGIN,
  type S3CaptureSettings,
  type S3Profile,
  type TraceConfig,
  TraceConfigurationError,
  currentStore,
  emptyTraceConfig,
  s3ProfileSchema,
  s3Store,
  sameS3Profile,
  traceConfigPath,
  writeTraceConfigFile,
} from "./trace-storage/config";

export {
  findTraceRepository,
  readTraceUserConfig,
  allowTraceRepository,
} from "./trace-user-config";

export {
  describeTraceSyncFailure,
  listTraceSyncFailures,
  recordTraceSyncFailure,
  traceSyncStatusDir,
} from "./trace-sync-status";

export { readActiveTraceSessions } from "./trace-agent-sessions";

export { type TraceRepo, inferRepoFromGit, traceRepoName } from "./trace-repo";

export { findPackageRoot } from "./package-root";

export {
  type ReviewTracePullSessionResult,
  codexSessionsRoot,
  findLocalTrace,
  indexCodexTraceFiles,
  listFilesRecursive,
  listReviewTraceSessions,
  loadReviewAgentTrace,
  pullReviewTraceCorpus,
} from "./review-agent-traces";

export {
  type TraceCredentialsInput,
  configureTraceMachine,
  disableTraceMachine,
  readLegacyCaptureSettings,
  traceMachineEnabled,
  traceMachineStatus,
} from "./trace-machine-setup";

export { processIsAlive, withFileLock } from "./with-file-lock";

export {
  writeFileAtomic,
  writeFileAtomicAsync,
  writePrivateJsonAtomic,
} from "./atomic-write";

export { errorMessage } from "./error-message";

export { extractTraceEventText } from "./agent-trace-parser";

export {
  type TraceStorage,
  TraceStorageDeniedError,
  type TraceStorageKind,
} from "./trace-storage/types";

export { normalizeStoreOrigin } from "./store-origin";

export { HOSTED_CAPTURE_SCOPE_DESCRIPTION } from "./trace-capture-scope";

export {
  recordTraceSessionProvenance,
  requireTraceSessionProvenance,
} from "./trace-session-provenance";
