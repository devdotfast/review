import type { Writable } from "node:stream";

import { installHarnessHooks, skippedHarnessesLine } from "./agent-trace-hooks";
import { type CliJsonOutput, emitJsonEvent, humanStream } from "./cli-output";
import { errorMessage } from "./error-message";
import { inferRepoFromGit, syncReviewTrace } from "./review-agent-traces";
import {
  type TraceCommand,
  type TraceScope,
  traceCommandPrefix,
} from "./trace-command";
import { runTraceGitHook } from "./trace-git-hook-runner";
import { runTraceHook } from "./trace-hook-runner";
import { writeHostedTraceStatus } from "./trace-hosted-cli";
import { traceMachineStatus } from "./trace-machine-setup";
import {
  disableTraceRepository,
  enableTraceRepository,
  repairTraceRepository,
  traceRepositoryStatus,
} from "./trace-repository-hooks";
import { TraceProvenanceError } from "./trace-session-provenance";
import {
  describeSelection,
  selectTraceStorage,
  traceStorageExpectation,
} from "./trace-storage/resolve";
import {
  clearTraceSyncFailure,
  describeTraceSyncFailure,
  listTraceSyncFailures,
  recordTraceSyncFailure,
} from "./trace-sync-status";

/**
 * The writer's commands: capture switches, hook installation, and the
 * detached sync. Nothing here reads the Session store.
 */

export { runTraceGitHook, runTraceHook };

export async function runTraceStatus(input: {
  scope: TraceScope;
  cwd: string;
  session?: string;
  cursor?: string;
  limit?: number;
  stdout: Writable;
  stderr: Writable;
}): Promise<number> {
  const machine = await traceMachineStatus(input.scope);
  const repository = await traceRepositoryStatus(input.cwd);
  const selection = selectTraceStorage(input.scope);
  input.stdout.write(
    `Trace capture: ${machine.enabled ? "enabled" : "disabled"}\n`,
  );
  input.stdout.write(`Repository: ${repository.message}\n`);
  input.stdout.write(`Storage: ${describeSelection(selection)}\n`);
  input.stdout.write(
    `Config: ${selection.config.path} (${
      selection.config.source === "absent"
        ? "not present"
        : `version ${selection.config.source === "v1" ? "1, consent only" : "2"}`
    })\n`,
  );

  if (selection.error) {
    input.stderr.write(`trace status: ${selection.error}\n`);

    return 1;
  }

  if (selection.mode === "hosted") {
    return writeHostedTraceStatus({
      scope: input.scope,
      cwd: input.cwd,
      origin: selection.hosted?.origin ?? "",
      stdout: input.stdout,
      session: input.session,
      cursor: input.cursor,
      limit: input.limit,
    });
  }

  if (
    input.session !== undefined ||
    input.cursor !== undefined ||
    input.limit !== undefined
  ) {
    input.stderr.write("Upload status filters require hosted storage.\n");

    return 1;
  }

  const [{ S3TraceStorage }, { describeS3Setup, noTraceConfigurationMessage }] =
    await Promise.all([
      import("./trace-storage/s3"),
      import("./trace-storage/s3-config"),
    ]);

  const setup = describeS3Setup(input.scope.env);
  input.stdout.write(`Checking trace configuration (${setup.envPath})…\n`);

  for (const failure of await listTraceSyncFailures(input.scope.devHome)) {
    input.stdout.write(describeTraceSyncFailure(failure));
  }

  if (!setup.config) {
    input.stderr.write(
      `trace status: ${setup.error ?? noTraceConfigurationMessage()}\n`,
    );

    return 1;
  }

  input.stdout.write(`  Endpoint: ${setup.config.endpoint}\n`);
  input.stdout.write(`  Bucket:   ${setup.config.bucket}\n`);
  input.stdout.write(`  Key:      ${setup.config.accessKeyId.slice(0, 6)}…\n`);

  const readiness = (await S3TraceStorage.fromEnvironment(
    input.scope,
  )?.readiness()) ?? {
    ready: false,
    reason: "unknown error",
  };

  if (readiness.ready) {
    input.stdout.write(
      `✓ S3/R2 bucket "${setup.config.bucket}" is reachable.\n`,
    );

    return 0;
  }

  input.stderr.write(
    `✗ Cannot reach S3/R2 bucket "${setup.config.bucket}": ${readiness.reason ?? "unknown error"}\n`,
  );

  return 1;
}

export async function runTraceEnable(input: {
  scope: TraceScope;
  cwd: string;
  stdout: Writable;
  stderr: Writable;
  /** The command installed in the repository hooks. */
  traceCommand?: TraceCommand;
}): Promise<number> {
  if (!(await traceMachineStatus(input.scope)).enabled) {
    input.stderr.write(
      `trace enable: Trace capture is not enabled. Run \`${traceCommandPrefix()} allow .\`\n`,
    );

    return 1;
  }

  const result = await enableTraceRepository({
    cwd: input.cwd,
    scope: input.scope,
    whiteboardCommand: input.traceCommand,
  });

  (result.enabled ? input.stdout : input.stderr).write(`${result.message}\n`);

  return result.enabled ? 0 : 1;
}

/**
 * Installs the machine parts of trace capture: the harness hooks of every
 * agent, and the CLI itself when the CLI passes an installer. The command
 * touches no repository; `allow` keeps the consent and the Git hooks.
 *
 * The CLI install runs first, because it reports the command file the
 * harness hooks must call.
 */
export async function runTraceInstallMachine(
  input: CliJsonOutput & {
    scope: TraceScope;
    /** False skips the four harness hook installers. */
    harnessHooks?: boolean;
    /** True writes every hook, even for a harness this machine lacks. */
    allHarnesses?: boolean;
    /** The command the harness hooks run; the CLI name when absent. */
    traceCommand?: TraceCommand;
  },
): Promise<number> {
  const output: CliJsonOutput = {
    json: input.json,
    stdout: input.stdout,
    stderr: input.stderr,
  };

  const traceCommand = input.traceCommand;

  const { installed, skipped } = await installHarnessHooks({
    homeDir: input.scope.homeDir,
    env: input.scope.env,
    executable: traceCommand?.file,
    harnessHooks: input.harnessHooks,
    allHarnesses: input.allHarnesses,
  });

  emitJsonEvent(output, { event: "trace.install", hooks: installed, skipped });
  const stream = humanStream(output);

  if (input.harnessHooks === false) {
    stream.write("Harness hooks: skipped.\n");

    return 0;
  }

  for (const hook of installed) {
    stream.write(`Harness hook: ${hook.agent} -> ${hook.path}\n`);
  }

  if (skipped.length > 0) stream.write(skippedHarnessesLine(skipped));

  return 0;
}

export async function runTraceDisable(input: {
  scope: TraceScope;
  cwd: string;
  stdout: Writable;
}): Promise<number> {
  const result = await disableTraceRepository({
    cwd: input.cwd,
    scope: input.scope,
  });

  input.stdout.write(`${result.message}\n`);

  return result.repository ? 0 : 1;
}

export async function runTraceRepair(input: {
  scope: TraceScope;
  cwd: string;
  stdout: Writable;
  stderr: Writable;
  /** The command installed in the repository hooks. */
  traceCommand?: TraceCommand;
}): Promise<number> {
  if (!(await traceMachineStatus(input.scope)).enabled) {
    input.stderr.write(
      `trace repair: Trace capture is not enabled. Run \`${traceCommandPrefix()} allow .\`\n`,
    );

    return 1;
  }

  const result = await repairTraceRepository({
    cwd: input.cwd,
    scope: input.scope,
    whiteboardCommand: input.traceCommand,
  });

  (result.enabled ? input.stdout : input.stderr).write(`${result.message}\n`);

  return result.enabled ? 0 : 1;
}

export async function runTraceSync(input: {
  scope: TraceScope;
  cwd: string;
  sessionId: string;
  repo?: string;
  json?: boolean;
  /**
   * The destination this attempt was started for. A detached sync passes
   * it so a selection change since then stops the attempt instead of
   * publishing to a store the user no longer selected.
   */
  expectStorage?: string;
  stdout: Writable;
  stderr?: Writable;
}): Promise<number> {
  let result: Awaited<ReturnType<typeof syncReviewTrace>>;

  try {
    if (input.expectStorage !== undefined) {
      const current = traceStorageExpectation(input.scope);

      if (current !== input.expectStorage) {
        throw new Error(
          `The trace storage selection changed since this capture started (expected ${input.expectStorage}, now ${current}). Run \`${traceCommandPrefix()} sync ${input.sessionId}\` to publish to the current selection.`,
        );
      }
    }

    result = await syncReviewTrace({
      sessionId: input.sessionId,
      cwd: input.cwd,
      repo: input.repo,
    });
  } catch (error) {
    const message = errorMessage(error);
    // The SessionEnd hook runs this command detached. The record is what
    // the trace status command shows, so the failure is not lost.
    await recordTraceSyncFailure({
      sessionId: input.sessionId.trim(),
      repository: await inferRepoFromGit(input.cwd)
        .then((repo) => `${repo.owner}/${repo.repo}`)
        .catch(() => null),
      error: message,
      reason: error instanceof TraceProvenanceError ? error.reason : undefined,
      devHome: input.scope.devHome,
    }).catch(() => undefined);
    throw error;
  }

  // A successful sync clears its own failure record in every store.
  await clearTraceSyncFailure(
    input.sessionId.trim(),
    input.scope.devHome,
  ).catch(() => undefined);

  if (input.json) {
    input.stdout.write(`${JSON.stringify(result)}\n`);

    return 0;
  }

  for (const upload of result.uploads) {
    input.stdout.write(
      `${upload.blob}  ${upload.bytes_stored} bytes  ${upload.status}\n`,
    );
  }

  if (result.hosted) {
    for (const name of result.hosted.omitted.subagents) {
      input.stdout.write(
        `${name}  omitted (over the object limit or not a store name)\n`,
      );
    }

    if (result.hosted.omitted.commits > 0) {
      input.stdout.write(
        `${result.hosted.omitted.commits} commit link(s) omitted (over the commit limit).\n`,
      );
    }

    input.stdout.write(
      result.hosted.complete
        ? `Published session ${result.session} of ${result.repo} to the trace store (generation ${result.hosted.generation}).\n`
        : `Published part of session ${result.session} of ${result.repo} to the trace store (generation ${result.hosted.generation}).\n`,
    );

    return 0;
  }

  input.stdout.write(
    `Updated meta for session ${result.session} in ${result.repo}.\n`,
  );

  return 0;
}
