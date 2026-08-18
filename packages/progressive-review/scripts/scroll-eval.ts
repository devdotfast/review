#!/usr/bin/env tsx

import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

type CdpTarget = {
  id: string;
  title: string;
  type: string;
  url: string;
  webSocketDebuggerUrl?: string;
};

type CdpEvent = {
  method: string;
  params?: Record<string, unknown>;
};

type CdpResponse = {
  id: number;
  result?: Record<string, unknown>;
  error?: { message?: string; code?: number; data?: unknown };
};

type Stats = {
  n: number;
  min: number | null;
  p50: number | null;
  p75: number | null;
  p90: number | null;
  p95: number | null;
  p99: number | null;
  max: number | null;
  mean: number | null;
};

type CliOptions = {
  target: "diffshub" | "local" | "url";
  url: string;
  outDir: string;
  durationMs: number;
  chromePort: number;
  cadenceMs: number;
  keepFrames: boolean;
  noTrace: boolean;
  noVideo: boolean;
};

const DEFAULT_DIFFSHUB_URL =
  "https://diffshub.com/torvalds/linux/compare/v6.0...v7.0";
const DEFAULT_LOCAL_URL = "http://localhost:5630/?view=files";

const THRESHOLDS = {
  frameGapP95Ms: 16.7,
  frameGapP99Ms: 33,
  screenshotGapP95Ms: 33,
  longTaskMaxMs: 100,
  longTaskP95Ms: 50,
  minViewportsPerSecond: 8,
  longTaskWarmupMs: 1_000,
};

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    target: "local",
    url: DEFAULT_LOCAL_URL,
    outDir: "/tmp/devfast-scroll-eval/local",
    durationMs: 10_000,
    chromePort: 9222,
    cadenceMs: 8.3,
    keepFrames: false,
    noTrace: false,
    noVideo: false,
  };

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--") continue;
    const readValue = () => {
      const value = argv[++index];
      if (!value) throw new Error(`Missing value for ${arg}`);
      return value;
    };

    if (arg === "--target") {
      const target = readValue();
      if (target !== "diffshub" && target !== "local" && target !== "url") {
        throw new Error(`Unsupported --target ${target}`);
      }
      opts.target = target;
      if (target === "diffshub") {
        opts.url = DEFAULT_DIFFSHUB_URL;
        opts.outDir = "/tmp/devfast-scroll-eval/diffshub";
      } else if (target === "local") {
        opts.url = DEFAULT_LOCAL_URL;
        opts.outDir = "/tmp/devfast-scroll-eval/local";
      }
    } else if (arg === "--url") {
      opts.url = readValue();
      if (opts.target !== "diffshub" && opts.target !== "local") {
        opts.target = "url";
      }
    } else if (arg === "--out") {
      opts.outDir = readValue();
    } else if (arg === "--duration-ms") {
      opts.durationMs = Number(readValue());
    } else if (arg === "--cadence-ms") {
      opts.cadenceMs = Number(readValue());
    } else if (arg === "--chrome-port") {
      opts.chromePort = Number(readValue());
    } else if (arg === "--keep-frames") {
      opts.keepFrames = true;
    } else if (arg === "--no-trace") {
      opts.noTrace = true;
    } else if (arg === "--no-video") {
      opts.noVideo = true;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument ${arg}`);
    }
  }

  if (!Number.isFinite(opts.durationMs) || opts.durationMs <= 0) {
    throw new Error("--duration-ms must be a positive number");
  }
  if (!Number.isFinite(opts.cadenceMs) || opts.cadenceMs <= 0) {
    throw new Error("--cadence-ms must be a positive number");
  }
  if (!Number.isFinite(opts.chromePort) || opts.chromePort <= 0) {
    throw new Error("--chrome-port must be a positive number");
  }

  return opts;
}

function printHelp() {
  console.log(`Usage:
  pnpm --filter @dev.fast/progressive-review run eval:scroll -- --target diffshub --out /tmp/devfast-scroll-eval/diffshub
  pnpm --filter @dev.fast/progressive-review run eval:scroll -- --target local --url http://localhost:5630/?view=files --out /tmp/devfast-scroll-eval/local

Options:
  --target diffshub|local|url   Target preset. Defaults to local.
  --url <url>                   URL to open or claim in Chrome.
  --out <dir>                   Output directory.
  --duration-ms <ms>            Active wheel duration. Defaults to 10000.
  --cadence-ms <ms>             Wheel cadence. Defaults to 8.3.
  --chrome-port <port>          Chrome remote debugging port. Defaults to 9222.
  --keep-frames                 Keep raw screencast frames after MP4 encoding.
  --no-trace                    Skip Chrome tracing.
  --no-video                    Skip screencast/MP4 output.`);
}

function quantile(values: number[], percentile: number): number | null {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  return sorted[Math.floor((sorted.length - 1) * percentile)] ?? null;
}

function stats(values: number[]): Stats {
  const finite = values.filter(Number.isFinite).sort((a, b) => a - b);
  return {
    n: finite.length,
    min: finite[0] ?? null,
    p50: quantile(finite, 0.5),
    p75: quantile(finite, 0.75),
    p90: quantile(finite, 0.9),
    p95: quantile(finite, 0.95),
    p99: quantile(finite, 0.99),
    max: finite.at(-1) ?? null,
    mean:
      finite.length === 0
        ? null
        : finite.reduce((sum, value) => sum + value, 0) / finite.length,
  };
}

function timestampGapsMs(timestamps: number[]) {
  return timestamps.map((timestamp, index) =>
    index === 0
      ? NaN
      : (timestamp - (timestamps[index - 1] ?? timestamp)) / 1000,
  );
}

function syntheticWheelDelta(index: number): number {
  const phase = index % 100;
  if (phase >= 99) return 330;
  if (phase >= 95) return 190;
  if (phase >= 88) return 145;
  if (phase < 8) return 30 + phase * 8;
  return 86 + Math.round(23 * Math.sin(index * 0.31));
}

class CdpClient {
  private nextId = 0;
  private readonly pending = new Map<
    number,
    {
      resolve: (value: Record<string, unknown>) => void;
      reject: (reason: Error) => void;
    }
  >();
  readonly events: CdpEvent[] = [];
  private readonly socket: WebSocket;

  constructor(url: string) {
    this.socket = new WebSocket(url);
    this.socket.addEventListener("message", (event) => {
      const raw = typeof event.data === "string" ? event.data : "";
      if (!raw) return;
      const message = JSON.parse(raw) as CdpEvent | CdpResponse;
      if ("id" in message) {
        const waiter = this.pending.get(message.id);
        if (!waiter) return;
        this.pending.delete(message.id);
        if (message.error) {
          waiter.reject(
            new Error(
              message.error.message ??
                `CDP command failed (${message.error.code})`,
            ),
          );
        } else {
          waiter.resolve(message.result ?? {});
        }
      } else {
        this.events.push(message);
      }
    });
  }

  async open() {
    if (this.socket.readyState === WebSocket.OPEN) return;
    await new Promise<void>((resolve, reject) => {
      this.socket.addEventListener("open", () => resolve(), { once: true });
      this.socket.addEventListener(
        "error",
        () => reject(new Error("Failed to connect to Chrome CDP WebSocket")),
        { once: true },
      );
    });
  }

  send(method: string, params: Record<string, Json> = {}) {
    const id = ++this.nextId;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  fire(method: string, params: Record<string, Json> = {}) {
    const id = ++this.nextId;
    this.socket.send(JSON.stringify({ id, method, params }));
  }

  waitForEvent(method: string, afterIndex: number, timeoutMs?: number) {
    return new Promise<CdpEvent | null>((resolve) => {
      const startedAt = Date.now();
      const poll = () => {
        const event = this.events
          .slice(afterIndex)
          .find((candidate) => candidate.method === method);
        if (event) resolve(event);
        else if (
          timeoutMs !== undefined &&
          Date.now() - startedAt >= timeoutMs
        ) {
          resolve(null);
        } else setTimeout(poll, 25);
      };
      poll();
    });
  }

  close() {
    this.socket.close();
  }
}

async function fetchTargets(port: number): Promise<CdpTarget[]> {
  const response = await fetch(`http://localhost:${port}/json/list`);
  if (!response.ok) {
    throw new Error(
      `Could not reach Chrome CDP on localhost:${port}. Start Chrome with --remote-debugging-port=${port}.`,
    );
  }
  return (await response.json()) as CdpTarget[];
}

async function openOrFindTarget(opts: CliOptions): Promise<CdpTarget> {
  const targets = await fetchTargets(opts.chromePort);
  const existing = targets.find(
    (target) =>
      target.type === "page" &&
      target.url.replace(/\/$/, "") === opts.url.replace(/\/$/, ""),
  );
  if (existing?.webSocketDebuggerUrl) return existing;

  const response = await fetch(
    `http://localhost:${opts.chromePort}/json/new?${encodeURIComponent(
      opts.url,
    )}`,
    { method: "PUT" },
  );
  if (!response.ok) {
    throw new Error(`Chrome could not open ${opts.url}: ${response.status}`);
  }
  const target = (await response.json()) as CdpTarget;
  if (!target.webSocketDebuggerUrl) {
    throw new Error(
      `Chrome target for ${opts.url} did not expose a CDP socket`,
    );
  }
  return target;
}

async function evaluate<T extends Json>(client: CdpClient, expression: string) {
  const result = await client.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  const payload = result.result as
    | { value?: T; exceptionDetails?: unknown }
    | undefined;
  if (!payload || payload.exceptionDetails) {
    throw new Error(`Evaluation failed: ${JSON.stringify(payload)}`);
  }
  return payload.value as T;
}

async function readTraceStream(client: CdpClient, stream: string) {
  let trace = "";
  for (;;) {
    const chunk = await client.send("IO.read", { handle: stream });
    trace += (chunk.data as string | undefined) ?? "";
    if (chunk.eof) break;
  }
  await client.send("IO.close", { handle: stream });
  return trace;
}

function runCommand(command: string, args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with code ${code}`));
    });
  });
}

async function encodeMp4(framesDir: string, mp4Path: string) {
  await runCommand("ffmpeg", [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-framerate",
    "30",
    "-pattern_type",
    "glob",
    "-i",
    path.join(framesDir, "frame-*.jpg"),
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    mp4Path,
  ]);
}

function buildPageProbeScript(target: string) {
  return `(async () => {
    const q = (xs, p) => {
      xs = xs.filter(Number.isFinite).sort((a, b) => a - b);
      return xs.length ? xs[Math.floor((xs.length - 1) * p)] : null;
    };
    const stat = (xs) => {
      xs = xs.filter(Number.isFinite).sort((a, b) => a - b);
      return {
        n: xs.length,
        min: xs[0] ?? null,
        p50: q(xs, 0.5),
        p75: q(xs, 0.75),
        p90: q(xs, 0.9),
        p95: q(xs, 0.95),
        p99: q(xs, 0.99),
        max: xs.at(-1) ?? null,
        mean: xs.length ? xs.reduce((sum, value) => sum + value, 0) / xs.length : null,
      };
    };
    const isElement = (node) => node && node.nodeType === 1;
    const isScrollable = (el) => {
      if (!isElement(el)) return false;
      const style = getComputedStyle(el);
      return /(auto|scroll|overlay)/.test(style.overflowY) && el.scrollHeight > el.clientHeight + 8;
    };
    const hasVisibleText = (el) => {
      const text = (el.innerText || el.textContent || "").trim();
      return text.length > 0;
    };
    const findScroller = () => {
      const candidates = [...document.querySelectorAll("*")]
        .filter(isScrollable)
        .map((el) => {
          const rect = el.getBoundingClientRect();
          const area = Math.max(0, rect.width) * Math.max(0, rect.height);
          const scrollable = el.scrollHeight - el.clientHeight;
          const className = String(el.className || "");
          let score = scrollable + area / 1000;
          if (rect.width < 100 || rect.height < 100) score -= 1_000_000;
          if (className.includes("cv-scrollbar")) score += 1_000_000;
          if (className.includes("overflow-y-auto")) score += 100_000;
          if (className.includes("files")) score += 20_000;
          if (el.tagName === "SECTION") score += 10_000;
          if (!hasVisibleText(el)) score -= 50_000;
          return { el, score, scrollable, rect };
        })
        .filter((candidate) => candidate.scrollable > 1000 && candidate.rect.height >= 100)
        .sort((a, b) => b.score - a.score);
      return candidates[0]?.el || null;
    };
    const deadline = performance.now() + 10_000;
    let scroller = findScroller();
    while (!scroller && performance.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      scroller = findScroller();
    }
    scroller ||= document.scrollingElement;
    if (!scroller) return { ok: false, message: "No scroll container found" };
    scroller.scrollTop = 0;
    const rect = scroller.getBoundingClientRect();
    const state = window.__devFastScrollEval = {
      target: ${JSON.stringify(target)},
      startedAt: performance.now(),
      scroller,
      rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
      samples: [],
      scrolls: [],
      wheels: [],
      longTasks: [],
      lastRaf: performance.now(),
      lastScrollTop: scroller.scrollTop,
      raf: 0,
      observer: null,
      summarize() {
        const wheelGaps = this.wheels.map((wheel, index, all) => index ? wheel.t - all[index - 1].t : NaN);
        const scrollGaps = this.scrolls.map((scroll, index, all) => index ? scroll.t - all[index - 1].t : NaN);
        const firstWheelAt = this.wheels[0]?.t ?? null;
        const lastWheelAt = this.wheels.at(-1)?.t ?? null;
        const activeWheelMs = firstWheelAt === null || lastWheelAt === null
          ? null
          : Math.max(1, lastWheelAt - firstWheelAt);
        const firstScrollTop = this.scrolls[0]?.scrollTop ?? 0;
        const scrollDistance = Math.max(0, scroller.scrollTop - firstScrollTop);
        const activeLongTasks = this.longTasks.filter((task) => task.t >= ${THRESHOLDS.longTaskWarmupMs});
        return {
          url: location.href,
          target: this.target,
          durationMs: performance.now() - this.startedAt,
          scroller: {
            className: String(scroller.className || ""),
            scrollTop: scroller.scrollTop,
            scrollHeight: scroller.scrollHeight,
            clientHeight: scroller.clientHeight,
            rect: this.rect,
          },
          counts: {
            samples: this.samples.length,
            scrolls: this.scrolls.length,
            wheels: this.wheels.length,
            longTasks: this.longTasks.length,
          },
          frameGapMs: stat(this.samples.map((sample) => sample.dt)),
          wheelGapMs: stat(wheelGaps),
          wheelDeltaY: stat(this.wheels.map((wheel) => wheel.deltaY)),
          scrollGapMs: stat(scrollGaps),
          absScrollDeltaPx: stat(this.scrolls.map((scroll) => Math.abs(scroll.dy))),
          longTaskMs: stat(this.longTasks.map((task) => task.duration)),
          activeLongTaskMs: stat(activeLongTasks.map((task) => task.duration)),
          longTasks: this.longTasks,
          activeLongTasks,
          firstScrollTop,
          lastScrollTop: scroller.scrollTop,
          viewportHeight: scroller.clientHeight,
          activeWheelMs,
          viewportsPerSecond: scroller.clientHeight > 0 && activeWheelMs !== null
            ? (scrollDistance / scroller.clientHeight) / (activeWheelMs / 1000)
            : null,
          worstFrameGaps: [...this.samples].sort((a, b) => b.dt - a.dt).slice(0, 20),
        };
      },
    };
    const onWheel = (event) => {
      state.wheels.push({
        t: performance.now() - state.startedAt,
        deltaY: event.deltaY,
        deltaMode: event.deltaMode,
        scrollTop: scroller.scrollTop,
      });
    };
    const onScroll = () => {
      const now = performance.now();
      const scrollTop = scroller.scrollTop;
      state.scrolls.push({
        t: now - state.startedAt,
        scrollTop,
        dy: scrollTop - state.lastScrollTop,
      });
      state.lastScrollTop = scrollTop;
    };
    const onRaf = () => {
      const now = performance.now();
      state.samples.push({
        t: now - state.startedAt,
        dt: now - state.lastRaf,
        scrollTop: scroller.scrollTop,
      });
      state.lastRaf = now;
      state.raf = requestAnimationFrame(onRaf);
    };
    state.onWheel = onWheel;
    state.onScroll = onScroll;
    addEventListener("wheel", onWheel, { capture: true, passive: true });
    scroller.addEventListener("scroll", onScroll, { passive: true });
    try {
      state.observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          state.longTasks.push({
            t: entry.startTime - state.startedAt,
            duration: entry.duration,
            name: entry.name,
          });
        }
      });
      state.observer.observe({ entryTypes: ["longtask"] });
    } catch {}
    state.raf = requestAnimationFrame(onRaf);
    return {
      ok: true,
      rect: state.rect,
      scrollTop: scroller.scrollTop,
      scrollHeight: scroller.scrollHeight,
      clientHeight: scroller.clientHeight,
      className: String(scroller.className || ""),
    };
  })()`;
}

function buildStopProbeScript() {
  return `(() => {
    const state = window.__devFastScrollEval;
    if (!state) return null;
    cancelAnimationFrame(state.raf);
    removeEventListener("wheel", state.onWheel, { capture: true });
    state.scroller.removeEventListener("scroll", state.onScroll);
    state.observer?.disconnect?.();
    return state.summarize();
  })()`;
}

function summarizeTrace(trace: { traceEvents?: unknown[] }) {
  const events = Array.isArray(trace.traceEvents) ? trace.traceEvents : [];
  const traceEvents = events.filter(
    (
      event,
    ): event is {
      name?: string;
      ph?: string;
      ts?: number;
      dur?: number;
      args?: {
        frame_reporter?: Record<string, unknown>;
        hasPartialUpdate?: boolean;
      };
    } => typeof event === "object" && event !== null,
  );

  const wheelBegins = traceEvents.filter(
    (event) =>
      event.name === "EventLatency" &&
      event.ph === "b" &&
      (event.args as { event_latency?: { event_type?: string } } | undefined)
        ?.event_latency?.event_type === "MOUSE_WHEEL",
  );
  const wheelTimestamps = wheelBegins
    .map((event) => event.ts)
    .filter((ts): ts is number => typeof ts === "number");
  const firstWheel = Math.min(...wheelTimestamps);
  const lastWheel = Math.max(...wheelTimestamps);
  const hasWheelWindow =
    Number.isFinite(firstWheel) && Number.isFinite(lastWheel);
  const inWheelWindow = (event: { ts?: number }) =>
    hasWheelWindow &&
    typeof event.ts === "number" &&
    event.ts >= firstWheel &&
    event.ts <= lastWheel;

  const frameReporters = traceEvents.filter(
    (event) =>
      event.name === "PipelineReporter" &&
      event.ph === "b" &&
      event.args?.frame_reporter &&
      inWheelWindow(event),
  );
  const states: Record<string, number> = {};
  const scrollStates: Record<string, number> = {};
  let missing = 0;
  let checkerRaster = 0;
  let checkerRecord = 0;
  let highLatency = 0;
  let affectsSmoothness = 0;

  for (const event of frameReporters) {
    const frame = event.args?.frame_reporter ?? {};
    const state = String(frame.state ?? "UNKNOWN");
    const scrollState = String(frame.scroll_state ?? "UNKNOWN");
    states[state] = (states[state] ?? 0) + 1;
    scrollStates[scrollState] = (scrollStates[scrollState] ?? 0) + 1;
    if (frame.has_missing_content) missing++;
    if (frame.checkerboarded_needs_raster) checkerRaster++;
    if (frame.checkerboarded_needs_record) checkerRecord++;
    if (frame.has_high_latency) highLatency++;
    if (frame.affects_smoothness) affectsSmoothness++;
  }

  const frameReporterTimestamps = frameReporters
    .map((event) => event.ts)
    .filter((ts): ts is number => typeof ts === "number")
    .sort((a, b) => a - b);
  const drawFrames = traceEvents
    .filter((event) => event.name === "DrawFrame" && inWheelWindow(event))
    .sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
  const screenshots = traceEvents
    .filter((event) => event.name === "Screenshot" && inWheelWindow(event))
    .sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
  const droppedFrames = traceEvents.filter(
    (event) => event.name === "DroppedFrame" && inWheelWindow(event),
  );

  return {
    eventCount: traceEvents.length,
    activeTraceMs: hasWheelWindow ? (lastWheel - firstWheel) / 1000 : null,
    wheelLatencyBeginEvents: wheelBegins.length,
    frameReporter: {
      count: frameReporters.length,
      states,
      scrollStates,
      missing,
      checkerRaster,
      checkerRecord,
      highLatency,
      affectsSmoothness,
      gapMs: stats(timestampGapsMs(frameReporterTimestamps)),
    },
    drawFrame: {
      count: drawFrames.length,
      gapMs: stats(
        timestampGapsMs(
          drawFrames
            .map((event) => event.ts)
            .filter(
              (timestamp): timestamp is number => typeof timestamp === "number",
            ),
        ),
      ),
    },
    droppedFrame: {
      count: droppedFrames.length,
      partial: droppedFrames.filter((event) => event.args?.hasPartialUpdate)
        .length,
    },
    screenshots: {
      count: screenshots.length,
      gapMs: stats(
        timestampGapsMs(
          screenshots
            .map((event) => event.ts)
            .filter(
              (timestamp): timestamp is number => typeof timestamp === "number",
            ),
        ),
      ),
    },
  };
}

function passFail(summary: {
  pageSummary: {
    frameGapMs: Stats;
    longTaskMs: Stats;
    activeLongTaskMs?: Stats;
    viewportsPerSecond: number | null;
  };
  traceSummary: ReturnType<typeof summarizeTrace> | null;
}) {
  const failures: string[] = [];
  const frameGapStats =
    summary.traceSummary?.drawFrame.gapMs.n &&
    summary.traceSummary.drawFrame.gapMs.n > 0
      ? summary.traceSummary.drawFrame.gapMs
      : summary.pageSummary.frameGapMs;
  const frameP95 = frameGapStats.p95;
  const frameP99 = frameGapStats.p99;
  const longTaskStats =
    summary.pageSummary.activeLongTaskMs ?? summary.pageSummary.longTaskMs;
  const longTaskMax = longTaskStats.max;
  const longTaskP95 = longTaskStats.p95;
  const viewportsPerSecond = summary.pageSummary.viewportsPerSecond;
  const screenshotP95 = summary.traceSummary?.screenshots.gapMs.p95 ?? null;

  if (frameP95 === null || frameP95 > THRESHOLDS.frameGapP95Ms) {
    failures.push(`frameGapMs.p95 ${frameP95} > ${THRESHOLDS.frameGapP95Ms}`);
  }
  if (frameP99 === null || frameP99 > THRESHOLDS.frameGapP99Ms) {
    failures.push(`frameGapMs.p99 ${frameP99} > ${THRESHOLDS.frameGapP99Ms}`);
  }
  if (screenshotP95 !== null && screenshotP95 > THRESHOLDS.screenshotGapP95Ms) {
    failures.push(
      `screenshotGapMs.p95 ${screenshotP95} > ${THRESHOLDS.screenshotGapP95Ms}`,
    );
  }
  if (longTaskMax !== null && longTaskMax > THRESHOLDS.longTaskMaxMs) {
    failures.push(
      `longTaskMs.max ${longTaskMax} > ${THRESHOLDS.longTaskMaxMs}`,
    );
  }
  if (
    longTaskP95 !== null &&
    longTaskStats.n >= 5 &&
    longTaskP95 > THRESHOLDS.longTaskP95Ms
  ) {
    failures.push(
      `longTaskMs.p95 ${longTaskP95} > ${THRESHOLDS.longTaskP95Ms}`,
    );
  }
  if (
    viewportsPerSecond === null ||
    viewportsPerSecond < THRESHOLDS.minViewportsPerSecond
  ) {
    failures.push(
      `viewportsPerSecond ${viewportsPerSecond} < ${THRESHOLDS.minViewportsPerSecond}`,
    );
  }
  return {
    status: failures.length === 0 ? "pass" : "fail",
    failures,
    thresholds: THRESHOLDS,
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const framesDir = path.join(opts.outDir, "frames");
  const tracePath = path.join(opts.outDir, "trace.json");
  const cpuProfilePath = path.join(opts.outDir, "cpu-profile.json");
  const summaryPath = path.join(opts.outDir, "summary.json");
  const mp4Path = path.join(opts.outDir, "scroll.mp4");

  await mkdir(opts.outDir, { recursive: true });
  await rm(framesDir, { recursive: true, force: true });
  if (!opts.noVideo) await mkdir(framesDir, { recursive: true });

  const target = await openOrFindTarget(opts);
  const client = new CdpClient(target.webSocketDebuggerUrl!);
  await client.open();

  let traceStarted = false;
  let cpuProfileStarted = false;
  try {
    await client.send("Runtime.enable");
    await client.send("Page.enable");
    await client.send("Input.setIgnoreInputEvents", { ignore: false });
    if (!target.url.includes(opts.url)) {
      await client.send("Page.navigate", { url: opts.url });
      await delay(2_000);
    }

    const installed = await evaluate<{
      ok: boolean;
      message?: string;
      rect: { left: number; top: number; width: number; height: number };
      scrollTop: number;
      scrollHeight: number;
      clientHeight: number;
      className: string;
    }>(client, buildPageProbeScript(opts.target));

    if (!installed.ok) {
      throw new Error(installed.message ?? "Page probe failed to install");
    }

    const inputPoint = {
      x: Math.round(installed.rect.left + installed.rect.width * 0.5),
      y: Math.round(installed.rect.top + installed.rect.height * 0.5),
    };

    let frameIndex = 0;
    const frames: string[] = [];
    let screencastRunning = false;
    let frameLoop: Promise<void> | null = null;
    if (!opts.noVideo) {
      let eventCursor = client.events.length;
      await client.send("Page.startScreencast", {
        format: "jpeg",
        quality: 70,
        maxWidth: 1280,
        maxHeight: 900,
        everyNthFrame: 1,
      });
      const writeFrameLoop = async () => {
        while (true) {
          const event = await client.waitForEvent(
            "Page.screencastFrame",
            eventCursor,
            250,
          );
          if (!event) {
            if (screencastRunning) continue;
            return;
          }
          eventCursor = client.events.indexOf(event) + 1;
          const params = event.params as
            | { data?: string; sessionId?: number }
            | undefined;
          if (!params?.data || typeof params.sessionId !== "number") continue;
          const framePath = path.join(
            framesDir,
            `frame-${String(frameIndex++).padStart(5, "0")}.jpg`,
          );
          frames.push(framePath);
          await writeFile(framePath, Buffer.from(params.data, "base64"));
          client.fire("Page.screencastFrameAck", {
            sessionId: params.sessionId,
          });
        }
      };
      screencastRunning = true;
      frameLoop = writeFrameLoop();
    }

    if (!opts.noTrace) {
      await client.send("Tracing.start", {
        transferMode: "ReturnAsStream",
        categories: [
          "devtools.timeline",
          "disabled-by-default-devtools.timeline.frame",
          "disabled-by-default-devtools.screenshot",
          "blink",
          "cc",
          "benchmark",
          "input",
          "latencyInfo",
          "toplevel",
        ].join(","),
        options: "sampling-frequency=10000",
      });
      traceStarted = true;
    }

    if (opts.target === "local") {
      await client.send("Profiler.enable");
      await client.send("Profiler.setSamplingInterval", { interval: 100 });
      await client.send("Profiler.start");
      cpuProfileStarted = true;
    }

    await client.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: inputPoint.x,
      y: inputPoint.y,
    });

    const deltas: number[] = [];
    const start = performance.now();
    let wheelEventsSent = 0;
    while (performance.now() - start < opts.durationMs) {
      const deltaY = syntheticWheelDelta(wheelEventsSent);
      deltas.push(deltaY);
      client.fire("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: inputPoint.x,
        y: inputPoint.y,
        deltaX: 0,
        deltaY,
        modifiers: 0,
        pointerType: "mouse",
      });
      wheelEventsSent++;
      const waitMs =
        start + wheelEventsSent * opts.cadenceMs - performance.now();
      if (waitMs > 0) await delay(waitMs);
    }
    await delay(1_500);

    if (cpuProfileStarted) {
      const profileResult = await client.send("Profiler.stop");
      cpuProfileStarted = false;
      await writeFile(
        cpuProfilePath,
        JSON.stringify(profileResult.profile ?? null),
      );
    }

    let traceSummary: ReturnType<typeof summarizeTrace> | null = null;
    if (traceStarted) {
      const eventStart = client.events.length;
      await client.send("Tracing.end");
      const complete = await client.waitForEvent(
        "Tracing.tracingComplete",
        eventStart,
      );
      if (!complete)
        throw new Error("Timed out waiting for tracing to complete");
      const stream = (complete.params as { stream?: string } | undefined)
        ?.stream;
      if (!stream) throw new Error("Tracing completed without an IO stream");
      const trace = await readTraceStream(client, stream);
      await writeFile(tracePath, trace);
      traceSummary = summarizeTrace(
        JSON.parse(trace) as { traceEvents?: unknown[] },
      );
    }

    if (!opts.noVideo) {
      await client.send("Page.stopScreencast");
      screencastRunning = false;
      await frameLoop;
      await delay(300);
      await encodeMp4(framesDir, mp4Path);
      if (!opts.keepFrames) {
        await rm(framesDir, { recursive: true, force: true });
      }
    }

    const pageSummary = await evaluate<Record<string, Json>>(
      client,
      buildStopProbeScript(),
    );

    const summary = {
      schema: "devFast.scrollEval.v1",
      capturedAt: new Date().toISOString(),
      target: opts.target,
      url: opts.url,
      input: {
        durationMs: opts.durationMs,
        cadenceMs: opts.cadenceMs,
        inputPoint,
        wheelEventsSent,
        wheelDeltaY: stats(deltas),
      },
      pageSummary,
      traceSummary,
      result: passFail({
        pageSummary: pageSummary as unknown as {
          frameGapMs: Stats;
          longTaskMs: Stats;
          viewportsPerSecond: number | null;
        },
        traceSummary,
      }),
      artifacts: {
        summary: summaryPath,
        trace: opts.noTrace ? null : tracePath,
        cpuProfile: opts.target === "local" ? cpuProfilePath : null,
        mp4: opts.noVideo ? null : mp4Path,
      },
    };

    await writeFile(summaryPath, JSON.stringify(summary, null, 2));
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    client.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
