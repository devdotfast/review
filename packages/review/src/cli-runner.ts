import path from "node:path";
import { createInterface } from "node:readline/promises";
import type { Writable } from "node:stream";
import { fileURLToPath } from "node:url";

import {
  StoreApiError,
  readStoreAuth,
  withStoreAuthorization,
} from "@dev.fast/trace-core";
import {
  type CliInputStream,
  DEFAULT_STORE_ORIGIN,
  humanStream,
  jsonRequestedInArgv,
  registerTraceCommands,
  resolveTraceCommand,
  runStoreLogin,
  runStoreLogout,
  runStoreWhoami,
  runTraceAllow,
  runTraceDeny,
  runTraceInstallMachine,
  runTraceOnboard,
  runTraceSessions,
  runTraceStoreDelete,
  runTraceStoreInfo,
  traceHomeDir,
  traceScope,
} from "@dev.fast/trace-core";
import { Argument, Command, CommanderError, Option } from "commander";

import { installReviewCommand, pathShimPath } from "./cli-install";
import { cliRuntimeInfo, describeCliRuntime } from "./cli-runtime-info";
import { readReviewDesktopDiscovery } from "./desktop-discovery";
import { isFile } from "./fs-utils";
import {
  ALL_INSTALL_TARGETS,
  type InstallTarget,
  type RunInstallInput,
  defaultPackageRoot,
  isInstallTarget,
  runInstall,
} from "./install";
import { runReviewMigration } from "./migrate";
import { readReviewPackageVersion } from "./package-paths";
import { reviewAgentCliHelp } from "./review-api/agent-cli";
import { type ReviewAppEvent, runReviewAppPick } from "./review-app";
import {
  type ReviewAppLaunchEvent,
  runReviewAppLaunch,
} from "./review-app-launcher";
import { reviewDesktopDiscoveryPath } from "./review-home-paths";
import { runReviewInfo } from "./review-info";
import { emitReviewEvent, serializeReviewError } from "./review-logger";
import {
  type ReviewCliCommand,
  type ReviewCliCommandPath,
  type ReviewCommandTelemetry,
  ReviewTelemetry,
  type ReviewTelemetryErrorCategory,
  type ReviewTelemetryErrorName,
} from "./review-telemetry";
import {
  readReviewServerDiscovery,
  reviewServerIsHealthy,
  reviewServerStateDir,
  serverNotReady,
} from "./server-discovery";
import { setTraceAttribute, span } from "./startup-trace";
import {
  runTraceBlame,
  runTraceDisable,
  runTraceEnable,
  runTraceGitHook,
  runTraceHook,
  runTraceList,
  runTracePull,
  runTraceRepair,
  runTraceShow,
  runTraceStatus,
  runTraceSync,
} from "./trace-cli";
import { runTraceConfigMigrate, runTraceStorageUse } from "./trace-storage-cli";

interface ReviewCliRuntime {
  runReviewAppLaunch: typeof runReviewAppLaunch;
  runReviewAppPick: typeof runReviewAppPick;
  runReviewInfo: typeof runReviewInfo;
  runInstall: typeof runInstall;
  installReviewCommand: typeof installReviewCommand;
  runReviewMigration: typeof runReviewMigration;
  runTraceStatus: typeof runTraceStatus;
  runTraceEnable: typeof runTraceEnable;
  runTraceDisable: typeof runTraceDisable;
  runTraceRepair: typeof runTraceRepair;
  runTraceList: typeof runTraceList;
  runTraceShow: typeof runTraceShow;
  runTracePull: typeof runTracePull;
  runTraceBlame: typeof runTraceBlame;
  runTraceHook: typeof runTraceHook;
  runTraceGitHook: typeof runTraceGitHook;
  runTraceSync: typeof runTraceSync;
  runTraceStorageUse: typeof runTraceStorageUse;
  runTraceConfigMigrate: typeof runTraceConfigMigrate;
  runTraceInstallMachine: typeof runTraceInstallMachine;
  runTraceOnboard: typeof runTraceOnboard;
  runTraceStoreDelete: typeof runTraceStoreDelete;
  runTraceStoreInfo: typeof runTraceStoreInfo;
  runTraceSessions: typeof runTraceSessions;
  runTraceAllow: typeof runTraceAllow;
  runTraceDeny: typeof runTraceDeny;
  runStoreLogin: typeof runStoreLogin;
  runStoreLogout: typeof runStoreLogout;
  runStoreWhoami: typeof runStoreWhoami;
}

export interface ReviewCliInput {
  argv: string[];
  cliVersion?: string;
  cliPaths?: { requestedPath: string; effectivePath: string };
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdin?: CliInputStream;
  stdout: Writable;
  stderr: Writable;
  telemetry?: ReviewCommandTelemetry;
  runtime?: Partial<ReviewCliRuntime>;
}

interface ReviewInfoOptions {
  all?: boolean;
  review?: string;
}

type OutputSurface = ReviewCliCommand | "plain";

interface CliRunState {
  exitCode: number;
  parseSurface: OutputSurface;
  parserErrorOutput: string;
  json: boolean;
}

export async function runReviewCli(input: ReviewCliInput): Promise<number> {
  const env = input.env ?? process.env;
  const cwd = input.cwd ?? env.INIT_CWD ?? process.cwd();

  // The command every installed hook re-enters. The Review CLI resolves it
  // the same way the hooks did on their own, so `review` behaves as before.
  const traceCommand = resolveTraceCommand({
    env,
    homeDir: traceHomeDir(env),
  });

  const scope = traceScope({ env, homeDir: traceHomeDir(env) });

  const cliVersion =
    input.cliVersion ?? readReviewPackageVersion(import.meta.url);

  const runtime = reviewCliRuntime(input.runtime);
  const telemetry = input.telemetry ?? ReviewTelemetry.fromEnv(env);

  const state: CliRunState = {
    exitCode: 0,
    parseSurface: "review",
    parserErrorOutput: "",
    json: jsonRequestedInArgv(input.argv),
  };

  let telemetryProperties: Record<
    string,
    boolean | number | string | null | undefined
  > = {};

  let activeTelemetry:
    | {
        command: ReviewCliCommandPath;
        commandRunId: string;
        startedAt: number;
        finished: boolean;
      }
    | undefined;

  const configureOutput = <T extends Command>(
    command: T,
    surface: OutputSurface,
  ): T => {
    command.configureOutput({
      writeOut: (message) => input.stdout.write(message),
      writeErr: (message) => {
        state.parseSurface = surface;
        state.parserErrorOutput += message;
      },
    });
    command.showHelpAfterError();

    return command;
  };

  // Every command accepts --json so an agent can pass it without first knowing
  // which commands support it. Commands that already write only JSON to stdout
  // treat it as a no-op; the rest switch stdout to events and push human
  // progress to stderr. A factory, not one shared Option: a shared instance
  // would propagate any later .default()/.conflicts() to every command.
  const configureJsonOutput = <T extends Command>(
    command: T,
    surface: OutputSurface,
  ): T =>
    configureOutput(command, surface).addOption(
      new Option("--json", "print machine-readable JSON events on stdout"),
    );

  const program = configureOutput(new Command(), "review")
    .name("review")
    .enablePositionalOptions()
    .version(cliVersion)
    .description("Create, publish, and open dev.fast Reviews.")
    .addHelpText("after", reviewTopLevelHelp());

  // Tolerate the leading form (`review --json scaffold`) as well as the usual
  // trailing one. Never give this a .default(): optsWithGlobals merges globals
  // over locals, so a default would clobber a subcommand's own true.
  program.addOption(new Option("--json").hideHelp());
  program.option(
    "--state-dir <path>",
    "select headless Review state for server, api, and mcp",
  );
  program.exitOverride();

  const authoringEnv = (
    stateDir = program.opts<{ stateDir?: string }>().stateDir,
  ) =>
    stateDir
      ? { ...env, DEV_REVIEW_SERVER_DIR: path.resolve(cwd, stateDir) }
      : env;

  const serverCommand = configureOutput(
    program
      .command("server")
      .description("Run Review authoring without Desktop"),
    "plain",
  );

  configureJsonOutput(
    serverCommand
      .command("start")
      .description(
        "Start the foreground authoring server; stop with Ctrl-C or SIGTERM",
      )
      .option(
        "--state-dir <path>",
        "directory for saved reviews and server discovery",
      )
      .option(
        "--port <port>",
        "loopback port (0 chooses an available port)",
        "0",
      )
      .option(
        "--authoring-mode <mode>",
        "authoring workflow: interactive or batch",
        "interactive",
      )
      .option(
        "--software-maps",
        "allow the authoring skill to generate optional software maps",
      ),
    "plain",
  ).action(async (_options, command: Command) => {
    const options = command.optsWithGlobals<{
      stateDir?: string;
      port: string;
      softwareMaps?: boolean;
      authoringMode: string;
      json?: boolean;
    }>();

    if (
      options.authoringMode !== "interactive" &&
      options.authoringMode !== "batch"
    )
      throw new Error("--authoring-mode must be interactive or batch.");
    const port = Number(options.port);

    if (!Number.isInteger(port) || port < 0 || port > 65535)
      throw new Error("--port must be an integer between 0 and 65535.");
    const stateDir = reviewServerStateDir(authoringEnv(options.stateDir));
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);

    try {
      const { runHeadlessServer } = await import("./server/headless-host.js");
      await runHeadlessServer({
        stateDir,
        port,
        softwareMapEnabled: options.softwareMaps,
        authoringMode: options.authoringMode,
        signal: controller.signal,
        onReady: ({ url, serverPid }) => {
          input.stdout.write(
            options.json
              ? `${JSON.stringify({ event: "server.ready", url, serverPid, stateDir })}\n`
              : `Review server ready at ${url}\nSaved reviews: ${stateDir}\n`,
          );
        },
      });
    } finally {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    }
  });

  configureJsonOutput(
    serverCommand
      .command("status")
      .description("Check whether the headless server is ready")
      .option(
        "--state-dir <path>",
        "directory selected when starting the server",
      ),
    "plain",
  ).action(async (_options, command: Command) => {
    const options = command.optsWithGlobals<{
      stateDir?: string;
      json?: boolean;
    }>();

    const stateDir = reviewServerStateDir(authoringEnv(options.stateDir));
    const discovery = await readReviewServerDiscovery(stateDir);

    if (!discovery || !(await reviewServerIsHealthy(discovery)))
      throw serverNotReady(stateDir);
    const { url, serverPid } = discovery;
    input.stdout.write(
      options.json
        ? `${JSON.stringify({ event: "server.status", ready: true, url, serverPid, stateDir })}\n`
        : `Review server ready at ${url}\nSaved reviews: ${stateDir}\n`,
    );
  });

  configureJsonOutput(
    program
      .command("version")
      .description("Print Review package version")
      .option("--verbose", "Show executing CLI paths and build identity"),
    "plain",
  ).action((options: { verbose?: boolean }, command: Command) => {
    const { json } = command.optsWithGlobals<{ json?: boolean }>();

    if (options.verbose) {
      const info = cliRuntimeInfo(
        input.cliPaths?.requestedPath ??
          path.resolve(process.argv[1] ?? fileURLToPath(import.meta.url)),
        input.cliPaths?.effectivePath,
      );

      input.stdout.write(
        json ? `${JSON.stringify(info)}\n` : describeCliRuntime(info),
      );
      state.exitCode = 0;

      return;
    }

    input.stdout.write(
      json
        ? `${JSON.stringify({ event: "version", version: cliVersion })}\n`
        : `${cliVersion}\n`,
    );
    state.exitCode = 0;
  });

  const writeAppEvent = (
    event: ReviewAppLaunchEvent | ReviewAppEvent,
    json: boolean | undefined,
  ) => {
    if (json) {
      input.stdout.write(`${JSON.stringify(event)}\n`);
    } else if (event.action === "launch") {
      input.stdout.write(
        event.state === "running"
          ? "Review Desktop is already running.\n"
          : "Review Desktop is ready.\n",
      );
    } else {
      input.stdout.write(`Review Desktop is showing "${event.title}".\n`);
    }
  };

  const pickReview = async (options: { review?: string; json?: boolean }) => {
    // SAFETY: the picker reads keypresses only after checking isTTY, and only
    // a tty.ReadStream reports isTTY; any other stream fails that check first.
    const event = await runtime.runReviewAppPick({
      cwd,
      reviewUuid: options.review,
      stdin: (input.stdin ?? process.stdin) as NodeJS.ReadStream,
      // This stream carries only the interactive picker. Under --json it must
      // not be stdout: the picker's ANSI frames would corrupt the event line.
      stdout: humanStream({ ...input, json: options.json }),
    });

    if (!event) {
      state.exitCode = 1;

      return;
    }

    writeAppEvent(event, options.json);
    state.exitCode = 0;
  };

  const launchApp = async (options: { json?: boolean }) => {
    const event = await runtime.runReviewAppLaunch();
    writeAppEvent(event, options.json);
    state.exitCode = 0;
  };

  const app = configureJsonOutput(
    program.command("app").description("Start or activate Review Desktop"),
    "plain",
  ).action(launchApp);

  configureJsonOutput(
    app.command("launch").description("Start or activate Review Desktop"),
    "plain",
  ).action(launchApp);
  configureJsonOutput(
    app
      .command("pick")
      .description("Select a Review (interactive picker without --review)")
      .option("--review <uuid>", "review UUID"),
    "plain",
  ).action(pickReview);

  configureJsonOutput(
    program.command("info").description("Print Review information"),
    "plain",
  )
    .option("--all", "list active reviews for every worktree in this repo")
    .addOption(
      new Option("--review <uuid>", "select a Review").conflicts("all"),
    )
    .action(async (options: ReviewInfoOptions) => {
      const event = await runtime.runReviewInfo({
        cwd,
        all: options.all,
        reviewUuid: options.review,
      });

      input.stdout.write(`${JSON.stringify(event)}\n`);
      state.exitCode = 0;
    });

  const install = configureJsonOutput(
    program
      .command("install")
      .description("Install the bundled Review skills")
      .addArgument(
        new Argument("[target...]", "coding agent target").choices([
          "claude",
          "claude-code",
          "codex",
          "cursor",
          "pi",
          "all",
        ]),
      )
      .option(
        "--trace-endpoint <url>",
        "S3/R2 endpoint URL (experimental trace capture)",
      )
      .option(
        "--trace-bucket <name>",
        "S3/R2 bucket name (experimental trace capture)",
      )
      .option(
        "--trace-key <id>",
        "S3/R2 access key ID (experimental trace capture)",
      )
      .option(
        "--trace-secret <key>",
        "S3/R2 secret access key (experimental trace capture)",
      )
      .option(
        "--trace-region <region>",
        "SigV4 signing region; default auto for R2, set the bucket region for S3",
      )
      .option(
        "--without-traces",
        "Deprecated: trace capture is off unless --trace-* options are given",
      )
      .option(
        "--no-shim",
        "Install skills without the review command or PATH changes",
      )
      .addHelpText("after", reviewInstallHelp()),
    "plain",
  );

  install.action(
    async (
      targets: string[],
      options: {
        json?: boolean;
        traces?: boolean;
        traceEndpoint?: string;
        traceBucket?: string;
        traceKey?: string;
        traceSecret?: string;
        traceRegion?: string;
        shim?: boolean;
      },
    ) => {
      const selectedTargets = installTargets(targets);
      const installShim = options.shim !== false;

      const cliSource = installShim
        ? await resolveInstallCliSource(env)
        : undefined;

      const installInput: RunInstallInput = {
        targets: selectedTargets,
        env,
        fff: true,
        json: options.json,
        stdout: input.stdout,
        stderr: input.stderr,
      };

      if (installShim) installInput.reviewCommand = pathShimPath();

      // Trace capture is experimental and opt-in: only a request that names
      // R2 credentials configures it. --without-traces stays accepted so
      // existing scripts keep working.
      if (traceCredentialsRequested(options) && options.traces !== false) {
        installInput.trace = {
          credentials: {
            endpoint: options.traceEndpoint,
            bucket: options.traceBucket,
            key: options.traceKey,
            secret: options.traceSecret,
            region: options.traceRegion,
          },
        };
      }

      state.exitCode = await runtime.runInstall(installInput);

      if (state.exitCode !== 0 || !installShim) return;

      const human = humanStream({
        json: options.json,
        stdout: input.stdout,
        stderr: input.stderr,
      });

      if (!cliSource) {
        human.write(
          "Review did not install the review command because no built CLI was found. The skills were installed.\n",
        );

        return;
      }

      const installed = await runtime.installReviewCommand({
        ...cliSource,
        env,
      });

      human.write(installed.output);
    },
  );

  const migrate = configureOutput(
    program.command("migrate").description("Migrate legacy Review data"),
    "plain",
  );

  configureJsonOutput(
    migrate
      .command("apply")
      .description("Apply the legacy Review migration")
      .option("--force", "restart an interrupted migration"),
    "plain",
  ).action(async (options: { force?: boolean; json?: boolean }) => {
    state.exitCode = await runtime.runReviewMigration({
      env,
      force: options.force,
      json: options.json,
      stdout: input.stdout,
      stderr: input.stderr,
    });
  });

  const share = configureJsonOutput(
    program
      .command("share")
      .description(
        "Upload an immutable review snapshot and return its share link",
      ),
    "plain",
  )
    .option("--review <id>", "Review ID")
    .option("--version <number>", "Saved version to share")
    .action(
      async (options: {
        review?: string;
        version?: string;
        json?: boolean;
      }) => {
        const { runShareCli } = await import("./sharing/cli.js");
        state.exitCode = await runShareCli({ ...input, ...options });
      },
    );

  configureJsonOutput(
    share
      .command("revoke <share-id>")
      .description("Revoke future downloads of a share"),
    "plain",
  ).action(async (shareId: string, options: { json?: boolean }) => {
    const { runShareCli } = await import("./sharing/cli.js");
    state.exitCode = await runShareCli({
      ...input,
      ...options,
      revoke: shareId,
    });
  });

  // Hosted trace store login. Logging in authenticates a user; it selects
  // no storage by itself.
  configureJsonOutput(
    program.command("login").description("Log in to Review with GitHub"),
    "plain",
  )
    .option("--origin <url>", "Review service origin", DEFAULT_STORE_ORIGIN)
    .option("--traces", "Also authorize GitHub repositories for hosted traces")
    .option("--no-browser", "Print the URL instead of opening a browser")
    .action(
      async (options: {
        origin?: string;
        browser?: boolean;
        traces?: boolean;
        json?: boolean;
      }) => {
        state.exitCode = await runtime.runStoreLogin({
          origin: options.origin,
          noBrowser: options.browser === false,
          traces: options.traces === true,
          json: options.json,
          stdout: input.stdout,
          stderr: input.stderr,
        });
      },
    );

  program
    .command("logout")
    .description("Forget the hosted trace store login")
    .action(async () => {
      state.exitCode = await runtime.runStoreLogout({ stdout: input.stdout });
    });

  configureJsonOutput(
    program.command("whoami").description("Show the hosted trace store login"),
    "plain",
  ).action(async (options: { json?: boolean }) => {
    state.exitCode = await runtime.runStoreWhoami({
      json: options.json,
      stdout: input.stdout,
      stderr: input.stderr,
    });
  });

  // The trace surface: inspect storage, manage one repository, or read events.
  const trace = configureOutput(
    program.command("trace").description("Manage agent traces"),
    "plain",
  );

  registerTraceCommands(trace, {
    runtime,
    traceCommand,
    scope,
    cwd,
    stdin: input.stdin,
    stdout: input.stdout,
    stderr: input.stderr,
    configureOutput: (command) => configureOutput(command, "plain"),
    configureJsonOutput: (command) => configureJsonOutput(command, "plain"),
    verifyCommand: "review trace status",
    setExitCode: (code) => {
      state.exitCode = code;
    },
  });

  // Storage selection and configuration migration write only the shared
  // trace config; legacy files and remote objects are never touched.
  const traceStorage = configureOutput(
    trace.command("storage").description("Select the trace store"),
    "plain",
  );

  configureJsonOutput(
    traceStorage
      .command("use <mode>")
      .description("Select the s3 (S3/R2 bucket) or hosted trace store")
      .option("--origin <url>", "hosted store origin")
      .option("--endpoint <url>", "S3/R2 endpoint URL (s3)")
      .option("--bucket <name>", "S3/R2 bucket name (s3)")
      .option("--key <id>", "S3/R2 access key ID (s3)")
      .option("--secret <key>", "S3/R2 secret access key (s3)")
      .option("--region <region>", "S3/R2 signing region (s3)"),
    "plain",
  ).action(
    async (
      mode: string,
      options: {
        origin?: string;
        endpoint?: string;
        bucket?: string;
        key?: string;
        secret?: string;
        region?: string;
        json?: boolean;
      },
    ) => {
      state.exitCode = await runtime.runTraceStorageUse({
        cwd,
        mode,
        origin: options.origin,
        endpoint: options.endpoint,
        bucket: options.bucket,
        key: options.key,
        secret: options.secret,
        region: options.region,
        json: options.json,
        stdout: input.stdout,
        stderr: input.stderr,
      });
    },
  );

  const traceConfig = configureOutput(
    trace.command("config").description("Manage trace storage configuration"),
    "plain",
  );

  configureJsonOutput(
    traceConfig
      .command("migrate")
      .description(
        "Copy the legacy S3/R2 setup into $DEV_REVIEW_HOME/trace/config.json",
      )
      .option("--dry-run", "preview without writing")
      .option(
        "--keep-legacy",
        "leave the legacy env and settings files in place instead of renaming them to legacy_*",
      ),
    "plain",
  ).action(
    async (options: {
      dryRun?: boolean;
      keepLegacy?: boolean;
      json?: boolean;
    }) => {
      state.exitCode = await runtime.runTraceConfigMigrate({
        dryRun: options.dryRun,
        keepLegacy: options.keepLegacy,
        json: options.json,
        stdout: input.stdout,
        stderr: input.stderr,
      });
    },
  );

  // Keep the established Review help order while app-only commands stay here.
  const traceHelp = trace.createHelp();

  trace.configureHelp({
    visibleCommands: (command) => {
      const commands = traceHelp.visibleCommands(command);
      commands.splice(commands.indexOf(traceStorage), 1);
      commands.splice(1, 0, traceStorage);
      commands.splice(commands.indexOf(traceConfig), 1);
      commands.splice(6, 0, traceConfig);

      return commands;
    },
  });

  // The JSON authoring surface is owned by review-api/agent-cli.ts. Commander
  // passes the tool name and JSON payload through untouched, so these commands
  // share the top-level help, the leading `--json` form, and the telemetry
  // hooks without a separate parser.
  for (const [name, description] of [
    ["api", "Call a JSON Review authoring tool on the running server"],
    ["mcp", "Serve the JSON Review authoring tools over stdio MCP"],
  ] as const) {
    configureOutput(
      program
        .command(name)
        .description(description)
        .argument("[args...]", "tool name and JSON input")
        .allowUnknownOption()
        .allowExcessArguments()
        .helpOption(false)
        .passThroughOptions()
        .addHelpText("after", `\n${reviewAgentCliHelp}`),
      "plain",
    ).action(async (args: string[]) => {
      const { runReviewAgentCli } = await import("./review-api/agent-cli.js");
      state.exitCode = await runReviewAgentCli({
        ...input,
        env: authoringEnv(),
        argv: [name, ...args],
      });
    });
  }

  program.hook("preAction", async (_command, actionCommand) => {
    // The parsed option is authoritative once parsing succeeds. The argv scan
    // that seeded state.json only has to cover parse failures.
    if (actionCommand.optsWithGlobals().json === true) {
      state.json = true;
    }

    const command = telemetryCommandPath(actionCommand, input.argv);

    if (!command) return;
    const commandRunId = telemetry.createCommandRunId();
    setTraceAttribute("command", command);
    setTraceAttribute("commandRunId", commandRunId);
    activeTelemetry = {
      command,
      commandRunId,
      startedAt: Date.now(),
      finished: false,
    };
    await attemptTelemetry(() => telemetry.captureInstallationCreated());
    await attemptTelemetry(() =>
      telemetry.captureCommandStarted({ command, commandRunId }),
    );
  });
  program.hook("postAction", async () => {
    await finishActiveTelemetry(
      telemetry,
      activeTelemetry,
      state.exitCode,
      undefined,
      telemetryProperties,
    );
  });

  try {
    await withStoreAuthorization(
      async (origin) => {
        if (
          state.json ||
          input.stdin?.isTTY !== true ||
          input.argv[0] !== "trace" ||
          input.argv.some((arg) => /hook/i.test(arg))
        )
          return undefined;

        const prompt = createInterface({
          input: input.stdin,
          output: input.stderr,
        });

        let answer: string;

        try {
          answer = await prompt.question(
            "Authorize GitHub repositories for hosted traces? [y/N] ",
          );
        } finally {
          prompt.close();
        }

        if (!/^y(es)?$/i.test(answer.trim())) return undefined;

        const code = await runtime.runStoreLogin({
          origin,
          traces: true,
          stdout: input.stdout,
          stderr: input.stderr,
          env: input.env,
        });

        return code === 0 ? (await readStoreAuth(input.env))?.token : undefined;
      },
      () => program.parseAsync(input.argv, { from: "user" }),
    );

    return state.exitCode;
  } catch (error) {
    if (error instanceof CommanderError) {
      if (error.exitCode === 0) {
        await captureOneOffCommand(
          telemetry,
          input.argv.includes("--version") || input.argv.includes("-V")
            ? "version"
            : "help",
          0,
        );

        return 0;
      }

      const surface = state.parseSurface;

      // stdout carries the parseable failure whenever the caller asked for
      // JSON; stderr keeps the commander message and the help that
      // showHelpAfterError() produced, because a human may be reading too.
      if (state.json || surface === "review") {
        emitReviewEvent(input.stdout, {
          event: "error",
          error: {
            name: "ReviewCliUsageError",
            message: commanderErrorMessage(error),
          },
        });
      }

      if (surface !== "review") {
        input.stderr.write(
          state.parserErrorOutput || ensureTrailingNewline(error.message),
        );
      }

      await finishActiveTelemetry(
        telemetry,
        activeTelemetry,
        1,
        error,
        telemetryProperties,
      );

      if (!activeTelemetry) {
        await captureOneOffCommand(telemetry, "invalid", 1, error);
      }

      return 1;
    }

    if (state.json) {
      const serialized: ReturnType<typeof serializeReviewError> & {
        code?: string;
        remedy?: string;
      } = serializeReviewError(error);

      if (
        error instanceof StoreApiError &&
        error.code === "repository_authorization_required"
      ) {
        serialized.code = error.code;
        serialized.remedy = "review login --traces";
      }

      emitReviewEvent(input.stdout, { event: "error", error: serialized });
    } else {
      input.stderr.write(ensureTrailingNewline(formatCliError(error)));
    }

    await finishActiveTelemetry(
      telemetry,
      activeTelemetry,
      1,
      error,
      telemetryProperties,
    );

    return 1;
  } finally {
    await attemptTelemetry(() => telemetry.shutdown(1_000));
  }
}

function installTargets(targets: readonly string[]): InstallTarget[] {
  if (targets.length === 0 || targets.includes("all")) {
    return [...ALL_INSTALL_TARGETS];
  }

  return [
    ...new Set(
      targets
        .values()
        .map((target) => (target === "claude-code" ? "claude" : target))
        .filter(isInstallTarget),
    ),
  ];
}

function reviewCliRuntime(
  overrides: Partial<ReviewCliRuntime> | undefined,
): ReviewCliRuntime {
  return {
    runReviewAppLaunch,
    runReviewAppPick,
    runReviewInfo,
    runInstall,
    installReviewCommand,
    runReviewMigration,
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
    runTraceStorageUse,
    runTraceConfigMigrate,
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
    ...overrides,
  };
}

interface InstallCliSource {
  cliPath: string;
  cliRuntimePath?: string;
}

async function resolveInstallCliSource(
  env: NodeJS.ProcessEnv,
): Promise<InstallCliSource | undefined> {
  try {
    const discovery = await readReviewDesktopDiscovery(
      reviewDesktopDiscoveryPath(env),
    );

    if (discovery?.cliPath && (await isFile(discovery.cliPath))) {
      const source: InstallCliSource = { cliPath: discovery.cliPath };

      if (discovery.cliRuntimePath) {
        source.cliRuntimePath = discovery.cliRuntimePath;
      }

      return source;
    }
  } catch {
    // A packaged CLI remains a valid fallback when discovery is stale.
  }

  const packageCliPath = path.join(defaultPackageRoot(), "dist", "cli.js");

  return (await isFile(packageCliPath))
    ? { cliPath: packageCliPath }
    : undefined;
}

function reviewTopLevelHelp(): string {
  return [
    "",
    "Use `review info` to discover Review documents for this checkout.",
    "Reviews are authored through the JSON API: `review api tools` lists the tools, and `review mcp` serves the same catalog to an agent.",
    "Use `review app launch` to start Review Desktop. Use `review app pick --review <uuid>` to open one.",
    "Use `review server start` for headless authoring, and `review server status --json` to check readiness.",
    "Use `--view <review|commits|diff|map|trace>` with `review app pick` to choose the opened tab.",
    "",
    "Every command accepts --json. Stdout then carries only JSON events, one per line,",
    "human progress moves to stderr, and a failure prints a JSON error event too.",
    "",
    "Example agent prompt (for a repository that provides a CI/CD system):",
    "",
    "  Can you use $dev-review to explain this repository's CI/CD system to me?",
    "",
    "  My current understanding:",
    "",
    "  1. CI/CD can be configured entirely in JavaScript. There is no YAML;",
    "     everything is code.",
    "  2. I expect it to look somewhat like Dagger, where user-authored code",
    "     makes RPC-style calls into a build system.",
    "",
    "  I have a lot of questions, so please start at a high level:",
    "",
    "  1. Give me a two-sentence introduction, followed by two or three goals",
    "     and non-goals for the repository.",
    "  2. Explain the CI/CD APIs it exposes and how a user would use them.",
    "  3. Show sequence diagrams for the main user flows, including setting up",
    "     a pipeline and pushing a change.",
    "  4. Show database views for the Cloudflare D1 and Worker access patterns,",
    "     with walkthroughs linked to the relevant code.",
    "",
    "  Start concise and let me dig deeper through the canvas.",
  ].join("\n");
}

function traceCredentialsRequested(options: {
  traceEndpoint?: string;
  traceBucket?: string;
  traceKey?: string;
  traceSecret?: string;
}): boolean {
  return Boolean(
    options.traceEndpoint ||
    options.traceBucket ||
    options.traceKey ||
    options.traceSecret,
  );
}

function reviewInstallHelp(): string {
  return [
    "",
    "When no target is provided, Review installs for every supported agent.",
    "",
    "Review Desktop is the primary install path: on startup it offers to",
    "install the CLI and skills for detected agents, and keeps them in sync",
    "with the app. This command remains for headless environments.",
    "",
    "Targets:",
    "  claude   Claude Code (~/.claude/skills)",
    "  codex    Codex (~/.agents/skills)",
    "  cursor   Cursor (~/.cursor/skills)",
    "  opencode OpenCode (~/.config/opencode/plugins)",
    "  pi       Pi (~/.agents/skills and npm:@ff-labs/pi-fff)",
    "  all      Every supported agent (default)",
    "",
    "Examples:",
    "  review install codex",
    "  review install claude cursor",
    "  review install all",
    "",
    "Trace capture (experimental) is off unless S3/R2 credentials are given:",
    "  review install codex --trace-endpoint <url> --trace-bucket <name> --trace-key <id> --trace-secret <key>",
  ].join("\n");
}

async function finishActiveTelemetry(
  telemetry: ReviewCommandTelemetry,
  active:
    | {
        command: ReviewCliCommandPath;
        commandRunId: string;
        startedAt: number;
        finished: boolean;
      }
    | undefined,
  exitCode: number,
  cause?: unknown,
  properties: Record<string, boolean | number | string | null | undefined> = {},
): Promise<void> {
  if (!active || active.finished) return;
  active.finished = true;
  const classification = errorClassification(active.command, cause);
  await attemptTelemetry(() =>
    exitCode === 0
      ? telemetry.captureCommandSucceeded({
          command: active.command,
          commandRunId: active.commandRunId,
          exitCode,
          durationMs: Date.now() - active.startedAt,
          properties,
        })
      : telemetry.captureCommandFailed({
          command: active.command,
          commandRunId: active.commandRunId,
          exitCode,
          durationMs: Date.now() - active.startedAt,
          properties,
          ...classification,
        }),
  );
}

async function captureOneOffCommand(
  telemetry: ReviewCommandTelemetry,
  command: ReviewCliCommandPath,
  exitCode: number,
  cause?: unknown,
): Promise<void> {
  const commandRunId = telemetry.createCommandRunId();
  await attemptTelemetry(() => telemetry.captureInstallationCreated());
  await attemptTelemetry(() =>
    telemetry.captureCommandStarted({ command, commandRunId }),
  );
  const classification = errorClassification(command, cause);
  await attemptTelemetry(() =>
    exitCode === 0
      ? telemetry.captureCommandSucceeded({
          command,
          commandRunId,
          exitCode,
          durationMs: 0,
        })
      : telemetry.captureCommandFailed({
          command,
          commandRunId,
          exitCode,
          durationMs: 0,
          ...classification,
        }),
  );
}

function telemetryCommandPath(
  command: Command,
  argv: readonly string[],
): ReviewCliCommandPath | undefined {
  const name = command.name();
  const parent = command.parent?.name();

  if (parent === "migrate" && name === "apply") return "migrate.apply";

  if (parent === "trace") {
    if (name === "allow" || name === "deny" || name === "install") {
      return `trace.${name}`;
    }
  }

  if (parent === "store" && command.parent?.parent?.name() === "trace") {
    if (name === "create" || name === "delete" || name === "info") {
      return `trace.store.${name}`;
    }
  }

  if (parent === "storage" && name === "use") return "trace.storage.use";

  if (parent === "config" && name === "migrate") return "trace.config.migrate";

  if (name === "login" || name === "logout" || name === "whoami") return name;

  if (name === "api" || name === "mcp") return name;

  if (parent === "app" && (name === "launch" || name === "pick")) {
    return `app.${name}`;
  }

  if (name === "version" || name === "info" || name === "install") {
    return name;
  }

  if (name === "app") {
    return argv.some(
      (argument) => argument === "--review" || argument.startsWith("--review="),
    )
      ? "app.pick"
      : "app.launch";
  }

  return undefined;
}

interface ErrorClassification {
  errorName: ReviewTelemetryErrorName;
  errorCategory: ReviewTelemetryErrorCategory;
}

function errorClassification(
  command: ReviewCliCommandPath,
  cause: unknown,
): ErrorClassification {
  if (cause instanceof CommanderError || command === "invalid") {
    return { errorName: "usage_error", errorCategory: "user_input" };
  }

  const name = cause instanceof Error ? cause.name.toLowerCase() : "";

  if (name.includes("notfound")) {
    return { errorName: "review_not_found", errorCategory: "local_state" };
  }

  if (command.startsWith("app.")) {
    return {
      errorName: "desktop_connection_error",
      errorCategory: "dependency",
    };
  }

  if (command === "info") {
    return { errorName: "review_state_error", errorCategory: "local_state" };
  }

  if (command.startsWith("map.") || command.startsWith("cache.")) {
    return { errorName: "repository_error", errorCategory: "local_state" };
  }

  if (cause) {
    return { errorName: "unexpected_error", errorCategory: "internal" };
  }

  return { errorName: "process_error", errorCategory: "dependency" };
}

async function attemptTelemetry(fn: () => Promise<void>): Promise<void> {
  try {
    await span("telemetry capture", fn);
  } catch {
    // Telemetry must never affect CLI behavior.
  }
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
