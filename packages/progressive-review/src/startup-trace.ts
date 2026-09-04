// CLI profiling instrumentation. Enabled when either variable is set:
//
//   DEV_FAST_REVIEW_TRACE=<file>     write this process's span tree to <file>
//   DEV_FAST_REVIEW_TRACE_DIR=<dir>  write one file per process into <dir>
//
// Otherwise every helper is a zero-cost passthrough. Spans are wall-clock
// intervals (ms since process start, i.e. performance.timeOrigin) with parent
// links propagated through async context, so concurrent work (graph prewarm,
// browser requests, parallel worktree creation) nests correctly. The whole
// span tree is flushed as JSON on process exit.
//
// The directory form exists for the authoring-latency harness: an agent runs
// many `review` commands (some delegated to a second process), and each one
// must land in its own file that the harness can join back to the agent's
// tool call by wall-clock (`timeOrigin`) and `argv`.
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { setLocalVcsCommandObserver } from "@dev.fast/local-vcs";

export interface TraceSpanRecord {
  id: number;
  parentId: number | null;
  name: string;
  detail?: string;
  start: number;
  end: number | null;
  ok?: boolean;
}

export const TRACE_FILE_ENV = "DEV_FAST_REVIEW_TRACE";
export const TRACE_DIR_ENV = "DEV_FAST_REVIEW_TRACE_DIR";

const traceFile = resolveTraceFile(process.env);
export const traceEnabled = Boolean(traceFile);

const spans: TraceSpanRecord[] = [];
const attributes: Record<string, string | number | boolean> = {};
let nextId = 1;
const context = new AsyncLocalStorage<number>();

export interface SpanHandle {
  id: number;
  end: (detail?: string) => void;
  fail: (detail?: string) => void;
}

const NOOP_HANDLE: SpanHandle = { id: 0, end: () => {}, fail: () => {} };

// Manual span: caller owns the lifetime and (optionally) the parent. Used for
// spans whose start/end don't wrap a single function call (HTTP requests,
// "waiting for submission").
export function startSpan(
  name: string,
  options: { parentId?: number | null; detail?: string } = {},
): SpanHandle {
  if (!traceEnabled) return NOOP_HANDLE;
  const record: TraceSpanRecord = {
    id: nextId++,
    parentId:
      options.parentId !== undefined
        ? options.parentId
        : (context.getStore() ?? null),
    name,
    detail: options.detail,
    start: performance.now(),
    end: null,
  };
  spans.push(record);
  return {
    id: record.id,
    end: (detail) => {
      if (record.end === null) record.end = performance.now();
      if (detail) record.detail = detail;
    },
    fail: (detail) => {
      if (record.end === null) record.end = performance.now();
      record.ok = false;
      if (detail) record.detail = detail;
    },
  };
}

// Wrap an async (or sync) call; children created inside inherit this span as
// their parent via AsyncLocalStorage. A thrown error marks the span failed.
export async function span<T>(
  name: string,
  fn: () => Promise<T> | T,
  detail?: string,
): Promise<T> {
  if (!traceEnabled) return fn();
  const handle = startSpan(name, { detail });
  try {
    const result = await context.run(handle.id, fn);
    handle.end();
    return result;
  } catch (error) {
    handle.fail(errorDetail(error));
    throw error;
  }
}

export function spanSync<T>(name: string, fn: () => T, detail?: string): T {
  if (!traceEnabled) return fn();
  const handle = startSpan(name, { detail });
  try {
    const result = context.run(handle.id, fn);
    handle.end();
    return result;
  } catch (error) {
    handle.fail(errorDetail(error));
    throw error;
  }
}

// Subprocess span. Name is `$ <cmd>` truncated; detail carries the full
// command line and cwd so the harness can group by executable and verb.
export function traceCommand<T>(
  file: string,
  args: string[],
  fn: () => Promise<T>,
  options: { cwd?: string } = {},
): Promise<T> {
  return span(
    commandSpanName(file, args),
    fn,
    commandDetail(file, args, options.cwd),
  );
}

export function traceCommandSync<T>(
  file: string,
  args: string[],
  fn: () => T,
  options: { cwd?: string } = {},
): T {
  return spanSync(
    commandSpanName(file, args),
    fn,
    commandDetail(file, args, options.cwd),
  );
}

// Record an interval measured elsewhere (another process reporting its own
// phase timings, e.g. Review Desktop's mount steps) as a child span.
export function recordSpan(
  name: string,
  interval: { startEpochMs: number; endEpochMs: number },
  options: { parentId?: number | null; detail?: string } = {},
): void {
  if (!traceEnabled) return;
  spans.push({
    id: nextId++,
    parentId:
      options.parentId !== undefined
        ? options.parentId
        : (context.getStore() ?? null),
    name,
    detail: options.detail,
    start: interval.startEpochMs - performance.timeOrigin,
    end: interval.endEpochMs - performance.timeOrigin,
  });
}

// Zero-duration marker (e.g. "browser websocket connected").
export function traceEvent(
  name: string,
  options: { parentId?: number | null; detail?: string } = {},
): void {
  startSpan(name, options).end();
}

// Process-wide attributes (command path, command run id, review uuid) that
// the harness uses to join this trace to telemetry and to the agent's tool
// call.
export function setTraceAttribute(
  key: string,
  value: string | number | boolean,
): void {
  if (!traceEnabled) return;
  attributes[key] = value;
}

export function flushTrace(): void {
  if (!traceEnabled || !traceFile) return;
  const now = performance.now();
  try {
    mkdirSync(path.dirname(traceFile), { recursive: true });
    writeFileSync(
      traceFile,
      `${JSON.stringify({
        timeOrigin: performance.timeOrigin,
        pid: process.pid,
        ppid: process.ppid,
        argv: process.argv,
        cwd: process.cwd(),
        delegated: Boolean(process.env.DEV_FAST_REVIEW_CLI_DELEGATED),
        attributes,
        durationMs: now,
        spans: spans.map((record) => ({
          ...record,
          end: record.end ?? now,
          openAtExit: record.end === null || undefined,
        })),
      })}\n`,
      "utf8",
    );
  } catch {
    // Profiling must never break the CLI.
  }
}

function commandSpanName(file: string, args: string[]): string {
  return `$ ${[path.basename(file), ...args].join(" ").slice(0, 100)}`;
}

function commandDetail(
  file: string,
  args: string[],
  cwd: string | undefined,
): string {
  const line = [file, ...args].join(" ");
  return cwd ? `${line}\n(cwd ${cwd})` : line;
}

function errorDetail(error: unknown): string {
  return error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error);
}

function resolveTraceFile(env: NodeJS.ProcessEnv): string | undefined {
  const file = env[TRACE_FILE_ENV]?.trim();
  if (file) return file;
  const dir = env[TRACE_DIR_ENV]?.trim();
  if (!dir) return undefined;
  const argvSlug = process.argv
    .slice(2)
    .filter((arg) => !arg.startsWith("-"))
    .slice(0, 3)
    .join("-")
    .replace(/[^A-Za-z0-9_.-]+/g, "_")
    .slice(0, 60);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(
    dir,
    `${stamp}-${process.pid}${argvSlug ? `-${argvSlug}` : ""}.json`,
  );
}

if (traceEnabled) {
  process.on("exit", flushTrace);
  // Every git/jj spawn inside @dev.fast/local-vcs becomes a `$ …` span under
  // whatever span is active in the caller's async context.
  setLocalVcsCommandObserver({
    start({ file, args, cwd }) {
      const handle = startSpan(commandSpanName(file, args), {
        detail: commandDetail(file, args, cwd),
      });
      return ({ ok }) => (ok ? handle.end() : handle.fail());
    },
  });
}
