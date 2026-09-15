import type { Writable } from "node:stream";

import type { Command } from "commander";

import type { CliInputStream } from "./cli-output";
import type {
  runReviewTraceDisable,
  runReviewTraceEnable,
  runReviewTraceGitHook,
  runReviewTraceHook,
  runReviewTraceRepair,
  runReviewTraceStatus,
  runReviewTraceSync,
} from "./trace-capture-cli";
import type { TraceCommand, TraceScope } from "./trace-command";
import type {
  runReviewTraceAllow,
  runReviewTraceDeny,
  runReviewTraceOnboard,
  runReviewTraceSessions,
} from "./trace-hosted-cli";
import type { runReviewTraceBlame, runReviewTraceShow } from "./trace-read-cli";
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
  runReviewTraceStatus: typeof runReviewTraceStatus;
  runReviewTraceEnable: typeof runReviewTraceEnable;
  runReviewTraceDisable: typeof runReviewTraceDisable;
  runReviewTraceRepair: typeof runReviewTraceRepair;
  runReviewTraceList: (input: TraceListCommandInput) => Promise<number>;
  runReviewTraceShow: typeof runReviewTraceShow;
  runReviewTracePull: (input: TracePullCommandInput) => Promise<number>;
  runReviewTraceBlame: typeof runReviewTraceBlame;
  runReviewTraceHook: typeof runReviewTraceHook;
  runReviewTraceGitHook: typeof runReviewTraceGitHook;
  runReviewTraceSync: typeof runReviewTraceSync;
  runReviewTraceOnboard: typeof runReviewTraceOnboard;
  runReviewTraceSessions: typeof runReviewTraceSessions;
  runReviewTraceAllow: typeof runReviewTraceAllow;
  runReviewTraceDeny: typeof runReviewTraceDeny;
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
}
