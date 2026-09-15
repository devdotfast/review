import path from "node:path";
import type { Writable } from "node:stream";
import { fileURLToPath } from "node:url";

import { devfastPrepareCommands } from "@dev.fast/local-vcs";
import type { ReviewView } from "@dev.fast/review-protocol";
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
  runTraceOnboard,
  runTraceSessions,
  traceHomeDir,
  traceScope,
} from "@dev.fast/trace-core";
import { Argument, Command, CommanderError, Option } from "commander";

import { installReviewCommand, pathShimPath } from "./cli-install";
import { cliRuntimeInfo, describeCliRuntime } from "./cli-runtime-info";
import {
  type CodexWaitProcessInput,
  requireCodexThreadId,
  startCodexWaitProcess,
} from "./codex-thread-wakeup";
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
import { parseSoftwareMapCliArgs, runSoftwareMapCli } from "./map-cli";
import { runReviewMigration } from "./migrate";
import { readReviewPackageVersion } from "./package-paths";
import { type ReviewAppEvent, runReviewAppPick } from "./review-app";
import {
  type ReviewAppLaunchEvent,
  runReviewAppLaunch,
} from "./review-app-launcher";
import { runReviewCodexWait } from "./review-codex-wait";
import { reviewDesktopDiscoveryPath } from "./review-home-paths";
import { runReviewInfo } from "./review-info";
import { runReviewInternalTest } from "./review-internal-test";
import { emitReviewEvent, serializeReviewError } from "./review-logger";
import { prepareReviewPinnedCheckout } from "./review-prepare";
import { runReviewPublish } from "./review-publish";
import { runReviewRebind } from "./review-rebind";
import { runReviewRepair } from "./review-repair";
import { runReviewScaffold } from "./review-scaffold";
import {
  type ReviewCliCommand,
  type ReviewCliCommandPath,
  type ReviewCommandTelemetry,
  ReviewTelemetry,
  type ReviewTelemetryErrorCategory,
  type ReviewTelemetryErrorName,
} from "./review-telemetry";
import { runReviewWait, validateReviewWait } from "./review-wait";
import { setTraceAttribute, span } from "./startup-trace";
import {
  runReviewThreadsGet,
  runReviewThreadsList,
  runReviewThreadsReply,
  runReviewThreadsResolve,
} from "./threads-cli";
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
  runReviewScaffold: typeof runReviewScaffold;
  runReviewInternalTest: typeof runReviewInternalTest;
  runReviewPublish: typeof runReviewPublish;
  runReviewRepair: typeof runReviewRepair;
  runReviewRebind: typeof runReviewRebind;
  runReviewThreadsGet: typeof runReviewThreadsGet;
  runReviewThreadsList: typeof runReviewThreadsList;
  runReviewThreadsResolve: typeof runReviewThreadsResolve;
  runReviewThreadsReply: typeof runReviewThreadsReply;
  runReviewWait: typeof runReviewWait;
  runReviewCodexWait: typeof runReviewCodexWait;
  startCodexWaitProcess(input: CodexWaitProcessInput): Promise<{
    pid: number;
    reused: boolean;
    reviewUuid: string;
    threadId: string;
  }>;
  validateReviewWait: typeof validateReviewWait;
  runInstall: typeof runInstall;
  installReviewCommand: typeof installReviewCommand;
  runReviewMigration: typeof runReviewMigration;
  runSoftwareMapCli: typeof runSoftwareMapCli;
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
  runTraceOnboard: typeof runTraceOnboard;
  runTraceSessions: typeof runTraceSessions;
  runTraceAllow: typeof runTraceAllow;
  runTraceDeny: typeof runTraceDeny;
  runStoreLogin: typeof runStoreLogin;
  runStoreLogout: typeof runStoreLogout;
  runStoreWhoami: typeof runStoreWhoami;
  prepareReviewPinnedCheckout: typeof prepareReviewPinnedCheckout;
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

interface ReviewScaffoldOptions {
  base?: string;
  head?: string;
  pr?: string;
  update?: boolean;
  review?: string;
  new?: boolean;
}

interface ReviewWaitOptions {
  codex?: boolean;
  requiresAgent?: boolean;
  review?: string;
  timeout: number;
}

interface ReviewCodexWaitOptions {
  ownerToken: string;
  threadId: string;
  timeout: number;
}

type OutputSurface = ReviewCliCommand | "plain";

interface CliRunState {
  exitCode: number;
  parseSurface: OutputSurface;
  parserErrorOutput: string;
  json: boolean;
}

export async function runReviewCli(input: ReviewCliInput): Promise<number> {
  if (input.argv[0] === "api" || input.argv[0] === "mcp") {
    const { runReviewAgentCli } = await import("./review-api/agent-cli.js");

    return runReviewAgentCli(input);
  }

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
        reviewUuid?: string;
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

  const viewOption = () =>
    new Option("--view <view>", "view to show after opening").choices([
      "review",
      "commits",
      "diff",
      "map",
      "trace",
    ]);

  const executeMap = async (mapArgs: string[]) => {
    const parsed = parseSoftwareMapCliArgs(mapArgs);
    telemetryProperties = mapCommandProperties(mapArgs, parsed);
    state.exitCode = await runtime.runSoftwareMapCli({
      args: mapArgs,
      cwd,
      stdout: input.stdout,
      stderr: input.stderr,
      env,
    });
  };

  const program = configureOutput(new Command(), "review")
    .name("review")
    .enablePositionalOptions()
    .version(cliVersion)
    .description("Create, publish, and open dev.fast Reviews.")
    .addHelpText("after", reviewTopLevelHelp())
    .addHelpText(
      "after",
      "\nJSON reviews: review api --help\nMCP adapter: review mcp\n",
    );

  // Tolerate the leading form (`review --json scaffold`) as well as the usual
  // trailing one. Never give this a .default(): optsWithGlobals merges globals
  // over locals, so a default would clobber a subcommand's own true.
  program.addOption(new Option("--json").hideHelp());
  program.exitOverride();

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

  configureJsonOutput(
    program
      .command("internal-test [review-dir]", { hidden: true })
      .description("Validate a Review directory"),
    "plain",
  ).action(async (reviewDir: string | undefined) => {
    await runtime.runReviewInternalTest(reviewDir ?? cwd);
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

  const pickReview = async (options: {
    review?: string;
    view?: ReviewView;
    json?: boolean;
  }) => {
    // SAFETY: the picker reads keypresses only after checking isTTY, and only
    // a tty.ReadStream reports isTTY; any other stream fails that check first.
    const event = await runtime.runReviewAppPick({
      cwd,
      reviewUuid: options.review,
      view: options.view,
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

  const bindActiveReview = async (reviewUuid: string): Promise<void> => {
    const active = activeTelemetry;

    if (!active || active.finished || active.reviewUuid) return;
    active.reviewUuid = reviewUuid;
    setTraceAttribute("reviewUuid", reviewUuid);
    await attemptTelemetry(() =>
      telemetry.captureCommandBound({
        command: active.command,
        commandRunId: active.commandRunId,
        reviewUuid,
      }),
    );
  };

  const app = configureJsonOutput(
    program
      .command("app")
      .description("Start or activate Review Desktop")
      .option("--review <uuid>", "compatibility alias for app pick --review")
      .addOption(viewOption()),
    "plain",
  ).action(
    async (options: { review?: string; view?: ReviewView; json?: boolean }) => {
      if (options.review) return pickReview(options);

      return launchApp(options);
    },
  );

  configureJsonOutput(
    app.command("launch").description("Start or activate Review Desktop"),
    "plain",
  ).action(launchApp);
  configureJsonOutput(
    app
      .command("pick")
      .description(
        "Select a published Review (interactive picker without --review)",
      )
      .option("--review <uuid>", "review UUID")
      .addOption(viewOption()),
    "plain",
  ).action(pickReview);

  configureJsonOutput(
    program
      .command("rebind")
      .description("Move a Review to a different unit of change")
      .argument("<change>", "bookmark, branch, or change id")
      .option("--review <uuid>", "review UUID"),
    "plain",
  ).action(async (change: string, options: { review?: string }) => {
    state.exitCode = await runtime.runReviewRebind({
      cwd,
      change,
      reviewUuid: options.review,
      toolingRoot: env.DEV_FAST_REVIEW_TOOLING_ROOT || undefined,
      progress: (message) => input.stderr.write(`${message}\n`),
      env,
      stdout: input.stdout,
    });
  });

  configureJsonOutput(
    program
      .command("repair")
      .description(
        "Repair current Review artifacts without changing review status",
      )
      .requiredOption("--review <uuid>", "review UUID"),
    "plain",
  ).action(async (options: { review: string; json?: boolean }) => {
    state.exitCode = await runtime.runReviewRepair({
      cwd,
      reviewUuid: options.review,
      json: options.json,
      stdout: input.stdout,
      stderr: input.stderr,
      env,
    });
  });

  configureJsonOutput(
    program
      .command("publish")
      .alias("present")
      .description(
        "Present the Review document in the local Review Desktop app",
      )
      .option("--review <uuid>", "review UUID")
      .addOption(viewOption()),
    "plain",
  ).action(
    async (options: { review?: string; view?: ReviewView; json?: boolean }) => {
      state.exitCode = await runtime.runReviewPublish({
        cwd,
        reviewUuid: options.review,
        view: options.view,
        json: options.json,
        toolingRoot: env.DEV_FAST_REVIEW_TOOLING_ROOT || undefined,
        stdout: input.stdout,
        stderr: input.stderr,
        env,
        onReviewBound: bindActiveReview,
      });
    },
  );

  configureJsonOutput(
    program
      .command("wait")
      .description("Wait for reviewer action")
      .option("--review <uuid>", "review UUID")
      .option("--requires-agent", "wait until the review requires agent action")
      .option(
        "--timeout <seconds>",
        "timeout in seconds",
        parseTimeoutSeconds,
        3600,
      )
      .option(
        "--codex",
        "return immediately and resume the current Codex task when reviewer action arrives",
      ),
    "plain",
  ).action(async (options: ReviewWaitOptions) => {
    if (options.codex) {
      const threadId = requireCodexThreadId(env);

      const review = await runtime.validateReviewWait({
        cwd,
        reviewUuid: options.review,
      });

      const registration = await runtime.startCodexWaitProcess({
        cliEntryPath: process.argv[1]!,
        cwd,
        env,
        reviewUuid: review.review.uuid,
        threadId,
        timeout: String(options.timeout),
      });

      input.stdout.write(
        `${JSON.stringify({
          event: "codex-wait",
          reviewUuid: registration.reviewUuid,
          threadId: registration.threadId,
          pid: registration.pid,
          reused: registration.reused,
          waiting: true,
        })}\n`,
      );
      state.exitCode = 0;

      return;
    }

    state.exitCode = await runtime.runReviewWait({
      cwd,
      reviewUuid: options.review,
      requiresAgent: options.requiresAgent,
      timeoutSeconds: options.timeout,
      stdout: input.stdout,
    });
  });

  configureJsonOutput(
    program
      .command("wait-codex <review-uuid>", { hidden: true })
      .description("Internal detached Codex Review waiter")
      .requiredOption("--thread-id <thread-id>")
      .requiredOption("--owner-token <owner-token>")
      .option(
        "--timeout <seconds>",
        "timeout in seconds",
        parseTimeoutSeconds,
        3600,
      ),
    "plain",
  ).action(async (reviewUuid: string, options: ReviewCodexWaitOptions) => {
    state.exitCode = await runtime.runReviewCodexWait({
      cwd,
      env,
      ownerToken: options.ownerToken,
      reviewUuid,
      threadId: options.threadId,
      timeoutSeconds: options.timeout,
    });
  });

  configureJsonOutput(
    program
      .command("prepare-worktree <checkout-path>", { hidden: true })
      .description("Internal background worktree prepare runner")
      .requiredOption("--commit <commit>")
      .action(async (checkoutPath: string, options: { commit: string }) => {
        const resolvedPath = path.resolve(checkoutPath);

        const commands = await devfastPrepareCommands(resolvedPath).catch(
          (): string[] => [],
        );

        const result = await runtime.prepareReviewPinnedCheckout({
          checkoutPath: resolvedPath,
          commit: options.commit,
          commands,
        });

        state.exitCode = result.prepared ? 0 : 1;
      }),
    "plain",
  );

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

  configureJsonOutput(
    program.command("scaffold").description("Create a new UUID Review"),
    "plain",
  )
    .option("--base <ref>", "base revision")
    .option("--head <ref>", "head revision")
    .addOption(
      new Option("--pr <number-or-url>", "pull request").conflicts("head"),
    )
    .addOption(
      new Option(
        "--update",
        "re-pin the existing review from its bound change (creates one when none exists)",
      ).conflicts(["head", "pr"]),
    )
    .addOption(
      new Option("--review <uuid>", "review to update").implies({
        update: true,
      }),
    )
    .addOption(
      new Option(
        "--new",
        "create another Review for the same source",
      ).conflicts(["update", "review"]),
    )
    .action(async (options: ReviewScaffoldOptions) => {
      const event = await runtime.runReviewScaffold({
        cwd,
        baseRef: options.base,
        headRef: options.head,
        pullRequest: options.pr,
        env,
        toolingRoot: env.DEV_FAST_REVIEW_TOOLING_ROOT || undefined,
        progress: (message) => input.stderr.write(`${message}\n`),
        update: options.update,
        reviewUuid: options.review,
        newReview: options.new,
        onReviewBound: bindActiveReview,
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
      .option(
        "--force",
        "restart an interrupted migration and drop unrecoverable comment threads",
      ),
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

  const threads = configureOutput(
    program
      .command("threads")
      .description("Read and update review comment threads"),
    "plain",
  );

  configureJsonOutput(
    threads
      .command("get <thread-id>")
      .description("Print one comment thread as JSON")
      .option("--review <uuid>", "review UUID"),
    "plain",
  ).action(async (threadId: string, options: { review?: string }) => {
    state.exitCode = await runtime.runReviewThreadsGet({
      cwd,
      env,
      reviewUuid: options.review,
      threadId,
      stdout: input.stdout,
    });
  });
  configureOutput(
    threads
      .command("list")
      .description("Print all comment threads as JSON")
      .option("--review <uuid>", "review UUID"),
    "plain",
  ).action(async (options: { review?: string; json?: boolean }) => {
    state.exitCode = await runtime.runReviewThreadsList({
      cwd,
      reviewUuid: options.review,
      json: options.json,
      stdout: input.stdout,
    });
  });
  configureJsonOutput(
    threads
      .command("resolve <thread-id>")
      .description("Mark a comment thread resolved")
      .option("--review <uuid>", "review UUID"),
    "plain",
  ).action(async (threadId: string, options: { review?: string }) => {
    state.exitCode = await runtime.runReviewThreadsResolve({
      cwd,
      reviewUuid: options.review,
      threadId,
      stdout: input.stdout,
    });
  });
  configureJsonOutput(
    threads
      .command("reply <thread-id>")
      .description("Append a reply message to a comment thread")
      .requiredOption("--body <text>", "reply body")
      .option("--author <name>", "message author", "Agent")
      .option("--review <uuid>", "review UUID"),
    "plain",
  ).action(
    async (
      threadId: string,
      options: { body: string; author?: string; review?: string },
    ) => {
      state.exitCode = await runtime.runReviewThreadsReply({
        cwd,
        reviewUuid: options.review,
        threadId,
        body: options.body,
        author: options.author,
        stdout: input.stdout,
      });
    },
  );

  // Hosted trace store login. Logging in authenticates a user; it selects
  // no storage by itself.
  configureJsonOutput(
    program
      .command("login")
      .description("Log in to the hosted trace store with GitHub"),
    "plain",
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
          origin: options.origin,
          noBrowser: !options.browser,
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
    cliName: "review",
    reads: "review",
    storageOverride: true,
    traceCommand,
    scope,
    cwd,
    stdin: input.stdin,
    stdout: input.stdout,
    stderr: input.stderr,
    configureOutput: (command) => configureOutput(command, "plain"),
    configureJsonOutput: (command) => configureJsonOutput(command, "plain"),
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

  // The map surface is owned by map-cli.ts: git-notes storage with
  // commit-addressed scratch buffers (`open <rev>`, `check [<rev>]`, `prune`,
  // `push`, `fetch`, plus removal pointers for the retired home-backed
  // commands). Commander passes the raw arguments through so map-cli's own
  // parser and help remain the single source of truth for that shape.
  const map = configureOutput(
    program
      .command("map")
      .description("Manage the git-notes-backed software map")
      .argument("[args...]", "map subcommand and arguments")
      .allowUnknownOption()
      .allowExcessArguments()
      .helpOption(false)
      .passThroughOptions()
      .addHelpText("after", reviewMapHelp()),
    "map",
  );

  map.action((mapArgs: string[]) => executeMap(mapArgs));

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
    await program.parseAsync(input.argv, { from: "user" });

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
      emitReviewEvent(input.stdout, {
        event: "error",
        error: serializeReviewError(error),
      });
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

function parseTimeoutSeconds(value: string): number {
  const timeout = Number(value);

  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new Error("Timeout must be a positive number of seconds.");
  }

  return timeout;
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
    runReviewScaffold,
    runReviewInternalTest,
    runReviewPublish,
    runReviewRepair,
    runReviewRebind,
    runReviewThreadsGet,
    runReviewThreadsList,
    runReviewThreadsResolve,
    runReviewThreadsReply,
    runReviewWait,
    runReviewCodexWait,
    startCodexWaitProcess,
    validateReviewWait,
    runInstall,
    installReviewCommand,
    runReviewMigration,
    runSoftwareMapCli,
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
    runTraceOnboard,
    runTraceSessions,
    runTraceAllow,
    runTraceDeny,
    runStoreLogin,
    runStoreLogout,
    runStoreWhoami,
    prepareReviewPinnedCheckout,
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
    "Use `review info` to discover Review documents for this checkout, or `review scaffold` to create one.",
    "Edit the returned review.mdx and data.ts files, then use `review present` (alias of `review publish`). It validates in the CLI before contacting Review Desktop.",
    "The CLI validates before publishing; Review Desktop promotes the revision before mounting it.",
    "Use `review app launch` to start Review Desktop. Use `review app pick --review <uuid>` after publication.",
    "Use `--view <review|commits|diff|map|trace>` with `review publish` or `review app pick` to choose the opened tab.",
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

function reviewMapHelp(): string {
  return [
    "",
    "Notes under refs/notes/dev-fast/* are the only durable map state: one map per commit, never checked into any branch.",
    "The editable file is a scratch buffer — a commit-addressed working copy of one commit's note, hydrated from a note and disposable at any time.",
    "Use review map open <rev> to hydrate <rev>'s scratch, review map check [<rev>] [--review <uuid>] to validate and save it to <rev>'s note, review map publish to present the pinned maps, review map prune to drop stale notes and swept scratches, and review map push / fetch to share map notes through the selected notes remote.",
    "Run review map help for the full subcommand reference.",
  ].join("\n");
}

function mapCommandProperties(
  mapArgs: readonly string[],
  parsed: ReturnType<typeof parseSoftwareMapCliArgs>,
) {
  const metadata = parsed.ok
    ? mapTelemetryMetadata(parsed.command, parsed.force, parsed.diffRefs)
    : mapTelemetryMetadata("check", false, {});

  return {
    command: "map",
    subcommand: normalizeMapTelemetrySubcommand(mapArgs),
    mode: metadata.mode,
    has_base_ref: metadata.has_base_ref,
    has_head_ref: metadata.has_head_ref,
    force: metadata.force,
  };
}

function mapTelemetryMetadata(
  command: string,
  force: boolean,
  diffRefs: { baseRef?: string; headRef?: string },
) {
  const mode =
    command === "init" || command === "update" || command === "check"
      ? command
      : "check";

  return {
    mode,
    has_base_ref: Boolean(diffRefs.baseRef),
    has_head_ref: Boolean(diffRefs.headRef),
    force: command === "init" ? force : false,
  };
}

function isMapHelpCommand(command: string): boolean {
  return command === "--help" || command === "-h" || command === "help";
}

function normalizeMapTelemetrySubcommand(
  inputArgs: readonly string[],
):
  | "open"
  | "check"
  | "publish"
  | "prune"
  | "push"
  | "fetch"
  | "scaffold"
  | "snapshot"
  | "refresh"
  | "init"
  | "update"
  | "help"
  | "unknown" {
  const args = inputArgs[0] === "--" ? inputArgs.slice(1) : inputArgs;
  const rawCommand = args[0] ?? "check";
  const command = rawCommand === "present" ? "publish" : rawCommand;

  if (isMapHelpCommand(command)) {
    return "help";
  }

  if (
    command === "open" ||
    command === "check" ||
    command === "publish" ||
    command === "prune" ||
    command === "push" ||
    command === "fetch" ||
    // Removed verbs stay labeled so their exit-1 pointers remain observable.
    command === "scaffold" ||
    command === "snapshot" ||
    command === "refresh" ||
    command === "init" ||
    command === "update"
  ) {
    return command;
  }

  return "unknown";
}

async function finishActiveTelemetry(
  telemetry: ReviewCommandTelemetry,
  active:
    | {
        command: ReviewCliCommandPath;
        commandRunId: string;
        startedAt: number;
        finished: boolean;
        reviewUuid?: string;
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
          reviewUuid: active.reviewUuid,
        })
      : telemetry.captureCommandFailed({
          command: active.command,
          commandRunId: active.commandRunId,
          exitCode,
          durationMs: Date.now() - active.startedAt,
          properties,
          reviewUuid: active.reviewUuid,
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

  if (parent === "map" || name === "map") {
    const subcommand = normalizeMapTelemetrySubcommand(
      name === "map" ? argv.slice(argv.indexOf("map") + 1) : [name],
    );

    return subcommand === "open" ||
      subcommand === "check" ||
      subcommand === "publish" ||
      subcommand === "prune" ||
      subcommand === "push" ||
      subcommand === "fetch"
      ? `map.${subcommand}`
      : "invalid";
  }

  if (parent === "migrate" && name === "apply") return "migrate.apply";

  if (parent === "trace") {
    if (name === "onboard" || name === "allow" || name === "deny") {
      return `trace.${name}`;
    }
  }

  if (parent === "storage" && name === "use") return "trace.storage.use";

  if (parent === "config" && name === "migrate") return "trace.config.migrate";

  if (name === "login" || name === "logout" || name === "whoami") return name;

  if (parent === "app" && (name === "launch" || name === "pick")) {
    return `app.${name}`;
  }

  if (parent === "threads") {
    if (name === "list" || name === "resolve" || name === "reply") {
      return `threads.${name}`;
    }

    return "invalid";
  }

  if (
    name === "version" ||
    name === "rebind" ||
    name === "publish" ||
    name === "wait" ||
    name === "info" ||
    name === "scaffold" ||
    name === "install"
  ) {
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

  if (command === "scaffold") {
    return { errorName: "index_error", errorCategory: "dependency" };
  }

  if (
    command === "publish" ||
    command === "wait" ||
    command === "rebind" ||
    command === "info" ||
    command.startsWith("threads.")
  ) {
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
