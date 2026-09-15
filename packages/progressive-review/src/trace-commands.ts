import type { Command } from "commander";

import { registerTraceCaptureCommands } from "./trace-capture-commands";
import type { RegisterTraceCommandsOptions } from "./trace-command-options";
import { registerTraceHookCommands } from "./trace-hook-commands";
import { registerTraceReadCommands } from "./trace-read-commands";

export type {
  TraceCommandRuntime,
  TraceListCommandInput,
  TracePullCommandInput,
  RegisterTraceCommandsOptions,
} from "./trace-command-options";

/** Registers the shared trace surface with explicit runtime and scope; never imports Review app state. */
export function registerTraceCommands(
  parent: Command,
  options: RegisterTraceCommandsOptions,
): void {
  registerTraceCaptureCommands(parent, options);
  registerTraceReadCommands(parent, options);
  registerTraceHookCommands(parent, options);
}
