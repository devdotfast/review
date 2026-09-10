import type { Readable, Writable } from "node:stream";

export interface ReviewCliInput {
  argv: string[];
  stdin: Readable;
  stdout: Writable;
  stderr: Writable;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

/** Public CLI boundary. Obsolete authoring commands never import the legacy
 * document/SQL runtime and no operation delegates to an installed binary. */
export async function runReviewCli(input: ReviewCliInput): Promise<number> {
  const argv = [...input.argv];
  while (argv[0] === "--json") argv.shift();
  const command = argv[0];
  if (
    !command ||
    command === "--help" ||
    command === "-h" ||
    (command === "help" && !argv[1])
  ) {
    input.stdout.write(
      "Usage: review <command>\n\n  host capabilities                       Discover the current API\n  host connection                         Inspect the bound host/workspace\n  host query <operation> --input <json>    Read reviews, documents and feedback\n  host command <operation> --command-id <uuid> --input <json>\n                                          Apply one atomic API command\n  host open --review <uuid>                Show a review in running Desktop\n  mcp                                     Start the thin stdio MCP client\n  app launch                              Start or activate Review Desktop\n  install [targets...]                    Install skills and this CLI\n  version                                 Print package version\n  trace                                   Local agent trace utilities\n\nReview Desktop owns review data. Clients do not author MDX/data.ts, read review files, or execute SQL. Commands require an already running host; only app launch starts Desktop.\n",
    );
    return 0;
  }
  if (command === "host") {
    const { runHostCli } = await import("./host/host-cli.js");
    return runHostCli({ ...input, argv: argv.slice(1) });
  }
  if (command === "mcp") {
    const { runHostMcp } = await import("./host/host-mcp.js");
    return runHostMcp({ ...input, argv: argv.slice(1) });
  }
  if (command === "internal-thread") {
    const { runTutorialThreadCli } = await import("./tutorial-thread-cli.js");
    return runTutorialThreadCli({ ...input, argv: argv.slice(1) });
  }
  const requested = command === "help" ? argv[1]! : command;
  const appSelection =
    requested === "app" &&
    (argv.includes("pick") ||
      argv.some(
        (value) => value === "--review" || value.startsWith("--review="),
      ));
  const replacement = obsoleteCommandGuidance(requested, appSelection);
  if (replacement) {
    input.stdout.write(
      `${JSON.stringify({ ok: false, error: { code: "UNSUPPORTED_VERSION", message: replacement, retryable: false, diagnostics: [] } })}\n`,
    );
    return 1;
  }
  if (
    ![
      "app",
      "install",
      "version",
      "--version",
      "-V",
      "trace",
      "traces",
      "internal-test",
      "prepare-worktree",
    ].includes(requested)
  ) {
    input.stdout.write(
      `${JSON.stringify({ ok: false, error: { code: "INVALID_REQUEST", message: `Unknown Review command: ${requested}. Run review --help or review host capabilities.`, retryable: false, diagnostics: [] } })}\n`,
    );
    return 1;
  }
  const { runProgressiveReviewCli } = await import("./cli-runner.js");
  return runProgressiveReviewCli(input);
}

function obsoleteCommandGuidance(
  command: string,
  appSelection: boolean,
): string | undefined {
  if (appSelection)
    return "The file-backed app picker is retired. Use `review host query reviews.list --input '{}'`, then `review host open --review <uuid>`.";
  const prefix = `The file-backed \`review ${command}\` command is retired. `;
  switch (command) {
    case "scaffold":
      return (
        prefix +
        "Use `review host command review.create --command-id <uuid> --input '<json>'`."
      );
    case "info":
      return (
        prefix +
        "Use `review host query reviews.list --input '{}'` or the review.get query."
      );
    case "publish":
    case "present":
      return (
        prefix +
        "Use the review.publish host command with explicit document/review versions and map selections."
      );
    case "rebind":
      return (
        prefix + "Use review.repin.plan and review.repin.apply host commands."
      );
    case "document":
      return (
        prefix +
        "Use document.get, document.validate, document.mutate or document.replace through `review host`."
      );
    case "threads":
      return (
        prefix +
        "Use threads.list/thread.get host queries and thread.reply/thread.status host commands."
      );
    case "map":
      return (
        prefix +
        "Use map.create/map.mutate host commands and map.get/maps.list host queries. Maps are no longer authored through files or Git notes."
      );
    case "wait":
    case "wait-codex":
      return (
        prefix +
        "Observe review.get, feedback.list and questions.list through the host API and committed event subscriptions."
      );
    case "repair":
    case "migrate":
      return (
        prefix +
        "Legacy on-disk reviews are not converted automatically. Their files remain untouched. Create a new review through the review.create host command."
      );
    case "stop-hook":
      return "The Review stop hook has been removed. Remove any old `review stop-hook` entry from your agent settings. API mutations are committed immediately; review.publish explicitly creates checkpoints.";
    default:
      return undefined;
  }
}
