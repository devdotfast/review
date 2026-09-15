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
  runTraceInstallMachine,
  runTraceList,
  runTraceOnboard,
  runTracePull,
  runTraceRepair,
  runTraceSessions,
  runTraceShow,
  runTraceStatus,
  runTraceStoreDelete,
  runTraceStoreInfo,
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

/** The commands that write hooks; each one needs the installed shim. */
const HOOK_WRITERS = ["allow", "enable", "repair"];

/**
 * The hook entry points. A harness runs these, so a failure inside one must
 * never end the agent session: the run reports the fault and exits 0.
 */
const HOOK_ENTRY_POINTS = ["hook", "git-hook"];

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
    runTraceInstallMachine,
    runTraceOnboard,
    runTraceStoreDelete,
    runTraceStoreInfo,
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
  // The subcommands live at the root, so a hint names `dev-traces allow .`.
  setTraceCliName(CLI_NAME, CLI_NAME);
  const env = input.env ?? process.env;
  const cwd = input.cwd ?? process.cwd();
  const homeDir = input.homeDir ?? os.homedir();
  const platform = input.platform ?? process.platform;
  const execPath = input.execPath ?? process.execPath;
  const scope = traceScope({ homeDir, env });
  const runtime = tracesCliRuntime(input.runtime);
  const packageRoot = findPackageRoot(import.meta.url);
  const version = await readPackageVersion(packageRoot);

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
    installBeforeHooks: true,
    installForce: false,
    hookEntryPoint: false,
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
      stdout: input.stdout,
      stderr: input.stderr,
    });
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

  // `allow`, `enable`, and `repair` write hooks that re-enter this CLI, so
  // each one installs the running package first and hands the installed shim
  // to the library. Without the install the hooks would call the npx cache,
  // which the next npx run empties. The install reports the path it wrote;
  // the program never derives that path a second time.
  const hookTraceCommand = async (json?: boolean): Promise<TraceCommand> => {
    if (!state.installBeforeHooks) return startupCommand;

    const result = await runtime.installSelf({
      packageRoot,
      homeDir,
      env,
      devHome: scope.devHome,
      execPath,
      force: state.installForce,
    });

    humanStream({
      json,
      stdout: input.stdout,
      stderr: input.stderr,
    }).write(result.output);

    return { file: result.shimPath };
  };

  // `status` prints the install block before the library status. Every wrapper
  // below wraps the runtime function instead of re-registering the command, so
  // the options and the help stay the shared builder's. The two read commands
  // map the repository options onto the scope value the library reads.
  const traceRuntime: TraceCommandRuntime = {
    ...runtime,
    runTraceAllow: async (allowInput) => {
      if (platform === "win32") return refuseWindows();

      const traceCommand = await hookTraceCommand(allowInput.json);

      return runtime.runTraceAllow({ ...allowInput, traceCommand });
    },
    runTraceInstallMachine: async (installInput) => {
      if (platform === "win32") return refuseWindows();

      return runtime.runTraceInstallMachine(installInput);
    },
    runTraceEnable: async (enableInput) => {
      if (platform === "win32") return refuseWindows();

      const traceCommand = await hookTraceCommand(state.json);

      return runtime.runTraceEnable({ ...enableInput, traceCommand });
    },
    runTraceRepair: async (repairInput) => {
      if (platform === "win32") return refuseWindows();

      const traceCommand = await hookTraceCommand(state.json);

      return runtime.runTraceRepair({ ...repairInput, traceCommand });
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

      return runtime.runTraceList({
        cwd: listInput.cwd,
        // Commander rejects a `list` without --commit before the action runs.
        scope: { commit: listInput.commitSha ?? "" },
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

  /** One command the shared builder must have registered at the root. */
  const requireRegistered = (name: string): Command => {
    const command = program.commands.find((each) => each.name() === name);

    if (!command) {
      throw new Error(`registerTraceCommands did not register ${name}.`);
    }

    return command;
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
    verifyCommand: `${CLI_NAME} check`,
    // `install` is the machine setup of this CLI: the command file first, then
    // the harness hooks that call it.
    installMachine: ({ json }) => hookTraceCommand(json),
  });

  // A standalone-only option and clause on a shared command: the copy and the
  // command file belong to this CLI, not to the harness hooks.
  const install = requireRegistered("install");
  install.description(
    `${install.description()} and the ${CLI_NAME} command under ~/.local/bin`,
  );
  install.option(
    "--force",
    "Copy the running version again even when it is installed",
  );

  for (const name of HOOK_WRITERS) {
    requireRegistered(name).option(
      "--no-install",
      "Skip installing dev-traces under ~/.local/bin before the hooks are written",
    );
  }

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

    if (HOOK_WRITERS.includes(actionCommand.name())) {
      state.installBeforeHooks = actionCommand.opts().install !== false;
    }

    if (actionCommand.name() === "install") {
      state.installForce = actionCommand.opts().force === true;
    }
    state.hookEntryPoint = HOOK_ENTRY_POINTS.includes(actionCommand.name());
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

    // A hook that throws writes one line and exits 0: a non-zero code, or a
    // stack on stderr, would stop the agent session the harness is running.
    if (state.hookEntryPoint) {
      input.stderr.write(
        `${CLI_NAME}: the hook failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );

      return 0;
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
