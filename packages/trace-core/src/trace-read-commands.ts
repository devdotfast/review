import type { Command } from "commander";

import type { RegisterTraceCommandsOptions } from "./trace-command-options";
import { addTraceStorageOption } from "./trace-command-storage-option";

/** Registers Review trace reads; never resolves Review state. */
export function registerTraceReadCommands(
  trace: Command,
  settings: RegisterTraceCommandsOptions,
): void {
  const { runtime, cwd, configureJsonOutput } = settings;
  const sessionFlag = "session";
  const agentFlag = "agent-session";

  const withStorage = <T extends Command>(command: T): T =>
    addTraceStorageOption(command);

  const listOptions = (command: Command): Command =>
    command
      .option(`--${sessionFlag} <uuid>`, "Whiteboard session UUID")
      .option("--commit <sha>", "commit or revision");

  const pullOptions = (command: Command): Command =>
    command.option(
      `--${sessionFlag} <uuid>`,
      "pull agent traces for one Whiteboard session",
    );

  configureJsonOutput(
    withStorage(
      listOptions(
        trace
          .command("list")
          .description(
            "List agent sessions for a Whiteboard session or commit",
          ),
      ),
    ),
  ).action(
    async (options: {
      session?: string;
      agentSession?: string;
      commit?: string;
      storage?: "s3" | "hosted";
      json?: boolean;
    }) => {
      if (options.session && options.commit) {
        throw new Error(`Use either --${sessionFlag} or --commit, not both.`);
      }

      settings.setExitCode(
        await runtime.runTraceList({
          cwd,
          sessionId: options.session,
          commitSha: options.commit,
          storage: options.storage,
          json: options.json,
          stdout: settings.stdout,
        }),
      );
    },
  );

  configureJsonOutput(
    withStorage(
      trace
        .command("show <session-id>")
        .description("Survey a trace or show an exact event")
        .option("--trace <name>", "trace name; omit for the main trace")
        .option(
          "--event <index>",
          "print the complete text of one event",
          (value: string) => Number.parseInt(value, 10),
        )
        .option(
          "--kind <kind>",
          "only list user|assistant|tool|separator rows",
        ),
    ),
  ).action(
    async (
      sessionId: string,
      options: {
        trace?: string;
        event?: number;
        kind?: string;
        storage?: "s3" | "hosted";
        json?: boolean;
      },
    ) => {
      settings.setExitCode(
        await runtime.runTraceShow({
          cwd,
          sessionId,
          trace: options.trace,
          eventIndex: options.event,
          kind: options.kind,
          storage: options.storage,
          json: options.json,
          stdout: settings.stdout,
          stderr: settings.stderr,
        }),
      );
    },
  );

  configureJsonOutput(
    withStorage(
      pullOptions(
        trace
          .command("pull")
          .description("Pull traces into the local FFF search corpus")
          .option("--repo <owner/repo>", "repository for the corpus path"),
      )
        .option("--commit <sha>", "pull sessions for one commit or revision")
        .option(`--${agentFlag} <id>`, "pull one agent conversation")
        .option("--main-only", "exclude subagent traces"),
    ),
  ).action(
    async (options: {
      repo?: string;
      session?: string;
      agentSession?: string;
      commit?: string;
      mainOnly?: boolean;
      storage?: "s3" | "hosted";
      json?: boolean;
    }) => {
      const selectors = [
        options.session,
        options.commit,
        options.agentSession,
      ].filter(Boolean);

      if (selectors.length > 1) {
        throw new Error(
          `Use only one of --${sessionFlag}, --commit, or --${agentFlag}.`,
        );
      }

      settings.setExitCode(
        await runtime.runTracePull({
          cwd,
          repo: options.repo,
          sessionId: options.session,
          commitSha: options.commit,
          session: options.agentSession,
          mainOnly: options.mainOnly,
          storage: options.storage,
          json: options.json,
          stdout: settings.stdout,
          stderr: settings.stderr,
        }),
      );
    },
  );

  configureJsonOutput(
    withStorage(
      trace
        .command("blame <file>")
        .description("Blame lines in a file to agent sessions")
        .option("-L, --lines <range>", "start,end line range")
        .option(
          "--history",
          "use git log -L to include every commit that shaped the lines",
        ),
    ),
  ).action(
    async (
      file: string,
      options: {
        lines?: string;
        history?: boolean;
        storage?: "s3" | "hosted";
        json?: boolean;
      },
    ) => {
      settings.setExitCode(
        await runtime.runTraceBlame({
          cwd,
          file,
          lines: options.lines,
          history: options.history,
          storage: options.storage,
          json: options.json,
          stdout: settings.stdout,
          stderr: settings.stderr,
        }),
      );
    },
  );
}
