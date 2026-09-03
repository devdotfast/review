// One JSON contract for every `review` command.
//
// Without --json a command writes its report to stdout. With --json stdout
// carries only JSON events, one per line, and the human report moves to
// stderr, so a caller can parse stdout without stripping prose out of it.

import { type Readable, Writable } from "node:stream";

/** Standard input for a command: `process.stdin`, or any Readable in tests. */
export interface CliInputStream extends Readable {
  readonly isTTY?: boolean;
}

/** A Writable that appends every chunk to `chunks`, for captured CLI output. */
export function collectingWritable(chunks: string[]): Writable {
  return new Writable({
    decodeStrings: false,
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    },
  });
}

export interface CliJsonOutput {
  json?: boolean;
  stdout: Writable;
  stderr: Writable;
}

/** The stream a human report belongs on. */
export function humanStream(output: CliJsonOutput): Writable {
  return output.json ? output.stderr : output.stdout;
}

/** Every JSON event names itself; commands add their own fields. */
export interface CliJsonEvent {
  event: string;
}

/** Writes one event line, and only under --json. */
export function emitJsonEvent<T extends CliJsonEvent>(
  output: CliJsonOutput,
  event: T,
): void {
  if (output.json) output.stdout.write(`${JSON.stringify(event)}\n`);
}

/**
 * Reports a failure on both channels and returns the exit code.
 *
 * The human message always reaches stderr. Under --json the same message also
 * reaches stdout as a parseable error event, so an agent never has to read
 * prose to learn why a command failed.
 */
export function failWithJsonError(
  output: CliJsonOutput,
  stage: string,
  message: string,
): number {
  output.stderr.write(`${message}\n`);
  emitJsonEvent(output, { event: "error", stage, message });
  return 1;
}

// Flags that take a separate value. A value can look exactly like a flag, as in
// `threads reply t1 --body "--json"`, so the scan must skip it.
const VALUE_FLAGS = new Set([
  "--author",
  "--base",
  "--body",
  "--head",
  "--origin",
  "--pr",
  "--review",
  "--target",
  "--thread-id",
  "--timeout",
]);

/**
 * Report whether the caller asked for JSON, by reading raw argv.
 *
 * A usage error happens during parsing, before commander resolves any option,
 * so the error path cannot read the parsed value. Actions read the parsed
 * option instead; this scan only has to answer for failures.
 */
export function jsonRequestedInArgv(argv: readonly string[]): boolean {
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === "--") return false;
    if (VALUE_FLAGS.has(token)) {
      index += 1;
      continue;
    }
    if (token === "--json" || token === "--json=true") return true;
  }
  return false;
}
