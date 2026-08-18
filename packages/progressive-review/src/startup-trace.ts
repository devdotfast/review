// Temporary startup profiling instrumentation. Enabled only when
// DEV_FAST_REVIEW_TRACE is set to a file path; otherwise every helper is a
// zero-cost passthrough. Spans are wall-clock intervals (ms since process
// start, i.e. performance.timeOrigin) with parent links propagated through
// async context, so concurrent work (graph prewarm, browser requests) nests
// correctly. The whole span tree is flushed as JSON on process exit.
import { AsyncLocalStorage } from "node:async_hooks";
import { writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

export interface TraceSpanRecord {
  id: number;
  parentId: number | null;
  name: string;
  detail?: string;
  start: number;
  end: number | null;
}

const traceFile = process.env.DEV_FAST_REVIEW_TRACE;
export const traceEnabled = Boolean(traceFile);

const spans: TraceSpanRecord[] = [];
let nextId = 1;
const context = new AsyncLocalStorage<number>();

export interface SpanHandle {
  id: number;
  end: (detail?: string) => void;
}

const NOOP_HANDLE: SpanHandle = { id: 0, end: () => {} };

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
  };
}

// Wrap an async (or sync) call; children created inside inherit this span as
// their parent via AsyncLocalStorage.
export async function span<T>(
  name: string,
  fn: () => Promise<T> | T,
  detail?: string,
): Promise<T> {
  if (!traceEnabled) return fn();
  const handle = startSpan(name, { detail });
  try {
    return await context.run(handle.id, fn);
  } finally {
    handle.end();
  }
}

export function spanSync<T>(name: string, fn: () => T, detail?: string): T {
  if (!traceEnabled) return fn();
  const handle = startSpan(name, { detail });
  try {
    return context.run(handle.id, fn);
  } finally {
    handle.end();
  }
}

// Zero-duration marker (e.g. "browser websocket connected").
export function traceEvent(
  name: string,
  options: { parentId?: number | null; detail?: string } = {},
): void {
  startSpan(name, options).end();
}

export function flushTrace(): void {
  if (!traceEnabled || !traceFile) return;
  const now = performance.now();
  try {
    writeFileSync(
      traceFile,
      `${JSON.stringify({
        timeOrigin: performance.timeOrigin,
        pid: process.pid,
        argv: process.argv,
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

if (traceEnabled) {
  process.on("exit", flushTrace);
}
