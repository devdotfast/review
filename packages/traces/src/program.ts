import { existsSync } from "node:fs";
import os from "node:os";
import type { Writable } from "node:stream";

import {
  type CliInputStream,
  DEFAULT_STORE_ORIGIN,
  type TraceCommand,
  type TraceCommandRuntime,
  type TraceListCommandInput,
  type TracePullCommandInput,
  type TracePullScope,
  emitJsonEvent,
  failWithJsonError,
  findPackageRoot,
  humanStream,
  jsonRequestedInArgv,
  registerTraceCommands,
  runStoreLogin,
  runStoreLogout,
  runStoreWhoami,
  runTraceAllow,
  runTraceBlame,
  runTraceDeny,
  runTraceDisable,
  runTraceEnable,
  runTraceGitHook,
  runTraceHook,
  runTraceList,
  runTraceOnboard,
  runTracePull,
  runTraceRepair,
  runTraceSessions,
  runTraceShow,
  runTraceStatus,
  runTraceSync,
  setTraceCliName,
  traceScope,
} from "@dev.fast/trace-core";
import { Command, CommanderError, Option } from "commander";

import { runTracesCheck } from "./check.js";
import { readPackageVersion } from "./package-root.js";
import {
  type SelfInstallStatus,
  currentCliPath,
  installSelf,
  selfInstallStatus,
  shimPath,
  uninstallSelf,
} from "./self-install.js";

const CLI_NAME = "dev-traces";

const UNSUPPORTED_PLATFORM = `${CLI_NAME} supports macOS and Linux only.\n`;

const REVIEW_SCOPE_UNSUPPORTED =
  "`--review` needs the Review app. Use `--commit <sha>` or `--session <id>`.";

/**
 * The trace library plus the parts only the standalone CLI owns.
 *
 * `runTraceList` and `runTracePull` are the library's scope-shaped reads, not
 * the option-shaped ones of `TraceCommandRuntime`: the program maps the
 * repository options onto a scope value before it calls them.
 */
export interface TracesCliRuntime extends Omit<
  TraceCommandRuntime,
  "runTraceList" | "runTracePull"
> {
  runTraceList: typeof runTraceList;
  runTracePull: typeof runTracePull;
  runStoreLogin: typeof runStoreLogin;
  runStoreLogout: typeof runStoreLogout;
  runStoreWhoami: typeof runStoreWhoami;
  runTracesCheck: typeof runTracesCheck;
  installSelf: typeof installSelf;
  uninstallSelf: typeof uninstallSelf;
  selfInstallStatus: typeof selfInstallStatus;
}

export interface TracesCliInput {
  argv: string[];
  ownCliPath: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  platform?: NodeJS.Platform;
  execPath?: string;
  stdin?: CliInputStream;
  stdout: Writable;
  stderr: Writable;
  runtime?: Partial<TracesCliRuntime>;
}

/** The functions one run calls, with any test override applied. */
export function tracesCliRuntime(
  overrides: Partial<TracesCliRuntime> = {},
): TracesCliRuntime {
  return {
    runTraceStatus,
    runTraceEnable,
    runTraceDisable,
    runTraceRepair,
    runTraceList,
    runTraceShow,
    runTracePull,
    runTraceBlame,
    runTraceHook,
    runTraceGitHook,
    runTraceSync,
    runTraceOnboard,
    runTraceSessions,
    runTraceAllow,
    runTraceDeny,
    runStoreLogin,
    runStoreLogout,
    runStoreWhoami,
    runTracesCheck,
    installSelf,
    uninstallSelf,
    selfInstallStatus,
    ...overrides,
  };
}

/**
 * The command a hook re-enters: the installed shim when an install is
 * complete, and the running entry file otherwise.
 */
export function resolveStandaloneCommand(input: {
  ownCliPath: string;
  homeDir: string;
  devHome: string;
  execPath?: string;
}): TraceCommand {
  const shim = shimPath(input.homeDir);

  if (existsSync(shim) && existsSync(currentCliPath(input.devHome))) {
    return { file: shim };
  }

  return { file: input.execPath ?? process.execPath, args: [input.ownCliPath] };
}

function commanderErrorMessage(error: CommanderError): string {
  return error.message.replace(/^error:\s*/i, "");
}

function formatCliError(cause: unknown): string {
  if (cause instanceof Error) {
    return cause.stack || `${cause.name}: ${cause.message}`;
  }

  return String(cause);
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}

export async function runTracesCli(input: TracesCliInput): Promise<number> {
  setTraceCliName(CLI_NAME);
  const env = input.env ?? process.env;
  const cwd = input.cwd ?? process.cwd();
  const homeDir = input.homeDir ?? os.homedir();
  const platform = input.platform ?? process.platform;
  const execPath = input.execPath ?? process.execPath;
  const scope = traceScope({ homeDir, env });
  const runtime = tracesCliRuntime(input.runtime);
  const packageRoot = findPackageRoot(import.meta.url);
  const version = await readPackageVersion(packageRoot);
  const shim = shimPath(homeDir);

  const startupCommand = resolveStandaloneCommand({
    ownCliPath: input.ownCliPath,
    homeDir,
    devHome: scope.devHome,
    execPath,
  });

  const state = {
    exitCode: 0,
    json: jsonRequestedInArgv(input.argv),
    parserErrorOutput: "",
    installBeforeAllow: true,
  };

  const configureOutput = <T extends Command>(command: T): T => {
    command.configureOutput({
      writeOut: (message) => input.stdout.write(message),
      writeErr: (message) => {
        state.parserErrorOutput += message;
      },
    });
    command.showHelpAfterError();

    return command;
  };

  // A factory, not one shared Option: a shared instance would propagate any
  // later .default()/.conflicts() to every command.
  const configureJsonOutput = <T extends Command>(command: T): T =>
    configureOutput(command).addOption(
      new Option("--json", "print machine-readable JSON events on stdout"),
    );

  const refuseWindows = (): number => {
    input.stderr.write(UNSUPPORTED_PLATFORM);

    return 1;
  };

  const program = configureOutput(new Command())
    .name(CLI_NAME)
    .enablePositionalOptions()
    .version(version)
    .description(
      "Capture and publish agent session traces to the hosted dev.fast trace store.",
    );

  // Tolerate the leading form (`dev-traces --json allow .`) as well as the
  // usual trailing one. Never give this a .default(): optsWithGlobals merges
  // globals over locals, so a default would clobber a subcommand's own true.
  program.addOption(new Option("--json").hideHelp());
  program.exitOverride();

  configureJsonOutput(
    program
      .command("login")
      .description("Log in to the hosted trace store with GitHub"),
  )
    .option("--origin <url>", "Store origin", DEFAULT_STORE_ORIGIN)
    .option("--no-browser", "Print the URL instead of opening a browser")
    .action(
      async (options: {
        origin?: string;
        browser?: boolean;
        json?: boolean;
      }) => {
        state.exitCode = await runtime.runStoreLogin({
          env,
          origin: options.origin,
          noBrowser: options.browser === false,
          json: options.json,
          stdout: input.stdout,
          stderr: input.stderr,
        });
      },
    );

  configureOutput(
    program
      .command("logout")
      .description("Forget the hosted trace store login"),
  ).action(async () => {
    state.exitCode = await runtime.runStoreLogout({
      env,
      stdout: input.stdout,
    });
  });

  configureJsonOutput(
    program.command("whoami").description("Show the hosted trace store login"),
  ).action(async (options: { json?: boolean }) => {
    state.exitCode = await runtime.runStoreWhoami({
      env,
      json: options.json,
      stdout: input.stdout,
      stderr: input.stderr,
    });
  });

  configureJsonOutput(
    program
      .command("check")
      .description(
        "Check that this machine captures and publishes traces for this repository",
      ),
  ).action(async (options: { json?: boolean }) => {
    state.exitCode = await runtime.runTracesCheck({
      scope,
      cwd,
      ownCliPath: input.ownCliPath,
      runningVersion: version,
      json: options.json,
      stdin: input.stdin,
      stdout: input.stdout,
      stderr: input.stderr,
    });
  });

  configureOutput(
    program
      .command("install")
      .description(
        "Install the dev-traces command under ~/.local/bin without touching hooks",
      )
      .option(
        "--force",
        "Copy the running version again even when it is installed",
      ),
  ).action(async (options: { force?: boolean }) => {
    if (platform === "win32") {
      state.exitCode = refuseWindows();

      return;
    }

    const result = await runtime.installSelf({
      packageRoot,
      homeDir,
      env,
      devHome: scope.devHome,
      execPath,
      force: options.force === true,
    });

    input.stdout.write(result.output);
    state.exitCode = 0;
  });

  configureOutput(
    program
      .command("uninstall")
      .description(
        "Remove the dev-traces command, its hooks, and the installed versions; keep the login and the consent",
      ),
  ).action(async () => {
    const result = await runtime.uninstallSelf({
      homeDir,
      env,
      devHome: scope.devHome,
    });

    input.stdout.write(result.output);
    state.exitCode = 0;
  });

  const printInstallStatus = (status: SelfInstallStatus): void => {
    for (const line of status.lines) input.stdout.write(line);
  };

  // `allow` installs the running package first, so the hooks it writes call
  // ~/.local/bin/dev-traces and never the npx cache. `status` prints the
  // install block first. Both wrap the runtime function instead of
  // re-registering the command, so the options and the help stay the shared
  // builder's. The two read commands map the repository options onto the
  // scope value the library reads.
  const traceRuntime: TraceCommandRuntime = {
    ...runtime,
    runTraceAllow: async (allowInput) => {
      if (platform === "win32") return refuseWindows();

      let traceCommand = startupCommand;

      if (state.installBeforeAllow) {
        const result = await runtime.installSelf({
          packageRoot,
          homeDir,
          env,
          devHome: scope.devHome,
          execPath,
          force: false,
        });

        humanStream({
          json: allowInput.json,
          stdout: input.stdout,
          stderr: input.stderr,
        }).write(result.output);
        traceCommand = { file: shim };
      }

      return runtime.runTraceAllow({ ...allowInput, traceCommand });
    },
    runTraceStatus: async (statusInput) => {
      printInstallStatus(
        await runtime.selfInstallStatus({
          homeDir,
          env,
          devHome: scope.devHome,
          ownCliPath: input.ownCliPath,
          runningVersion: version,
        }),
      );

      return runtime.runTraceStatus(statusInput);
    },
    runTraceList: async (listInput: TraceListCommandInput) => {
      const output = {
        json: listInput.json,
        stdout: listInput.stdout,
        stderr: input.stderr,
      };

      if (listInput.reviewUuid) {
        return failWithJsonError(output, "list", REVIEW_SCOPE_UNSUPPORTED);
      }

      if (!listInput.commitSha) {
        return failWithJsonError(
          output,
          "list",
          "`--commit <sha>` names the commit to list.",
        );
      }

      return runtime.runTraceList({
        cwd: listInput.cwd,
        scope: { commit: listInput.commitSha },
        json: listInput.json,
        stdout: listInput.stdout,
      });
    },
    runTracePull: async (pullInput: TracePullCommandInput) => {
      if (pullInput.reviewUuid) {
        return failWithJsonError(
          {
            json: pullInput.json,
            stdout: pullInput.stdout,
            stderr: pullInput.stderr,
          },
          "pull",
          REVIEW_SCOPE_UNSUPPORTED,
        );
      }

      let pullScope: TracePullScope = { repository: true };

      if (pullInput.session) pullScope = { session: pullInput.session };
      else if (pullInput.commitSha) pullScope = { commit: pullInput.commitSha };

      return runtime.runTracePull({
        cwd: pullInput.cwd,
        scope: pullScope,
        repo: pullInput.repo,
        mainOnly: pullInput.mainOnly,
        json: pullInput.json,
        stdout: pullInput.stdout,
        stderr: pullInput.stderr,
      });
    },
  };

  registerTraceCommands(program, {
    runtime: traceRuntime,
    cliName: CLI_NAME,
    reads: "repository",
    storageOverride: false,
    traceCommand: startupCommand,
    scope,
    cwd,
    stdin: input.stdin,
    stdout: input.stdout,
    stderr: input.stderr,
    configureOutput,
    configureJsonOutput,
    setExitCode: (code) => {
      state.exitCode = code;
    },
  });

  const allow = program.commands.find((command) => command.name() === "allow");

  if (!allow) throw new Error("registerTraceCommands did not register allow.");
  allow.option(
    "--no-install",
    "Skip installing dev-traces under ~/.local/bin before the hooks are written",
  );

  // The harness hook installers write `<command> trace hook <Event>` and the
  // Git hooks write `<command> trace git-hook <hook>`, so the standalone keeps
  // a hidden `trace` group for those two entry points. The shared builder puts
  // them on the root as well, where they stay hidden.
  const trace = configureOutput(
    program.command("trace", { hidden: true }).description("Hook entry points"),
  );

  configureOutput(
    trace
      .command("hook <event>", { hidden: true })
      .description(`Handle ${CLI_NAME} agent session lifecycle hooks`)
      .option("--session <id>", "Agent session ID"),
  ).action(async (event: string, options: { session?: string }) => {
    state.exitCode = await runtime.runTraceHook({
      scope,
      cwd,
      event,
      sessionId: options.session,
      stdin: input.stdin,
      traceCommand: startupCommand,
    });
  });

  configureOutput(
    trace
      .command("git-hook <hook> [args...]", { hidden: true })
      .description("Run a package-owned Git trace hook"),
  ).action(async (hook: string, args: string[]) => {
    state.exitCode = await runtime.runTraceGitHook({
      scope,
      cwd,
      hook,
      args,
      stdin: input.stdin,
      stderr: input.stderr,
      traceCommand: startupCommand,
    });
  });

  program.hook("preAction", (_program, actionCommand) => {
    // The parsed option is authoritative once parsing succeeds. The argv scan
    // that seeded state.json only has to cover parse failures.
    if (actionCommand.optsWithGlobals().json === true) state.json = true;

    if (actionCommand.name() === "allow") {
      state.installBeforeAllow = actionCommand.opts().install !== false;
    }
  });

  try {
    await program.parseAsync(input.argv, { from: "user" });

    return state.exitCode;
  } catch (error) {
    if (error instanceof CommanderError) {
      if (error.exitCode === 0) return 0;

      // stdout carries the parseable failure whenever the caller asked for
      // JSON; stderr keeps the commander message and the help that
      // showHelpAfterError() produced, because a human may be reading too.
      emitJsonEvent(
        { json: state.json, stdout: input.stdout, stderr: input.stderr },
        {
          event: "error",
          stage: "usage",
          message: commanderErrorMessage(error),
        },
      );
      input.stderr.write(
        state.parserErrorOutput || ensureTrailingNewline(error.message),
      );

      return 1;
    }

    if (state.json) {
      emitJsonEvent(
        { json: true, stdout: input.stdout, stderr: input.stderr },
        {
          event: "error",
          stage: "command",
          message: error instanceof Error ? error.message : String(error),
        },
      );
    } else {
      input.stderr.write(ensureTrailingNewline(formatCliError(error)));
    }

    return 1;
  }
}
