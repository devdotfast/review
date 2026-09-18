import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { isStringValue } from "@dev.fast/json";

import { devReviewHome } from "./trace-home";

/** Where one CLI run reads its machine state; built once at the entry. */
export interface TraceScope {
  homeDir: string;
  env: NodeJS.ProcessEnv;
  devHome: string;
}

/** Resolves the machine paths and environment shared by one CLI run. */
export function traceScope(
  input: { homeDir?: string; env?: NodeJS.ProcessEnv } = {},
): TraceScope {
  const env = input.env ?? process.env;
  const homeDir = input.homeDir ?? os.homedir();

  return { homeDir, env, devHome: devReviewHome(env, homeDir) };
}

/** The executable a hook re-enters, plus the leading arguments it needs. */
export interface TraceCommand {
  file: string;
  args?: string[];
}

/** The executable name used in trace hooks. */
export function traceCliName(): string {
  return "review";
}

/** The command prefix used in trace instructions. */
export function traceCommandPrefix(): string {
  return "review trace";
}

/** Returns the configured trace home, then the operating-system home. */
export function traceHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.TRACE_HOME_DIR ?? os.homedir();
}

/**
 * Resolves an explicit command, the environment, an installed command, or
 * the configured CLI name on PATH, in that order.
 */
export function resolveTraceCommand(
  input: {
    explicit?: TraceCommand | string;
    env?: NodeJS.ProcessEnv;
    homeDir?: string;
  } = {},
): TraceCommand {
  if (isStringValue(input.explicit)) return { file: input.explicit };

  if (input.explicit) return input.explicit;

  const env = input.env ?? process.env;

  if (env.REVIEW_TRACE_COMMAND) return { file: env.REVIEW_TRACE_COMMAND };

  const installed = path.join(
    input.homeDir ?? traceHomeDir(env),
    ".local",
    "bin",
    "review",
  );

  return { file: existsSync(installed) ? installed : "review" };
}

/** Quotes one value for a POSIX shell command. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/** Renders the executable and each leading argument as quoted shell words. */
export function renderTraceCommand(command: TraceCommand): string {
  return [command.file, ...(command.args ?? [])].map(shellQuote).join(" ");
}
