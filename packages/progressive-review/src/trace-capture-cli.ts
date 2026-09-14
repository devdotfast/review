import type { Writable } from "node:stream";

import { inferRepoFromGit, syncReviewTrace } from "./review-agent-traces";
import { runReviewTraceGitHook } from "./trace-git-hook-runner";
import { runReviewTraceHook } from "./trace-hook-runner";
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
 * detached sync. Nothing here reads the Review store.
 */

export { runReviewTraceGitHook, runReviewTraceHook };

export async function runReviewTraceStatus(input: {
  cwd: string;
  session?: string;
  cursor?: string;
  limit?: number;
  stdout: Writable;
  stderr: Writable;
}): Promise<number> {
  const machine = await traceMachineStatus();
  const repository = await traceRepositoryStatus(input.cwd);
  const selection = selectTraceStorage();
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

  const { checkReviewTraceDoctor } = await import("./trace-doctor");
  const doctor = await checkReviewTraceDoctor({ cwd: input.cwd });
  input.stdout.write(`Checking trace configuration (${doctor.envPath})…\n`);

  for (const failure of await listTraceSyncFailures()) {
    input.stdout.write(describeTraceSyncFailure(failure));
  }

  if (!doctor.ok && !doctor.config) {
    input.stderr.write(
      `trace status: ${doctor.error ?? "No trace configuration found. Use Review Agent Setup to configure trace capture."}\n`,
    );

    return 1;
  }

  if (doctor.config) {
    input.stdout.write(`  Endpoint: ${doctor.config.endpoint}\n`);
    input.stdout.write(`  Bucket:   ${doctor.config.bucket}\n`);
    input.stdout.write(
      `  Key:      ${doctor.config.accessKeyId.slice(0, 6)}…\n`,
    );
  }

  if (doctor.reachable && doctor.config) {
    input.stdout.write(
      `✓ S3/R2 bucket "${doctor.config.bucket}" is reachable.\n`,
    );

    return 0;
  }

  if (doctor.config) {
    input.stderr.write(
      `✗ Cannot reach S3/R2 bucket "${doctor.config.bucket}": ${doctor.error ?? "unknown error"}\n`,
    );
  }

  return 1;
}

export async function runReviewTraceEnable(input: {
  cwd: string;
  stdout: Writable;
  stderr: Writable;
}): Promise<number> {
  if (!(await traceMachineStatus()).enabled) {
    input.stderr.write(
      "trace enable: Trace capture is not enabled. Use Review Agent Setup first.\n",
    );

    return 1;
  }

  const result = await enableTraceRepository({ cwd: input.cwd });
  (result.enabled ? input.stdout : input.stderr).write(`${result.message}\n`);

  return result.enabled ? 0 : 1;
}

export async function runReviewTraceDisable(input: {
  cwd: string;
  stdout: Writable;
}): Promise<number> {
  const result = await disableTraceRepository({ cwd: input.cwd });
  input.stdout.write(`${result.message}\n`);

  return result.repository ? 0 : 1;
}

export async function runReviewTraceRepair(input: {
  cwd: string;
  stdout: Writable;
  stderr: Writable;
}): Promise<number> {
  if (!(await traceMachineStatus()).enabled) {
    input.stderr.write(
      "trace repair: Trace capture is not enabled. Use Review Agent Setup first.\n",
    );

    return 1;
  }

  const result = await repairTraceRepository({ cwd: input.cwd });
  (result.enabled ? input.stdout : input.stderr).write(`${result.message}\n`);

  return result.enabled ? 0 : 1;
}

export const runReviewTraceDoctor = runReviewTraceStatus;

export async function runReviewTraceSync(input: {
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
      const current = traceStorageExpectation();

      if (current !== input.expectStorage) {
        throw new Error(
          `The trace storage selection changed since this capture started (expected ${input.expectStorage}, now ${current}). Run \`review trace sync ${input.sessionId}\` to publish to the current selection.`,
        );
      }
    }

    result = await syncReviewTrace({
      sessionId: input.sessionId,
      cwd: input.cwd,
      repo: input.repo,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // The SessionEnd hook runs this command detached. The record is what
    // `review trace status` shows, so the failure is not lost.
    await recordTraceSyncFailure({
      sessionId: input.sessionId.trim(),
      repository: await inferRepoFromGit(input.cwd)
        .then((repo) => `${repo.owner}/${repo.repo}`)
        .catch(() => null),
      error: message,
      reason: error instanceof TraceProvenanceError ? error.reason : undefined,
    }).catch(() => undefined);
    throw error;
  }

  // A successful sync clears its own failure record in every store.
  await clearTraceSyncFailure(input.sessionId.trim()).catch(() => undefined);

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
