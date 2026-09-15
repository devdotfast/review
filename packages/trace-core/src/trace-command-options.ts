import type { Writable } from "node:stream";

import type { Command } from "commander";

import type { CliInputStream, CliJsonOutput } from "./cli-output";
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

/** `trace list` as the CLI calls it; the review shape resolves `reviewUuid`. */
export interface TraceListCommandInput {
  cwd: string;
  reviewUuid?: string;
  commitSha?: string;
  storage?: TraceStorageKind;
  json?: boolean;
  stdout: Writable;
}

export interface TracePullCommandInput {
  cwd: string;
  repo?: string;
  reviewUuid?: string;
  commitSha?: string;
  session?: string;
  mainOnly?: boolean;
  storage?: TraceStorageKind;
  json?: boolean;
  stdout: Writable;
  stderr: Writable;
}

/** The trace subset of a CLI runtime; both CLIs satisfy it structurally. */
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
  runtime: TraceCommandRuntime;
  cliName: string;
  /** "review" adds `--review <uuid>`; "repository" makes `--commit` required on list. */
  reads: "review" | "repository";
  /** Adds `--storage <mode>` to the read commands. */
  storageOverride: boolean;
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
   * Installs the CLI itself, and reports the command the harness hooks call.
   * Only a CLI that ships its own command file supplies this; `install` then
   * names that command file too.
   */
  installMachine?: (output: CliJsonOutput) => Promise<TraceCommand>;
}
