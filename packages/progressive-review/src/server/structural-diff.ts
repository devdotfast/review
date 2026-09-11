import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

import {
  type JsonObject,
  type JsonValue,
  isJsonObject,
  isStringValue,
  parseJsonText,
} from "@dev.fast/review-protocol";

/** The diffr wire version this host reads. Changes within it are additive. */
export const STRUCTURAL_DIFF_WIRE_VERSION = 2;

/** The one error shape diffr uses for file failures, aborts and fallbacks. */
export interface StructuralProblem {
  code: string;
  message: string;
}

export function structuralProblem(
  value: JsonValue | undefined,
): StructuralProblem {
  if (
    !isJsonObject(value) ||
    !isStringValue(value.code) ||
    !isStringValue(value.message)
  ) {
    throw new Error("diffr sent a malformed error record.");
  }
  return { code: value.code, message: value.message };
}

export function diffrExecutable(): string {
  return process.env.REVIEW_DIFFR_BINARY || "diffr";
}

export function diffrMissingError(): Error {
  return new Error(
    "Cannot find diffr. Install it on the Review host PATH or set REVIEW_DIFFR_BINARY to its executable, then restart Review.",
  );
}

/**
 * Runs one diffr comparison and reads its v2 NDJSON stream: a `start`
 * header, one `file` record per changed file in completion order, and a
 * `complete` footer. The frontend setting opts in; the host selects the
 * executable, never the request.
 *
 * With `onEvent`, records are forwarded as they arrive, including per-file
 * errors and a `complete` that carries `aborted`. Without it, records are
 * collected and any per-file error or abort rejects the whole comparison.
 */
export async function structuralDiff(input: {
  rootPath: string;
  baseRef?: string;
  headRef?: string;
  paths?: readonly string[];
  signal?: AbortSignal;
  onEvent?: (event: JsonObject) => void;
}): Promise<{ enabled: boolean; events: JsonObject[] }> {
  if (!input.baseRef)
    throw new Error("Structural review requires a base revision.");
  const args = ["--repo", input.rootPath, "--format", "ndjson"];
  // Match Review's merge-base-to-head comparison, including commit scopes.
  args.push(
    input.headRef ? `${input.baseRef}...${input.headRef}` : input.baseRef,
  );
  args.push("--", ...(input.paths ?? []));
  const signal = AbortSignal.any([
    AbortSignal.timeout(120_000),
    ...(input.signal ? [input.signal] : []),
  ]);
  // The host inherits its own environment and runs from the repository, so
  // diffr reads the user's config and keys exactly as it would from a shell.
  console.info(
    `[Review] structural diff: ${diffrExecutable()} ${args.join(" ")}`,
  );
  const child = spawn(diffrExecutable(), args, {
    cwd: input.rootPath,
    stdio: ["ignore", "pipe", "pipe"],
    signal,
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-16_384);
  });
  const exited = new Promise<void>((resolve, reject) => {
    child.once("error", (error: NodeJS.ErrnoException) => {
      reject(error.code === "ENOENT" ? diffrMissingError() : error);
    });
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`diffr exited with ${code}: ${stderr}`));
    });
  });
  // Observe process errors immediately, including before stdout closes.
  void exited.catch(() => {});
  const events: JsonObject[] = [];
  let bytes = 0;
  let started = false;
  let completed = false;
  let aborted: StructuralProblem | undefined;
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      bytes += Buffer.byteLength(line);
      if (bytes > 64 * 1024 * 1024)
        throw new Error("Structural diff exceeded 64 MiB.");
      if (!line.trim()) continue;
      const event = parseJsonText(line);
      if (!isJsonObject(event) || !isStringValue(event.type))
        throw new Error("diffr sent a record without a type.");
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
        if (event.aborted !== undefined)
          aborted = structuralProblem(event.aborted);
      } else if (event.type === "file") {
        if (event.error !== undefined && !input.onEvent) {
          throw new Error(`diffr: ${structuralProblem(event.error).message}`);
        }
      } else {
        throw new Error(`Unexpected diffr event: ${event.type}`);
      }
      if (input.onEvent) input.onEvent(event);
      else events.push(event);
    }
    if (!completed) {
      await exited;
      throw new Error("diffr stream ended before completion.");
    }
    if (aborted) {
      // Files already emitted stay valid; the run itself failed.
      if (!input.onEvent) throw new Error(`diffr aborted: ${aborted.message}`);
      return { enabled: true, events };
    }
    await exited;
    return { enabled: true, events };
  } finally {
    lines.close();
    if (child.exitCode === null) child.kill();
    await exited.catch(() => {});
  }
}
