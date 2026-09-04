import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Writable } from "node:stream";

import { devfastPrepareCommands } from "@dev.fast/local-vcs";
import {
  type ReviewView,
  jsonObject,
  jsonString,
  parseJsonText,
} from "@dev.fast/review-protocol";
import { Argument, Command, CommanderError, Option } from "commander";

import {
  type CliInputStream,
  humanStream,
  jsonRequestedInArgv,
} from "./cli-output";
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
import { readProgressiveReviewPackageVersion } from "./package-paths";
import {
  type ProgressiveReviewCommand,
  type ProgressiveReviewCommandPath,
  type ProgressiveReviewCommandTelemetry,
  ProgressiveReviewTelemetry,
  type ProgressiveReviewTelemetryErrorCategory,
  type ProgressiveReviewTelemetryErrorName,
} from "./progressive-review-telemetry";
import { type ReviewAppEvent, runReviewAppPick } from "./review-app";
import {
  type ReviewAppLaunchEvent,
  runReviewAppLaunch,
} from "./review-app-launcher";
import { runReviewCodexWait } from "./review-codex-wait";
import {
  type StoredReview,
  listReviews,
  sealReviewCandidate,
} from "./review-home";
import { runReviewInfo } from "./review-info";
import { runReviewInternalTest } from "./review-internal-test";
import { emitReviewEvent, serializeReviewError } from "./review-logger";
import { prepareReviewPinnedCheckout } from "./review-prepare";
import { runReviewPublish } from "./review-publish";
import { runReviewRebind } from "./review-rebind";
import {
  decideStopHook,
  markReopenNudged,
  readReopenMarker,
} from "./review-reopen-marker";
import { runReviewScaffold } from "./review-scaffold";
import { runReviewWait, validateReviewWait } from "./review-wait";
import { installReviewCommand, pathShimPath } from "./server/cli-install";
import { reviewDesktopDiscoveryPath } from "./server/desktop-paths";
import {
  DEFAULT_STORE_ORIGIN,
  runReviewLogin,
  runReviewLogout,
  runReviewWhoami,
} from "./store-auth";
import {
  runReviewThreadsGet,
  runReviewThreadsList,
  runReviewThreadsReply,
  runReviewThreadsResolve,
} from "./threads-cli";
import {
  runReviewTraceAllow,
  runReviewTraceBlame,
  runReviewTraceDeny,
  runReviewTraceGitHook,
  runReviewTraceHook,
  runReviewTraceList,
  runReviewTraceOnboard,
  runReviewTracePull,
  runReviewTraceRepair,
  runReviewTraceShow,
  runReviewTraceStatus,
  runReviewTraceSync,
} from "./trace-cli";

interface ProgressiveReviewCliRuntime {
  runReviewAppLaunch: typeof runReviewAppLaunch;
  runReviewAppPick: typeof runReviewAppPick;
  runReviewInfo: typeof runReviewInfo;
  runReviewScaffold: typeof runReviewScaffold;
  runReviewInternalTest: typeof runReviewInternalTest;
  runReviewPublish: typeof runReviewPublish;
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
  runReviewTraceStatus: typeof runReviewTraceStatus;
  runReviewTraceOnboard: typeof runReviewTraceOnboard;
  runReviewTraceAllow: typeof runReviewTraceAllow;
  runReviewTraceDeny: typeof runReviewTraceDeny;
  runReviewTraceRepair: typeof runReviewTraceRepair;
  runReviewTraceList: typeof runReviewTraceList;
  runReviewTraceShow: typeof runReviewTraceShow;
  runReviewTracePull: typeof runReviewTracePull;
  runReviewTraceBlame: typeof runReviewTraceBlame;
  runReviewTraceHook: typeof runReviewTraceHook;
  runReviewTraceGitHook: typeof runReviewTraceGitHook;
  runReviewTraceSync: typeof runReviewTraceSync;
  listReviews: typeof listReviews;
  sealReviewCandidate: typeof sealReviewCandidate;
  prepareReviewPinnedCheckout: typeof prepareReviewPinnedCheckout;
  runReviewLogin: typeof runReviewLogin;
  runReviewLogout: typeof runReviewLogout;
  runReviewWhoami: typeof runReviewWhoami;
}

export interface ProgressiveReviewCliInput {
  argv: string[];
  cliVersion?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdin?: CliInputStream;
  stdout: Writable;
  stderr: Writable;
  telemetry?: ProgressiveReviewCommandTelemetry;
  runtime?: Partial<ProgressiveReviewCliRuntime>;
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

type OutputSurface = ProgressiveReviewCommand | "plain";

interface CliRunState {
  exitCode: number;
  parseSurface: OutputSurface;
  parserErrorOutput: string;
  json: boolean;
}

export async function runProgressiveReviewCli(
  input: ProgressiveReviewCliInput,
): Promise<number> {
  const env = input.env ?? process.env;
  const cwd = input.cwd ?? env.INIT_CWD ?? process.cwd();
  const cliVersion =
    input.cliVersion ?? readProgressiveReviewPackageVersion(import.meta.url);
  const runtime = progressiveReviewCliRuntime(input.runtime);
  const telemetry = input.telemetry ?? ProgressiveReviewTelemetry.fromEnv(env);
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
        command: ProgressiveReviewCommandPath;
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
    .addHelpText("after", progressiveReviewTopLevelHelp());
  // Tolerate the leading form (`review --json scaffold`) as well as the usual
  // trailing one. Never give this a .default(): optsWithGlobals merges globals
  // over locals, so a default would clobber a subcommand's own true.
  program.addOption(new Option("--json").hideHelp());
  program.exitOverride();

  configureJsonOutput(
    program.command("version").description("Print Review package version"),
    "plain",
  ).action((options: { json?: boolean }) => {
    input.stdout.write(
      options.json
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
        state.exitCode = await runtime.runReviewLogin({
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
      state.exitCode = await runtime.runReviewLogout({ stdout: input.stdout });
    });

  configureJsonOutput(
    program.command("whoami").description("Show the hosted trace store login"),
    "plain",
  ).action(async (options: { json?: boolean }) => {
    state.exitCode = await runtime.runReviewWhoami({
      json: options.json,
      stdout: input.stdout,
      stderr: input.stderr,
    });
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
        "--no-shim",
        "Install skills without the review command or PATH changes",
      )
      .addHelpText("after", progressiveReviewInstallHelp()),
    "plain",
  );
  install.action(
    async (
      targets: string[],
      options: {
        json?: boolean;
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

  configureOutput(
    program
      .command("stop-hook", { hidden: true })
      .description("Internal Review stop hook"),
    "plain",
  ).action(async () => {
    const payload = await readStopHookPayload(input);
    for (const review of await touchedStopHookReviews(
      payload,
      runtime.listReviews,
    )) {
      await runtime.sealReviewCandidate(review.dir, "Review turn checkpoint");
    }
    const decisionCwd = payload.cwd ?? cwd;
    const marker = await readReopenMarker(decisionCwd);
    const decision = decideStopHook(marker);
    if (decision.markNudged && marker) {
      await markReopenNudged(decisionCwd, marker);
    }
    if (decision.block) {
      input.stdout.write(
        `${JSON.stringify({ decision: "block", reason: decision.reason })}\n`,
      );
    }
    state.exitCode = 0;
  });

  // The trace surface: onboard and allow a repository, inspect storage, or
  // read events. `traces` is an alias for scripts that prefer the plural.
  const trace = configureOutput(
    program.command("trace").alias("traces").description("Manage agent traces"),
    "plain",
  );
  configureJsonOutput(
    trace
      .command("status")
      .description("Show login, allowed repositories, and pending sessions"),
    "plain",
  ).action(async (options: { json?: boolean }) => {
    state.exitCode = await runtime.runReviewTraceStatus({
      cwd,
      json: options.json,
      stdout: input.stdout,
      stderr: input.stderr,
    });
  });

  configureJsonOutput(
    trace
      .command("onboard [path]")
      .description("Create the hosted trace store for one repository"),
    "plain",
  ).action(
    async (repoPath: string | undefined, options: { json?: boolean }) => {
      state.exitCode = await runtime.runReviewTraceOnboard({
        cwd: repoPath ? path.resolve(cwd, repoPath) : cwd,
        json: options.json,
        stdout: input.stdout,
        stderr: input.stderr,
      });
    },
  );

  configureJsonOutput(
    trace
      .command("allow [path]")
      .description("Allow one repository to publish traces")
      .option(
        "--no-harness-hooks",
        "skip the Claude, Codex, and pi hook installers",
      ),
    "plain",
  ).action(
    async (
      repoPath: string | undefined,
      options: { json?: boolean; harnessHooks?: boolean },
    ) => {
      state.exitCode = await runtime.runReviewTraceAllow({
        cwd: repoPath ? path.resolve(cwd, repoPath) : cwd,
        json: options.json,
        harnessHooks: options.harnessHooks,
        stdout: input.stdout,
        stderr: input.stderr,
      });
    },
  );

  configureJsonOutput(
    trace
      .command("deny [path]")
      .description("Stop publishing traces from one repository"),
    "plain",
  ).action(
    async (repoPath: string | undefined, options: { json?: boolean }) => {
      state.exitCode = await runtime.runReviewTraceDeny({
        cwd: repoPath ? path.resolve(cwd, repoPath) : cwd,
        json: options.json,
        stdout: input.stdout,
        stderr: input.stderr,
      });
    },
  );

  configureOutput(
    trace
      .command("repair [path]")
      .description("Repair Review trace hooks for one Git repository"),
    "plain",
  ).action(async (repoPath?: string) => {
    state.exitCode = await runtime.runReviewTraceRepair({
      cwd: repoPath ? path.resolve(cwd, repoPath) : cwd,
      stdout: input.stdout,
      stderr: input.stderr,
    });
  });

  configureJsonOutput(
    trace
      .command("list")
      .description("List agent sessions for a Review or commit")
      .option("--review <uuid>", "review UUID")
      .option("--commit <sha>", "commit or revision"),
    "plain",
  ).action(
    async (options: { review?: string; commit?: string; json?: boolean }) => {
      if (options.review && options.commit) {
        throw new Error("Use either --review or --commit, not both.");
      }
      state.exitCode = await runtime.runReviewTraceList({
        cwd,
        reviewUuid: options.review,
        commitSha: options.commit,
        json: options.json,
        stdout: input.stdout,
      });
    },
  );

  configureJsonOutput(
    trace
      .command("show <session-id>")
      .description("Survey a trace or show an exact event")
      .option("--trace <name>", "trace name; omit for the main trace")
      .option(
        "--event <index>",
        "print the complete text of one event",
        (value: string) => Number.parseInt(value, 10),
      )
      .option("--kind <kind>", "only list user|assistant|tool|separator rows"),
    "plain",
  ).action(
    async (
      sessionId: string,
      options: {
        trace?: string;
        event?: number;
        kind?: string;
        json?: boolean;
      },
    ) => {
      state.exitCode = await runtime.runReviewTraceShow({
        cwd,
        sessionId,
        trace: options.trace,
        eventIndex: options.event,
        kind: options.kind,
        json: options.json,
        stdout: input.stdout,
        stderr: input.stderr,
      });
    },
  );

  configureJsonOutput(
    trace
      .command("pull")
      .description("Pull traces into the local FFF search corpus")
      .option("--repo <owner/repo>", "repository for the corpus path")
      .option("--review <uuid>", "pull sessions for one Review")
      .option("--commit <sha>", "pull sessions for one commit or revision")
      .option("--session <id>", "pull one session")
      .option("--main-only", "exclude subagent traces"),
    "plain",
  ).action(
    async (options: {
      repo?: string;
      review?: string;
      commit?: string;
      session?: string;
      mainOnly?: boolean;
      json?: boolean;
    }) => {
      const selectors = [
        options.review,
        options.commit,
        options.session,
      ].filter(Boolean);
      if (selectors.length > 1) {
        throw new Error("Use only one of --review, --commit, or --session.");
      }
      state.exitCode = await runtime.runReviewTracePull({
        cwd,
        repo: options.repo,
        reviewUuid: options.review,
        commitSha: options.commit,
        session: options.session,
        mainOnly: options.mainOnly,
        json: options.json,
        stdout: input.stdout,
        stderr: input.stderr,
      });
    },
  );

  configureJsonOutput(
    trace
      .command("blame <file>")
      .description("Blame lines in a file to agent sessions")
      .option("-L, --lines <range>", "start,end line range")
      .option(
        "--history",
        "use git log -L to include every commit that shaped the lines",
      ),
    "plain",
  ).action(
    async (
      file: string,
      options: {
        lines?: string;
        history?: boolean;
        json?: boolean;
      },
    ) => {
      state.exitCode = await runtime.runReviewTraceBlame({
        cwd,
        file,
        lines: options.lines,
        history: options.history,
        json: options.json,
        stdout: input.stdout,
        stderr: input.stderr,
      });
    },
  );

  configureJsonOutput(
    trace
      .command("sync <session-id>")
      .description("Ship a local session trace to the hosted trace store")
      .option("--repo <repo>", "GitHub owner/repo"),
    "plain",
  ).action(
    async (
      sessionId: string,
      options: {
        repo?: string;
        json?: boolean;
      },
    ) => {
      state.exitCode = await runtime.runReviewTraceSync({
        cwd,
        sessionId,
        repo: options.repo,
        json: options.json,
        stdout: input.stdout,
        stderr: input.stderr,
      });
    },
  );

  configureOutput(
    trace
      .command("hook <event>", { hidden: true })
      .description("Handle agent session lifecycle hooks")
      .option("--session <id>", "Agent session ID"),
    "plain",
  ).action(
    async (
      event: string,
      options: {
        session?: string;
      },
    ) => {
      state.exitCode = await runtime.runReviewTraceHook({
        cwd,
        event,
        sessionId: options.session,
        stdin: input.stdin,
      });
    },
  );

  configureOutput(
    trace
      .command("git-hook <hook> [args...]", { hidden: true })
      .description("Run a package-owned Git trace hook"),
    "plain",
  ).action(async (hook: string, args: string[]) => {
    state.exitCode = await runtime.runReviewTraceGitHook({
      cwd,
      hook,
      args,
      stdin: input.stdin,
      stderr: input.stderr,
    });
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
      .addHelpText("after", progressiveReviewMapHelp()),
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
        .map((target) => (target === "claude-code" ? "claude" : target))
        .filter(isInstallTarget),
    ),
  ];
}

interface StopHookPayload {
  cwd?: string;
  transcriptPath?: string;
}

async function readStopHookPayload(
  input: ProgressiveReviewCliInput,
): Promise<StopHookPayload> {
  const stdin = input.stdin ?? process.stdin;
  if (stdin.isTTY) return {};
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of stdin) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const raw = Buffer.concat(chunks).toString("utf8").trim();
    if (!raw) return {};
    const parsed = jsonObject(parseJsonText(raw));
    const payload: StopHookPayload = {};
    const cwd = jsonString(parsed?.cwd);
    if (cwd !== undefined) payload.cwd = cwd;
    const transcriptPath = jsonString(parsed?.transcript_path);
    if (transcriptPath !== undefined) payload.transcriptPath = transcriptPath;
    return payload;
  } catch {
    return {};
  }
}

async function touchedStopHookReviews(
  input: {
    cwd?: string;
    transcriptPath?: string;
  },
  scan: typeof listReviews,
): Promise<StoredReview[]> {
  const listed = await scan();
  if (listed.errors.length > 0) {
    throw new Error(
      `Could not checkpoint reviews:\n${listed.errors.map((error) => `${error.reviewDir}: ${error.message}`).join("\n")}`,
    );
  }
  const cwd = input.cwd ? path.resolve(input.cwd) : undefined;
  const transcript = input.transcriptPath
    ? await readFile(input.transcriptPath, "utf8")
    : "";
  return listed.reviews.filter((review) => {
    const dir = path.resolve(review.dir);
    const cwdInside =
      cwd === dir || (cwd?.startsWith(`${dir}${path.sep}`) ?? false);
    return cwdInside || transcript.includes(dir);
  });
}

function progressiveReviewCliRuntime(
  overrides: Partial<ProgressiveReviewCliRuntime> | undefined,
): ProgressiveReviewCliRuntime {
  return {
    runReviewAppLaunch,
    runReviewAppPick,
    runReviewInfo,
    runReviewScaffold,
    runReviewInternalTest,
    runReviewPublish,
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
    runReviewTraceStatus,
    runReviewTraceOnboard,
    runReviewTraceAllow,
    runReviewTraceDeny,
    runReviewTraceRepair,
    runReviewTraceList,
    runReviewTraceShow,
    runReviewTracePull,
    runReviewTraceBlame,
    runReviewTraceHook,
    runReviewTraceGitHook,
    runReviewTraceSync,
    listReviews,
    sealReviewCandidate,
    prepareReviewPinnedCheckout,
    runReviewLogin,
    runReviewLogout,
    runReviewWhoami,
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

function progressiveReviewTopLevelHelp(): string {
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

function progressiveReviewInstallHelp(): string {
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
    "Trace capture needs no options here: run review login, then",
    "review trace allow . in each repository that may publish traces.",
  ].join("\n");
}

function progressiveReviewMapHelp(): string {
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
  telemetry: ProgressiveReviewCommandTelemetry,
  active:
    | {
        command: ProgressiveReviewCommandPath;
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
  telemetry: ProgressiveReviewCommandTelemetry,
  command: ProgressiveReviewCommandPath,
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
): ProgressiveReviewCommandPath | undefined {
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
    parent === "trace" &&
    (name === "onboard" || name === "allow" || name === "deny")
  ) {
    return `trace.${name}`;
  }
  if (
    name === "version" ||
    name === "rebind" ||
    name === "publish" ||
    name === "wait" ||
    name === "info" ||
    name === "scaffold" ||
    name === "install" ||
    name === "login" ||
    name === "logout" ||
    name === "whoami"
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
  errorName: ProgressiveReviewTelemetryErrorName;
  errorCategory: ProgressiveReviewTelemetryErrorCategory;
}

function errorClassification(
  command: ProgressiveReviewCommandPath,
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
    await fn();
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
