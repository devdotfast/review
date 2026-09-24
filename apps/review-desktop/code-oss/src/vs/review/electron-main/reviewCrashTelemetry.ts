/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IDisposable } from "../../base/common/lifecycle.js";
import { REVIEW_SERVER_PROCESS_TYPE, type ReviewServerTermination } from "./reviewServerSupervisor.js";

export interface ReviewCrashWindow {
  readonly webContents?: unknown;
  on(event: "unresponsive" | "responsive" | "closed", listener: () => void): unknown;
}

interface ProcessGoneDetails {
  readonly reason: string;
  readonly exitCode: number;
}

interface ChildProcessGoneDetails extends ProcessGoneDetails {
  readonly type: string;
  readonly name?: string;
}

/** The slice of Electron's `app` the listeners use. */
export interface ReviewCrashEmitter {
  on(event: "render-process-gone", listener: (event: unknown, webContents: unknown, details: ProcessGoneDetails) => void): unknown;
  on(event: "child-process-gone", listener: (event: unknown, details: ChildProcessGoneDetails) => void): unknown;
  on(event: "browser-window-created", listener: (event: unknown, window: ReviewCrashWindow) => void): unknown;
  off(event: string, listener: (...args: never[]) => void): unknown;
}

export interface ReviewCrashTelemetryOptions {
  readonly app: ReviewCrashEmitter;
  /** Windows that already exist; later ones arrive through `browser-window-created`. */
  readonly windows?: readonly ReviewCrashWindow[];
  /** `onDelivered` runs once the event reached the server, if it ever does. */
  readonly capture: (name: string, properties: Record<string, string | number | boolean>, onDelivered?: () => void) => void;
  readonly now?: () => number;
  readonly launchedAt?: number;
  /**
   * Called with the wall-clock time of every live crash once it is delivered,
   * so dump reconciliation only skips a dump whose crash was counted.
   */
  readonly onCrashRecorded?: (at: number) => void;
}

/** Electron reasons that mean "gone on purpose", not a crash. */
const NOT_A_CRASH = new Set(["clean-exit", "killed"]);

function childProcessKind(type: string): "gpu" | "utility" | "unknown" {
  if (type === "GPU") return "gpu";
  if (type === "Utility") return "utility";
  return "unknown";
}

/**
 * Counts process deaths and window hangs while the app is alive. Everything
 * goes through the main-process telemetry queue, so a crash while the server
 * is down, including the server's own, still sends once it is ready.
 */
export class ReviewCrashTelemetry implements IDisposable {
  private readonly now: () => number;
  private readonly launchedAt: number;
  private readonly unbind: Array<() => void> = [];
  /** Hung windows and when their hang started. Closed windows leave it. */
  private readonly hangs = new Map<ReviewCrashWindow, number>();

  constructor(private readonly options: ReviewCrashTelemetryOptions) {
    this.now = options.now ?? Date.now;
    this.launchedAt = options.launchedAt ?? this.now();
    const onRendererGone = (_event: unknown, contents: unknown, details: ProcessGoneDetails) => {
      // A hung window whose renderer died never turns responsive again.
      for (const window of this.hangs.keys()) {
        if (window.webContents === contents) this.endHang(window);
      }
      this.crash("renderer", details.reason, details.exitCode);
    };
    const onChildGone = (_event: unknown, details: ChildProcessGoneDetails) => {
      // The server's supervisor reports its death, and knows a deliberate stop.
      if (details.type === "Utility" && details.name?.startsWith(`${REVIEW_SERVER_PROCESS_TYPE}-`)) return;
      this.crash(childProcessKind(details.type), details.reason, details.exitCode);
    };
    const onWindow = (_event: unknown, window: ReviewCrashWindow) => this.watchWindow(window);
    options.app.on("render-process-gone", onRendererGone);
    options.app.on("child-process-gone", onChildGone);
    options.app.on("browser-window-created", onWindow);
    this.unbind.push(
      () => options.app.off("render-process-gone", onRendererGone),
      () => options.app.off("child-process-gone", onChildGone),
      () => options.app.off("browser-window-created", onWindow),
    );
    for (const window of options.windows ?? []) this.watchWindow(window);
  }

  /** A server death the supervisor did not cause. A clean exit is not a crash. */
  reportServerExit(detail: ReviewServerTermination): void {
    // UtilityProcess reports every exit with the signal "unknown".
    const signal = detail.signal?.startsWith("SIG") ? detail.signal : undefined;
    if (!signal && detail.code === 0) return;
    this.crash("server", signal ?? detail.reason.split(" ", 1)[0], detail.code ?? -1);
  }

  dispose(): void {
    for (const unbind of this.unbind.splice(0)) unbind();
  }

  private crash(process: string, reason: string, exitCode: number): void {
    if (NOT_A_CRASH.has(reason)) return;
    const at = this.now();
    this.options.capture("crash", {
      process,
      reason,
      exit_code: exitCode,
      uptime_ms: Math.max(0, at - this.launchedAt),
      source: "live",
    }, () => this.options.onCrashRecorded?.(at));
  }

  private watchWindow(window: ReviewCrashWindow): void {
    window.on("unresponsive", () => {
      if (this.hangs.has(window)) return;
      this.hangs.set(window, this.now());
      this.options.capture("hang_started", {});
    });
    window.on("responsive", () => this.endHang(window));
    // Closing a hung window ends its hang, so every start has an end.
    window.on("closed", () => this.endHang(window));
  }

  private endHang(window: ReviewCrashWindow): void {
    const started = this.hangs.get(window);
    if (started === undefined) return;
    this.hangs.delete(window);
    this.options.capture("hang_ended", { duration_ms: this.now() - started });
  }
}
