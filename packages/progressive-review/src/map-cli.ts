import { readFileSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import type { Writable } from "node:stream";

import {
  currentHead,
  fetchNotes,
  git,
  gitCommonDirSync,
  notesRemote,
  pruneNotes,
  pushNotes,
  readNote,
  resolveRevision,
} from "@dev.fast/local-vcs";
import { Argument, Command, CommanderError, Option } from "commander";

import {
  authoringSessionKey,
  resolveAuthoringSessionRef,
} from "./authoring-session";
import {
  type CliJsonOutput,
  emitJsonEvent,
  failWithJsonError,
  humanStream,
  jsonRequestedInArgv,
} from "./cli-output";
import { touchReviewAgentSession } from "./review-home";
import { runReviewMapPublish } from "./review-map-publish";
import {
  SOFTWARE_MAP_FILE_NAME,
  SOFTWARE_MAP_NOTES_REF,
  devFastGitDir,
} from "./review-storage";
import { resolveReviewRepoRootFromStore } from "./review-worktree-target";
import { resolveReviewRoot } from "./runtime";
import { resolvePublishReview } from "./server/publish-preparation";
import {
  type HydrateScratchResult,
  canonicalizeModelImport,
  flushScratch,
  hydrateScratch,
  scratchSoftwareMapPath,
} from "./software-map-artifact";
import { collectSoftwareMapConnectivityWarnings } from "./software-map-connectivity-validation";
import { checkSoftwareMapSource } from "./software-map-health";
import type {
  NormalizedSoftwareElement,
  NormalizedSoftwareModel,
} from "./software-map-model";

/** The --json line `review map open` writes for a hydrated scratch. */
interface MapOpenEvent {
  event: "map-open";
  scratch: string;
  commit: string;
  dirty: boolean;
  hydratedFrom: HydrateScratchResult["hydratedFrom"];
  seedCommit?: string;
  distance?: number;
  /** The diff the map agent must apply before it checks (ancestor-note only). */
  diffRange?: string;
}

export interface SoftwareMapCliInput {
  args: string[];
  cwd: string;
  stdout: Writable;
  stderr: Writable;
  env?: NodeJS.ProcessEnv;
}

export async function runSoftwareMapCli(
  input: SoftwareMapCliInput,
): Promise<number> {
  const parsed = parseSoftwareMapCliArgs(input.args);
  // A parse failure happens before options resolve, so read the flag from raw
  // argv the same way the top-level CLI does.
  const json = parsed.ok ? parsed.json : jsonRequestedInArgv(input.args);
  const output: CliJsonOutput = {
    json,
    stdout: input.stdout,
    stderr: input.stderr,
  };
  if (!parsed.ok) {
    const exitCode = failWithJsonError(output, "map", parsed.error);
    input.stderr.write(softwareMapCliHelp());
    return exitCode;
  }

  const { command } = parsed;

  if (command === "--help" || command === "-h" || command === "help") {
    input.stdout.write(softwareMapCliHelp());
    return 0;
  }
  if (input.args.includes("--help") || input.args.includes("-h")) {
    input.stdout.write(softwareMapCliHelp());
    return 0;
  }

  if (command === "open") {
    return openSoftwareMapScratch({
      ...output,
      rootPath: input.cwd,
      rev: parsed.positionals[0],
      force: parsed.force,
    });
  }

  if (command === "check") {
    return checkSoftwareMapScratch({
      ...output,
      rootPath: input.cwd,
      rev: parsed.positionals[0],
      reviewUuid: parsed.review,
      env: input.env,
    });
  }

  if (command === "publish") {
    return runReviewMapPublish({
      cwd: input.cwd,
      reviewUuid: parsed.review,
      json: parsed.json,
      stdout: input.stdout,
      stderr: input.stderr,
      env: input.env,
    });
  }

  if (command === "prune") {
    return pruneSoftwareMapNotes({ ...output, rootPath: input.cwd });
  }

  if (command === "snapshot" || command === "refresh") {
    return failWithJsonError(
      output,
      "map",
      `review map ${command} was removed: \`review map check\` flushes the scratch to its commit's note on success.`,
    );
  }

  if (command === "scaffold") {
    return failWithJsonError(
      output,
      "map",
      "review map scaffold was removed: `review map open <rev>` hydrates or stubs the scratch for that revision.",
    );
  }

  if (command === "init" || command === "update") {
    return failWithJsonError(
      output,
      "map",
      `review map ${command} was removed: it spawned a nested coding agent. ` +
        "Run `review map open <rev>` to hydrate the scratch, author it " +
        "with the dev-review-map skill, and validate/" +
        "flush with `review map check <rev>`.",
    );
  }

  if (command === "push") {
    return pushSoftwareMapNotes({
      ...output,
      rootPath: input.cwd,
      remote: parsed.remote,
    });
  }

  if (command === "fetch") {
    return fetchSoftwareMapNotes({
      ...output,
      rootPath: input.cwd,
      remote: parsed.remote,
    });
  }

  const exitCode = failWithJsonError(
    output,
    "map",
    `Unknown map command: ${command}`,
  );
  input.stderr.write(softwareMapCliHelp());
  return exitCode;
}

function softwareMapCliHelp() {
  return [
    "Usage: review map open <rev> [--force]",
    "       review map check [<rev>] [--review <uuid>]",
    "       review map publish [--review <uuid>]",
    "       review map prune",
    "       review map push [--remote <name>]",
    "       review map fetch [--remote <name>]",
    "",
    "Manage the git-notes-backed software map.",
    "Every verb accepts --json: stdout then carries one JSON event and the human report moves to stderr.",
    "Notes under refs/notes/dev-fast/* are the only durable map state: one map per commit, never checked into any branch.",
    "The editable file is a scratch buffer — a commit-addressed working copy of one commit's note at $GIT_COMMON_DIR/dev-fast/scratch/<commit>/software-map.ts, hydrated from a note and disposable at any time.",
    "Use review map open <rev> to hydrate <rev>'s scratch: from <rev>'s own note when it has one, else seeded from the nearest annotated first-parent ancestor's note (its provenance line says which diff to apply), else a schema stub. --force discards unflushed scratch edits.",
    "Use review map check [<rev>] [--review <uuid>] to validate the scratch strictly; on success it SAVES the scratch to <rev>'s note. Without <rev> it targets the selected review's head commit.",
    "Use review map publish to publish the saved base and head maps to Review Desktop.",
    "Use review map prune to drop notes on commits that are gone or unreachable (jj working copies are kept), then sweep fully-flushed scratch buffers (dirty or note-less scratches are kept).",
    "Use review map push / fetch to share map notes with teammates. The remote defaults to devFast.notesRemote, then origin.",
    "",
  ].join("\n");
}

export interface SoftwareMapDiffRefOptions {
  baseRef?: string;
  headRef?: string;
}

type ParsedSoftwareMapCliArgs =
  | {
      ok: true;
      command: string;
      positionals: string[];
      force: boolean;
      diffRefs: SoftwareMapDiffRefOptions;
      pullRequest?: string;
      review?: string;
      remote?: string;
      json: boolean;
    }
  | { ok: false; error: string };

export function parseSoftwareMapCliArgs(
  inputArgs: readonly string[],
): ParsedSoftwareMapCliArgs {
  const args = inputArgs[0] === "--" ? inputArgs.slice(1) : [...inputArgs];
  const rawCommand = args[0] ?? "check";
  // `present` is an alias of `publish`.
  const command = rawCommand === "present" ? "publish" : rawCommand;
  if (command === "--help" || command === "-h" || command === "help") {
    return {
      ok: true,
      command,
      positionals: args.slice(1).filter((arg) => !arg.startsWith("-")),
      force: false,
      diffRefs: {},
      json: false,
    };
  }

  const commandModel = softwareMapCommandModel(command);
  try {
    commandModel.parse(args.slice(1), { from: "user" });
  } catch (error) {
    if (!(error instanceof CommanderError)) {
      throw error;
    }
    if (error.exitCode === 0) {
      return {
        ok: true,
        command,
        positionals: args.slice(1).filter((arg) => !arg.startsWith("-")),
        force: args.includes("--force"),
        diffRefs: {},
        json: args.includes("--json"),
      };
    }
    return { ok: false, error: softwareMapCommanderError(error, command) };
  }

  const options = commandModel.opts<{
    force?: boolean;
    base?: string;
    head?: string;
    pr?: string;
    review?: string;
    remote?: string;
    json?: boolean;
  }>();
  const missingRemovedOption = (
    [
      ["base", options.base],
      ["head", options.head],
      ["pr", options.pr],
    ] as const
  ).find(([, value]) => value === "");
  if (missingRemovedOption) {
    return {
      ok: false,
      error: `Expected a value after --${missingRemovedOption[0]}.`,
    };
  }
  if (options.remote !== undefined && !options.remote.trim()) {
    return { ok: false, error: "Expected a value after --remote." };
  }

  if (
    options.base !== undefined ||
    options.head !== undefined ||
    options.pr !== undefined
  ) {
    return { ok: false, error: removedSoftwareMapOptionError() };
  }

  return {
    ok: true,
    command,
    positionals: commandModel.args,
    force: options.force ?? false,
    diffRefs: {},
    review: options.review,
    remote: options.remote?.trim(),
    json: options.json ?? false,
  };
}

function softwareMapCommandModel(commandName: string): Command {
  const command = new Command()
    .name(commandName)
    .exitOverride()
    .configureOutput({
      writeOut: () => {},
      writeErr: () => {},
    })
    .addOption(new Option("--force").hideHelp())
    .addOption(new Option("--base <ref>").hideHelp())
    .addOption(new Option("--head <ref>").hideHelp())
    .addOption(new Option("--pr <number-or-url>").hideHelp())
    // Every verb accepts --json, not just publish. Unknown flags stay a hard
    // error below, so `--jsn` still fails.
    .addOption(new Option("--json").hideHelp());

  if (commandName === "open") {
    return command.addArgument(new Argument("<rev>"));
  }
  if (commandName === "check") {
    return command
      .addArgument(new Argument("[rev]"))
      .addOption(new Option("--review <uuid>"));
  }
  if (commandName === "publish") {
    return command.addOption(new Option("--review <uuid>"));
  }
  if (
    commandName === "prune" ||
    commandName === "push" ||
    commandName === "fetch"
  ) {
    return commandName === "push" || commandName === "fetch"
      ? command.addOption(new Option("--remote <name>"))
      : command;
  }
  return command.addArgument(new Argument("[args...]"));
}

function softwareMapCommanderError(
  error: CommanderError,
  command: string,
): string {
  if (/option '--remote <name>' argument missing/.test(error.message)) {
    return "Expected a value after --remote.";
  }
  const missingRemovedOption = error.message.match(
    /option '(--(?:base|head|pr))(?: <[^>]+>)?' argument missing/,
  )?.[1];
  if (missingRemovedOption) {
    return `Expected a value after ${missingRemovedOption}.`;
  }

  const unknownOption = error.message.match(/unknown option '([^']+)'/)?.[1];
  if (unknownOption) {
    // Unknown flags are a hard error: `--froce` silently proceeding as a
    // typo-ignoring success would discard the user's stated intent.
    return `Unknown flag: ${unknownOption}`;
  }

  if (command === "open" && error.code === "commander.missingArgument") {
    return "Expected a revision after open.";
  }

  return error.message.replace(/^error:\s*/, "");
}

function removedSoftwareMapOptionError(): string {
  return (
    "--base, --head, and --pr belong to the removed review map update; " +
    "pass revisions as arguments (open <rev>, check [<rev>])."
  );
}

// Hydrates <rev>'s scratch buffer from the read ladder (note → fetched peer
// note → evolog recovery), or writes the schema stub when the ladder fully
// misses. A scratch holding unflushed edits is left alone unless --force.
async function openSoftwareMapScratch(
  input: CliJsonOutput & {
    rootPath: string;
    rev: string | undefined;
    force: boolean;
  },
) {
  const human = humanStream(input);
  if (!input.rev) {
    return failWithJsonError(
      input,
      "map-open",
      "Usage: review map open <rev> [--force]",
    );
  }
  if (!gitCommonDirSync(input.rootPath)) {
    return failWithJsonError(
      input,
      "map-open",
      `${input.rootPath} is not inside a git repository; software maps are stored as git notes and need one.`,
    );
  }
  try {
    const hydrated = await hydrateScratch({
      repoRootPath: input.rootPath,
      rev: input.rev,
      force: input.force,
    });
    if (hydrated.dirty) {
      human.write(`scratch: ${hydrated.path}\n`);
      human.write(
        `the scratch for ${hydrated.commit} has unflushed edits; leaving it alone. Run review map check ${input.rev} to flush them, or re-run open with --force to discard them.\n`,
      );
      emitJsonEvent(input, {
        event: "map-open",
        scratch: hydrated.path,
        commit: hydrated.commit,
        dirty: true,
      });
      return 0;
    }
    human.write(`scratch: ${hydrated.path}\n`);
    human.write(`commit: ${hydrated.commit}\n`);
    human.write(`${openProvenanceLine(hydrated, input.rev)}\n`);
    const opened: MapOpenEvent = {
      event: "map-open",
      scratch: hydrated.path,
      commit: hydrated.commit,
      dirty: false,
      hydratedFrom: hydrated.hydratedFrom,
    };
    if (hydrated.seedCommit) opened.seedCommit = hydrated.seedCommit;
    if (hydrated.hydratedFrom === "ancestor-note") {
      opened.distance = hydrated.distance;
      // The diff the map agent must apply before it checks.
      opened.diffRange = `${hydrated.seedCommit}..${input.rev}`;
    }
    emitJsonEvent(input, opened);
    return 0;
  } catch (error) {
    return failWithJsonError(
      input,
      "map-open",
      error instanceof Error ? error.message : String(error),
    );
  }
}

// The provenance line doubles as the map agent's work order: it names the
// seed and exactly which diff (if any) must be applied before checking.
function openProvenanceLine(
  hydrated: HydrateScratchResult,
  rev: string,
): string {
  const short = (sha: string) => sha.slice(0, 12);
  switch (hydrated.hydratedFrom) {
    case "note":
    case "remote-note":
    case "evolog":
      return `hydrated from the note on ${short(hydrated.commit)} (this commit); the map is current — verify and check to confirm`;
    case "ancestor-note":
      return `hydrated from the note on ${short(hydrated.seedCommit!)}, ${hydrated.distance} commits behind ${rev}; review the diff ${short(hydrated.seedCommit!)}..${rev} and update the map to match`;
    case "stub":
      return `no note found on ${rev} or any ancestor; scratch is a schema stub — author a full map`;
  }
}

// Validates the scratch strictly; on success FLUSHES it to the commit's note.
// Every green check publishes — the flush is the snapshot.
async function checkSoftwareMapScratch(
  input: CliJsonOutput & {
    rootPath: string;
    rev: string | undefined;
    reviewUuid?: string;
    env?: NodeJS.ProcessEnv;
  },
) {
  const human = humanStream(input);
  const target = await resolveCheckTarget(input);
  if (!target.ok) {
    return failWithJsonError(input, "map-check", target.error);
  }
  const { repoRootPath, commit } = target;

  const mapPath = scratchSoftwareMapPath({ repoRootPath, commit });
  if (!mapPath) {
    return failWithJsonError(
      input,
      "map-check",
      `${repoRootPath} is not inside a git repository; software maps are stored as git notes and need one.`,
    );
  }
  const rawMapSource = readFileOrNull(mapPath);
  if (rawMapSource === null) {
    return failWithJsonError(
      input,
      "map-check",
      `No scratch exists for ${commit}. Run review map open ${input.rev ?? commit.slice(0, 12)} first.`,
    );
  }
  const authorIdentity = await git(repoRootPath, ["var", "GIT_AUTHOR_IDENT"], {
    allowFailure: true,
  });
  if (!authorIdentity.ok) {
    return failWithJsonError(
      input,
      "map-check",
      [
        "Git author identity is required to write software map notes.",
        'Configure this repository with `git config user.name "Your Name"` and `git config user.email "you@example.com"`, or add `--global` to set the defaults for every repository.',
      ].join("\n"),
    );
  }
  // The shared check core validates the canonicalized form — the exact bytes
  // the flush publishes — so check-validated bytes and flushed bytes stay the
  // same bytes. `review publish` runs this same function as its map gate.
  const check = await checkSoftwareMapSource({
    repoRootPath,
    commit,
    source: rawMapSource,
    sourceName: mapPath,
  });
  const mapSource = check.canonicalSource;
  if (!check.model || check.errors.length > 0) {
    input.stderr.write("software map: error\n");
    for (const error of check.errors) input.stderr.write(`- ${error}\n`);
    emitJsonEvent(input, {
      event: "error",
      stage: "map-check",
      commit,
      file: mapPath,
      diagnostics: check.errors,
    });
    return 1;
  }
  const model = check.model;

  const warnings = [
    ...collectSoftwareMapConnectivityWarnings(mapSource),
    ...collectSoftwareMapOwnershipWarnings(model),
  ];
  const counts = countSoftwareMapElements(model.elements);

  // The scratch is valid: flush it. Every green check publishes — and it
  // publishes exactly the bytes that were validated above, never a re-read
  // of the scratch (which could have changed since validation).
  try {
    await flushScratch({ repoRootPath, commit, mapSource });
  } catch (error) {
    return failWithJsonError(
      input,
      "map-check",
      `software map flush failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const agent = resolveAuthoringSessionRef(input.env ?? process.env);
  if (agent && input.reviewUuid) {
    const worktreeRoot = await resolveReviewRoot(input.rootPath);
    const review = await resolvePublishReview(worktreeRoot, input.reviewUuid);
    await touchReviewAgentSession(
      review,
      authoringSessionKey(agent),
      "map-worker",
    );
  }

  human.write("software map: healthy\n");
  human.write(`  file: ${mapPath}\n`);
  human.write(
    [
      `  people: ${counts.person}`,
      `systems: ${counts.softwareSystem}`,
      `containers: ${counts.container}`,
      `components: ${counts.component}`,
      `code elements: ${counts.codeElement}`,
      `relationships: ${model.relationships.length}`,
    ].join("\n  "),
  );
  human.write("\n");
  human.write(`note ${SOFTWARE_MAP_NOTES_REF} written for ${commit}\n`);

  if (warnings.length > 0) {
    human.write("software map warnings:\n");
    for (const warning of warnings) human.write(`- ${warning}\n`);
  }

  emitJsonEvent(input, {
    event: "map-check",
    status: "healthy",
    commit,
    file: mapPath,
    note: SOFTWARE_MAP_NOTES_REF,
    counts: { ...counts, relationships: model.relationships.length },
    warnings,
  });

  return 0;
}

type CheckTarget =
  | { ok: true; repoRootPath: string; commit: string }
  | { ok: false; error: string };

// An explicit rev resolves against the cwd's repository. Without one, the
// Without an explicit revision, the active Review's stored source commit is
// authoritative. An unpinned Review uses its worktree's current commit.
async function resolveCheckTarget(input: {
  rootPath: string;
  rev: string | undefined;
  reviewUuid?: string;
}): Promise<CheckTarget> {
  if (input.rev) {
    const resolved = await resolveRevision(input.rootPath, input.rev).catch(
      () => null,
    );
    if (!resolved?.commit) {
      return { ok: false, error: `Unable to resolve revision: ${input.rev}` };
    }
    return { ok: true, repoRootPath: input.rootPath, commit: resolved.commit };
  }

  const worktreeRoot = await resolveReviewRoot(input.rootPath);
  const review = await resolvePublishReview(worktreeRoot, input.reviewUuid);
  const repoRootPath = resolveReviewRepoRootFromStore(review.dir);
  const head = review.review.sourceCommit
    ? await resolveRevision(repoRootPath, review.review.sourceCommit).catch(
        () => null,
      )
    : await currentHead(repoRootPath).catch(() => null);
  if (!head?.commit) {
    return {
      ok: false,
      error:
        "Unable to resolve the active review's head commit. Pass one: review map check <rev>.",
    };
  }
  return { ok: true, repoRootPath, commit: head.commit };
}

async function pruneSoftwareMapNotes(
  input: CliJsonOutput & { rootPath: string },
) {
  const human = humanStream(input);
  const gitDir = gitCommonDirSync(input.rootPath);
  if (!gitDir) {
    return failWithJsonError(
      input,
      "map-prune",
      `${input.rootPath} is not inside a git repository; software maps are stored as git notes and need one.`,
    );
  }
  const pruned = await pruneNotes({
    rootPath: input.rootPath,
    ref: SOFTWARE_MAP_NOTES_REF,
  });
  human.write(
    pruned.removed.length === 0
      ? `${SOFTWARE_MAP_NOTES_REF}: nothing to prune\n`
      : `${SOFTWARE_MAP_NOTES_REF}: pruned ${pruned.removed.length} note(s) (${pruned.removed
          .map((commit) => commit.slice(0, 12))
          .join(", ")})\n`,
  );
  const swept = await sweepFlushedScratches({
    rootPath: input.rootPath,
    gitDir,
    stdout: human,
  });
  emitJsonEvent(input, {
    event: "map-prune",
    note: SOFTWARE_MAP_NOTES_REF,
    pruned: pruned.removed,
    scratchDeleted: swept.deleted,
    scratchKept: swept.kept,
  });
  return 0;
}

// Scratch buffers accumulate one dir per reviewed commit and are never
// reclaimed by authoring. A scratch dir is deleted ONLY when it is fully
// flushed — its canonicalized content (the same import canonicalization
// check's flush pipeline applies) is byte-equal to the note currently on its
// commit — so `review map open` re-hydrates it losslessly. Dirty scratches
// and scratches whose commit has no note are never deleted.
async function sweepFlushedScratches(input: {
  rootPath: string;
  gitDir: string;
  stdout: Writable;
}): Promise<{ deleted: number; kept: number }> {
  const scratchRoot = path.join(devFastGitDir(input.gitDir), "scratch");
  let commits: string[] = [];
  try {
    commits = readdirSync(scratchRoot);
  } catch {
    // No scratch directory yet: nothing to sweep.
  }
  let deleted = 0;
  let kept = 0;
  for (const commit of commits) {
    // Scratch dirs are named by their target commit; skip anything else.
    if (!/^[0-9a-f]{40,64}$/i.test(commit)) continue;
    const scratchDir = path.join(scratchRoot, commit);
    if (
      await scratchIsFullyFlushed({
        rootPath: input.rootPath,
        scratchDir,
        commit,
      })
    ) {
      rmSync(scratchDir, { recursive: true, force: true });
      deleted += 1;
      input.stdout.write(
        `scratch ${commit.slice(0, 12)}: deleted (flushed to its note)\n`,
      );
    } else {
      kept += 1;
    }
  }
  input.stdout.write(`scratch: ${deleted} deleted, ${kept} kept\n`);
  return { deleted, kept };
}

async function scratchIsFullyFlushed(input: {
  rootPath: string;
  scratchDir: string;
  commit: string;
}): Promise<boolean> {
  const mapSource = readFileOrNull(
    path.join(input.scratchDir, SOFTWARE_MAP_FILE_NAME),
  );
  if (mapSource === null) return false;
  const mapNote = await readNote({
    rootPath: input.rootPath,
    ref: SOFTWARE_MAP_NOTES_REF,
    commit: input.commit,
  });
  if (mapNote === null) return false;
  return canonicalizeModelImport(mapSource) === mapNote;
}

async function pushSoftwareMapNotes(
  input: CliJsonOutput & { rootPath: string; remote?: string },
) {
  const human = humanStream(input);
  const remote = await notesRemote(input.rootPath, input.remote);
  const result = await pushNotes({
    rootPath: input.rootPath,
    remote,
    refs: [SOFTWARE_MAP_NOTES_REF],
  });
  if (!result.ok) {
    return failWithJsonError(
      input,
      "map-push",
      `software map push failed for ${remote}: ${result.error ?? "unknown error"}. If another remote is writable, retry with --remote <name>.`,
    );
  }
  human.write(
    result.pushed.length === 0
      ? "no software-map notes to push.\n"
      : `pushed ${result.pushed.join(", ")} to ${remote}. Teammates receive them on their next fetch (review install configures the refspec).\n`,
  );
  emitJsonEvent(input, { event: "map-push", remote, pushed: result.pushed });
  return 0;
}

async function fetchSoftwareMapNotes(
  input: CliJsonOutput & { rootPath: string; remote?: string },
) {
  const human = humanStream(input);
  const remote = await notesRemote(input.rootPath, input.remote);
  const result = await fetchNotes({ rootPath: input.rootPath, remote });
  if (!result.ok) {
    return failWithJsonError(
      input,
      "map-fetch",
      `software map fetch failed for ${remote}: ${result.error ?? "unknown error"}`,
    );
  }
  human.write(
    result.skipped
      ? "software-map note fetch skipped (devFast.fetchNotes=false).\n"
      : `fetched software-map notes from ${remote} into refs/notes/dev-fast/remote/*.\n`,
  );
  emitJsonEvent(input, {
    event: "map-fetch",
    remote,
    skipped: result.skipped ?? false,
  });
  return 0;
}

function readFileOrNull(filePath: string): string | null {
  try {
    return readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function countSoftwareMapElements(
  elements: readonly NormalizedSoftwareElement[],
) {
  return {
    person: elements.filter((element) => element.type === "person").length,
    softwareSystem: elements.filter(
      (element) => element.type === "softwareSystem",
    ).length,
    container: elements.filter((element) => element.type === "container")
      .length,
    component: elements.filter((element) => element.type === "component")
      .length,
    codeElement: elements.filter((element) => element.type === "codeElement")
      .length,
  };
}

function collectSoftwareMapOwnershipWarnings(model: NormalizedSoftwareModel) {
  const warnings: string[] = [];
  const componentCount = model.elements.filter(
    (element) => element.type === "component",
  ).length;
  const uncoveredComponents = model.elements
    .filter((element) => element.type === "component" && !element.coverage)
    .map((element) => element.path);

  if (uncoveredComponents.length > 0) {
    warnings.push(
      `SoftwareMap ownership: ${uncoveredComponents.length}/${componentCount} component(s) have no coverage claim: ${previewList(uncoveredComponents)}.`,
    );
  }
  return warnings;
}

function previewList(values: readonly string[]) {
  const preview = values.slice(0, 8).join(", ");
  const suffix = values.length > 8 ? `, and ${values.length - 8} more` : "";
  return `${preview}${suffix}`;
}
