import { Option } from "commander";
import type { Command } from "commander";

import type { RegisterTraceCommandsOptions } from "./trace-command-options";

/** Registers upload and hidden hook actions; never resolves the machine scope. */
export function registerTraceHookCommands(
  trace: Command,
  settings: RegisterTraceCommandsOptions,
): void {
  const {
    runtime,
    cwd,
    scope,
    traceCommand,
    configureOutput,
    configureJsonOutput,
  } = settings;

  configureJsonOutput(
    trace
      .command("sync <session-id>")
      .description("Upload a local session trace and its metadata")
      .option("--repo <repo>", "GitHub owner/repo")
      .addOption(
        new Option(
          "--expect-storage <selection>",
          "abort when the storage selection changed since capture",
        ).hideHelp(),
      ),
  ).action(
    async (
      sessionId: string,
      options: {
        repo?: string;
        json?: boolean;
        expectStorage?: string;
      },
    ) => {
      settings.setExitCode(
        await runtime.runTraceSync({
          scope,
          cwd,
          sessionId,
          repo: options.repo,
          json: options.json,
          expectStorage: options.expectStorage,
          stdout: settings.stdout,
          stderr: settings.stderr,
        }),
      );
    },
  );

  configureOutput(
    trace
      .command("hook <event>", { hidden: true })
      .description("Handle agent session lifecycle hooks")
      .option(
        settings.sessionNames ? "--agent-session <id>" : "--session <id>",
        "Agent session ID",
      ),
  ).action(
    async (
      event: string,
      options: {
        session?: string;
        agentSession?: string;
      },
    ) => {
      settings.setExitCode(
        await runtime.runTraceHook({
          scope,
          cwd,
          event,
          sessionId: settings.sessionNames
            ? options.agentSession
            : options.session,
          stdin: settings.stdin,
          traceCommand,
        }),
      );
    },
  );

  configureOutput(
    trace
      .command("git-hook <hook> [args...]", { hidden: true })
      .description("Run a package-owned Git trace hook"),
  ).action(async (hook: string, args: string[]) => {
    settings.setExitCode(
      await runtime.runTraceGitHook({
        scope,
        cwd,
        hook,
        args,
        stdin: settings.stdin,
        stderr: settings.stderr,
        traceCommand,
      }),
    );
  });
}
