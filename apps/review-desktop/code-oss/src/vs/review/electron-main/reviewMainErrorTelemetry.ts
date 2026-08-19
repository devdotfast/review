/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { errorHandler } from "../../base/common/errors.js";
import { generateUuid } from "../../base/common/uuid.js";
import type { ReviewDesktopConnection } from "../common/reviewDesktopBootstrap.js";
import {
  ReviewErrorReportLimiter,
  type ReviewErrorReport,
} from "../common/reviewErrorReport.js";
import { drainReviewBootstrapBreadcrumbs } from "../node/reviewBootstrapBreadcrumb.js";

export interface ReviewMainErrorTelemetryOptions {
  /** Resolves with the loopback endpoint and token of the embedded server. */
  readonly whenConnected: () => Promise<ReviewDesktopConnection>;
  /** Reads `review.telemetry.enabled` at the moment of the error. */
  readonly isTelemetryEnabled: () => boolean;
  /**
   * The Electron user data directory, where a crash that happened before the
   * last launch could start leaves its note. Omit it to skip that check.
   */
  readonly userDataPath?: string;
  readonly logError?: (message: string) => void;
  readonly fetchImpl?: typeof fetch;
  readonly maxQueued?: number;
}

const DEFAULT_MAX_QUEUED = 20;
const MAX_BOOTSTRAP_REPORTS = 5;

interface PendingReviewTelemetryEvent {
  readonly name: string;
  readonly properties: Readonly<Record<string, string | number | boolean>>;
  readonly error?: ReviewErrorReport;
}

/**
 * Reports Electron main-process telemetry through the embedded Review server.
 *
 * The upstream `ErrorTelemetry` already routes `uncaughtException` and
 * `unhandledRejection` into `onUnexpectedError`, so listening on the shared
 * error handler covers every main-process error without touching a vendored
 * file.
 *
 * The report goes to the loopback server, never straight to a vendor. That is
 * deliberate: the server holds the opt-out checks and the redaction step, and a
 * direct call from here would bypass both.
 */
export class ReviewMainErrorTelemetry {
  readonly appSessionId = generateUuid();

  private readonly limiter = new ReviewErrorReportLimiter();
  private readonly queued: PendingReviewTelemetryEvent[] = [];
  private readonly unbind: () => void;
  private connection: ReviewDesktopConnection | undefined;
  private disposed = false;

  constructor(private readonly options: ReviewMainErrorTelemetryOptions) {
    this.unbind = errorHandler.addListener((error) => this.report(error));
    this.queueBootstrapBreadcrumbs();
    void this.options
      .whenConnected()
      .then((connection) => {
        this.connection = connection;
        this.drain();
      })
      .catch(() => undefined);
  }

  /** Report an error that Review packed itself, such as a startup crash note. */
  send(errorSource: string, report: ReviewErrorReport): void {
    this.capture(
      "client_error",
      {
        error_source: errorSource,
        error_process: "main",
      },
      report,
    );
  }

  /** Queue a named Review telemetry event for the embedded server. */
  capture(
    name: string,
    properties: Readonly<Record<string, string | number | boolean>> = {},
    error?: ReviewErrorReport,
  ): void {
    if (this.disposed) return;
    const pending = { name, properties, error };
    if (this.connection) {
      this.post(pending);
      return;
    }
    this.queued.push(pending);
    // The connection never resolves when the server cannot start, so the cap is
    // what bounds this queue.
    if (this.queued.length > (this.options.maxQueued ?? DEFAULT_MAX_QUEUED)) {
      this.queued.shift();
    }
  }

  dispose(): void {
    this.disposed = true;
    this.queued.length = 0;
    this.unbind();
  }

  private report(error: unknown): void {
    if (this.disposed) return;
    this.limiter.report(error, (report) =>
      this.send("main_unexpected", report),
    );
  }

  /**
   * Pick up a crash that happened before the last launch could start. The note
   * file is always deleted, whether or not these entries are ever sent, so an
   * opted-out user never accumulates one.
   */
  private queueBootstrapBreadcrumbs(): void {
    const userDataPath = this.options.userDataPath;
    if (!userDataPath) return;
    try {
      for (const breadcrumb of drainReviewBootstrapBreadcrumbs(
        userDataPath,
      ).slice(0, MAX_BOOTSTRAP_REPORTS)) {
        this.send("bootstrap", {
          name: breadcrumb.name,
          message: breadcrumb.message,
          stack: breadcrumb.stack,
        });
      }
    } catch {
      // A crash note must never keep the app from starting.
    }
  }

  private drain(): void {
    for (const pending of this.queued.splice(0)) this.post(pending);
  }

  private post(pending: PendingReviewTelemetryEvent): void {
    const connection = this.connection;
    if (!connection) return;
    // Read the setting at send time, not at construction: a user may turn
    // telemetry off between the two.
    if (!this.options.isTelemetryEnabled()) return;
    const send = this.options.fetchImpl ?? fetch;
    try {
      void send(`${connection.url}/telemetry/event`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-review-token": connection.token,
          "x-review-app-session-id": this.appSessionId,
        },
        body: JSON.stringify({
          name: pending.name,
          properties: pending.properties,
          error: pending.error,
        }),
      }).catch(() => undefined);
    } catch (error) {
      this.options.logError?.(
        `[Review Desktop] could not report a main-process telemetry event: ${error}`,
      );
    }
  }
}
