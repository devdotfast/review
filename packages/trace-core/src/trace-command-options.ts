import type { Writable } from "node:stream";

import type { Command } from "commander";

import type { CliInputStream } from "./cli-output";
import type {
  runTraceDisable,
  runTraceEnable,
  runTraceGitHook,
  runTraceHook,
  runTraceInstallMachine,
  runTraceRepair,
  runTraceStatus,
  runTraceSync,
} from "./trace-capture-cli";
import type { TraceCommand, TraceScope } from "./trace-command";
import type {
  runTraceAllow,
  runTraceDeny,
  runTraceOnboard,
  runTraceSessions,
  runTraceStoreDelete,
  runTraceStoreInfo,
} from "./trace-hosted-cli";
import type { runTraceBlame, runTraceShow } from "./trace-read-cli";
import type { TraceStorageKind } from "./trace-storage/types";

/** `trace list` as the CLI calls it; the review shape resolves `sessionId`. */
export interface TraceListCommandInput {
  cwd: string;
  sessionId?: string;
  commitSha?: string;
  storage?: TraceStorageKind;
  json?: boolean;
  stdout: Writable;
}

export interface TracePullCommandInput {
  cwd: string;
  repo?: string;
  sessionId?: string;
  commitSha?: string;
  session?: string;
  mainOnly?: boolean;
  storage?: TraceStorageKind;
  json?: boolean;
  stdout: Writable;
  stderr: Writable;
}

/** The trace subset of a CLI runtime; implemented by the Review runtime. */
export interface TraceCommandRuntime {
  runTraceStatus: typeof runTraceStatus;
  runTraceEnable: typeof runTraceEnable;
  runTraceDisable: typeof runTraceDisable;
  runTraceRepair: typeof runTraceRepair;
  runTraceList: (input: TraceListCommandInput) => Promise<number>;
  runTraceShow: typeof runTraceShow;
  runTracePull: (input: TracePullCommandInput) => Promise<number>;
  runTraceBlame: typeof runTraceBlame;
  runTraceHook: typeof runTraceHook;
  runTraceGitHook: typeof runTraceGitHook;
  runTraceSync: typeof runTraceSync;
  runTraceOnboard: typeof runTraceOnboard;
  runTraceStoreDelete: typeof runTraceStoreDelete;
  runTraceStoreInfo: typeof runTraceStoreInfo;
  runTraceInstallMachine: typeof runTraceInstallMachine;
  runTraceSessions: typeof runTraceSessions;
  runTraceAllow: typeof runTraceAllow;
  runTraceDeny: typeof runTraceDeny;
}

export interface RegisterTraceCommandsOptions {
  /** Whiteboard sessions and agent conversations use distinct selectors. */
  runtime: TraceCommandRuntime;
  traceCommand: TraceCommand;
  scope: TraceScope;
  cwd: string;
  stdin?: CliInputStream;
  stdout: Writable;
  stderr: Writable;
  /** The parent CLI's output wiring for a plain command. */
  configureOutput: <T extends Command>(command: T) => T;
  /** The same wiring plus the `--json` option. */
  configureJsonOutput: <T extends Command>(command: T) => T;
  /** Receives every action's exit code. */
  setExitCode: (code: number) => void;
  /**
   * The command `allow` names on its last line, such as `review trace status`.
   * `<prefix> status` when absent.
   */
  verifyCommand?: string;
}
