import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";

import {
  STRUCTURAL_DIFF_WIRE_VERSION,
  type StructuralDiffEvent,
  type StructuralProblem,
  decodeStructuralDiffEvent,
} from "@dev.fast/review-protocol";

export type DiffComparison =
  | { kind: "trees"; base: string; head: string }
  | { kind: "merge-base"; base: string; head: string };

export interface StructuralDiffRequest {
  repositoryPath: string;
  comparison: DiffComparison;
  paths?: readonly string[];
  signal: AbortSignal;
}

export function diffrExecutable(): string {
  return process.env.REVIEW_DIFFR_BINARY || "diffr";
}

export function bundledDiffrBinary(packageRoot: string): string {
  return path.join(packageRoot, "bin", "diffr");
}

export function applyBundledDiffrBinary(
  packageRoot: string,
  env: NodeJS.ProcessEnv,
): void {
  if (env.REVIEW_DIFFR_BINARY) return;
  const bundled = bundledDiffrBinary(packageRoot);

  if (existsSync(bundled)) env.REVIEW_DIFFR_BINARY = bundled;
}

export function diffrMissingError(): Error {
  return new Error(
    `Cannot find diffr at ${diffrExecutable()}. Review Desktop bundles it at bin/diffr under its runtime; in a checkout, run \`pnpm --filter @dev.fast/review ensure:diffr\` or set REVIEW_DIFFR_BINARY, then restart Review.`,
  );
}

/**
 * Stream validated diffr records. File errors and aborted completion are data;
 * launch failures, malformed/truncated streams and unexpected exits throw.
 * Closing the iterator (including a consumer's break) terminates the child.
 */
export async function* structuralDiff(
  input: StructuralDiffRequest,
): AsyncGenerator<StructuralDiffEvent> {
  input.signal.throwIfAborted();
  const { base, head, kind } = input.comparison;

  const args = [
    "--repo",
    input.repositoryPath,
    "--format",
    "ndjson",
    "--stream-annotations",
  ];

  args.push(...(kind === "trees" ? [base, head] : [`${base}...${head}`]));
  args.push("--", ...(input.paths ?? []));

  const signal = AbortSignal.any([AbortSignal.timeout(120_000), input.signal]);

  // The host inherits its own environment and runs from the repository, so
  // diffr reads the user's config and keys exactly as it would from a shell.
  console.info(
    `[Review] structural diff: ${diffrExecutable()} ${args.join(" ")}`,
  );

  const child = spawn(diffrExecutable(), args, {
    cwd: input.repositoryPath,
    stdio: ["ignore", "pipe", "pipe"],
    signal,
  });

  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-16_384);
  });

  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("error", (error: NodeJS.ErrnoException) => {
      reject(error.code === "ENOENT" ? diffrMissingError() : error);
    });
    child.once("close", (code) => resolve(code));
  });

  const exitError = (code: number | null) =>
    new Error(`diffr exited with ${code}: ${stderr}`);

  // Observe process errors immediately, including before stdout closes.
  void exited.catch(() => {});
  let bytes = 0;
  let started = false;
  let completed = false;
  let aborted: StructuralProblem | undefined;
  let failed = 0;
  let annotationFailed = false;
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });

  try {
    for await (const line of lines) {
      bytes += Buffer.byteLength(line);

      if (bytes > 64 * 1024 * 1024)
        throw new Error("Structural diff exceeded 64 MiB.");

      if (!line.trim()) continue;
      const event = decodeStructuralDiffEvent(line);

      if (completed) throw new Error("diffr emitted data after completion.");

      if (!started) {
        if (
          event.type !== "start" ||
          event.version !== STRUCTURAL_DIFF_WIRE_VERSION
        ) {
          throw new Error("Unsupported diffr stream protocol.");
        }

        started = true;
      } else if (event.type === "complete") {
        completed = true;

        failed = event.failed;
        aborted = event.aborted;
      } else if (event.type === "annotations") {
        annotationFailed ||= event.error !== undefined;
      } else if (event.type !== "file") {
        throw new Error(`Unexpected diffr event: ${event.type}`);
      }

      yield event;
    }

    if (!completed) {
      const code = await exited;

      if (code !== 0) throw exitError(code);
      throw new Error("diffr stream ended before completion.");
    }

    // diffr exits 2 for file or enrichment failures already reported by the stream.
    const code = await exited;

    if (
      code !== 0 &&
      !(code === 2 && (failed > 0 || annotationFailed || aborted !== undefined))
    )
      throw exitError(code);
  } finally {
    lines.close();

    if (child.exitCode === null) child.kill();
    await exited.catch(() => {});
  }
}
