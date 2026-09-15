import path from "node:path";

import { MAX_TRACE_SESSIONS_PAGE } from "@dev.fast/trace-shared";
import { InvalidArgumentError } from "commander";
import type { Command } from "commander";

import type { RegisterTraceCommandsOptions } from "./trace-command-options";
import { addTraceStorageOption } from "./trace-command-storage-option";
import { DEFAULT_TRACE_SESSIONS_LIMIT } from "./trace-hosted-cli";

/** Registers storage inspection and repository capture actions; never owns app commands. */
export function registerTraceCaptureCommands(
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

  const withStorage = <T extends Command>(command: T): T =>
    addTraceStorageOption(command, settings.storageOverride);

  configureOutput(
    trace
      .command("status")
      .description("Check trace storage and your hosted uploads")
      .option("--session <id>", "Check uploads of one session")
      .option("--cursor <cursor>", "Continue an upload status page")
      .option("--limit <count>", "Uploads per page", Number),
  ).action(
    async (options: { session?: string; cursor?: string; limit?: number }) => {
      settings.setExitCode(
        await runtime.runReviewTraceStatus({
          scope,
          cwd,
          session: options.session,
          cursor: options.cursor,
          limit: options.limit,
          stdout: settings.stdout,
          stderr: settings.stderr,
        }),
      );
    },
  );

  configureJsonOutput(
    withStorage(
      trace
        .command("sessions")
        .description(
          "List every published session of this repository's hosted trace store",
        )
        .option(
          "--limit <n>",
          `sessions per page (1-${MAX_TRACE_SESSIONS_PAGE}, default ${DEFAULT_TRACE_SESSIONS_LIMIT})`,
          (value: string) => {
            // The whole argument must be digits: parseInt would accept "50junk".
            if (!/^\d+$/.test(value)) {
              throw new InvalidArgumentError(
                `--limit must be a whole number from 1 to ${MAX_TRACE_SESSIONS_PAGE}.`,
              );
            }

            return Number(value);
          },
        )
        .option("--cursor <session-id>", "continue after this session id"),
    ),
  ).action(
    async (options: {
      limit?: number;
      cursor?: string;
      storage?: "s3" | "hosted";
      json?: boolean;
    }) => {
      settings.setExitCode(
        await runtime.runReviewTraceSessions({
          scope,
          cwd,
          limit: options.limit,
          cursor: options.cursor,
          storage: options.storage,
          json: options.json,
          stdout: settings.stdout,
          stderr: settings.stderr,
        }),
      );
    },
  );

  configureJsonOutput(
    trace
      .command("onboard [path]")
      .description("Create the hosted trace store for one repository"),
  ).action(
    async (repoPath: string | undefined, options: { json?: boolean }) => {
      settings.setExitCode(
        await runtime.runReviewTraceOnboard({
          scope,
          cwd: repoPath ? path.resolve(cwd, repoPath) : cwd,
          json: options.json,
          stdout: settings.stdout,
          stderr: settings.stderr,
        }),
      );
    },
  );

  configureJsonOutput(
    trace
      .command("allow [path]")
      .description("Allow one repository to publish traces to the hosted store")
      .option(
        "--no-harness-hooks",
        "skip the Claude, Codex, OpenCode, and pi hook installers",
      ),
  ).action(
    async (
      repoPath: string | undefined,
      options: { json?: boolean; harnessHooks?: boolean },
    ) => {
      settings.setExitCode(
        await runtime.runReviewTraceAllow({
          scope,
          cwd: repoPath ? path.resolve(cwd, repoPath) : cwd,
          json: options.json,
          harnessHooks: options.harnessHooks,
          traceCommand,
          stdout: settings.stdout,
          stderr: settings.stderr,
        }),
      );
    },
  );

  configureJsonOutput(
    trace
      .command("deny [path]")
      .description(
        "Stop publishing traces from one repository to the hosted store",
      )
      .option(
        "--delete-store",
        "also delete the hosted store; needs repository admin access",
      ),
  ).action(
    async (
      repoPath: string | undefined,
      options: { json?: boolean; deleteStore?: boolean },
    ) => {
      settings.setExitCode(
        await runtime.runReviewTraceDeny({
          scope,
          cwd: repoPath ? path.resolve(cwd, repoPath) : cwd,
          json: options.json,
          deleteStore: options.deleteStore,
          stdout: settings.stdout,
          stderr: settings.stderr,
        }),
      );
    },
  );

  configureOutput(
    trace
      .command("enable [path]")
      .description("Enable trace hooks for one Git repository"),
  ).action(async (repoPath?: string) => {
    settings.setExitCode(
      await runtime.runReviewTraceEnable({
        scope,
        cwd: repoPath ? path.resolve(cwd, repoPath) : cwd,
        stdout: settings.stdout,
        stderr: settings.stderr,
        traceCommand,
      }),
    );
  });

  configureOutput(
    trace
      .command("disable [path]")
      .description("Disable Review trace hooks for one Git repository"),
  ).action(async (repoPath?: string) => {
    settings.setExitCode(
      await runtime.runReviewTraceDisable({
        scope,
        cwd: repoPath ? path.resolve(cwd, repoPath) : cwd,
        stdout: settings.stdout,
      }),
    );
  });

  configureOutput(
    trace
      .command("repair [path]")
      .description("Repair Review trace hooks for one Git repository"),
  ).action(async (repoPath?: string) => {
    settings.setExitCode(
      await runtime.runReviewTraceRepair({
        scope,
        cwd: repoPath ? path.resolve(cwd, repoPath) : cwd,
        stdout: settings.stdout,
        stderr: settings.stderr,
        traceCommand,
      }),
    );
  });
}
