/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { errorHandler } from "../../base/common/errors.js";
import type { ReviewDesktopConnection } from "../common/reviewDesktopBootstrap.js";
import {
  ReviewErrorReportLimiter,
  type ReviewErrorReport,
} from "../common/reviewErrorReport.js";
import { reviewTelemetryEventRequest } from "../common/reviewTelemetryRequest.js";
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
  /** Called once the server has accepted the event. */
  readonly onDelivered?: () => void;
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
  private readonly limiter = new ReviewErrorReportLimiter();
  private readonly queued: PendingReviewTelemetryEvent[] = [];
  private readonly unbind: () => void;
  private connection: ReviewDesktopConnection | undefined;
  /** False while the server is down between a death and its restart. */
  private online = false;
  private disposed = false;

  constructor(private readonly options: ReviewMainErrorTelemetryOptions) {
    this.unbind = errorHandler.addListener((error) => this.report(error));
    this.queueBootstrapBreadcrumbs();
    void this.options
      .whenConnected()
      .then((connection) => {
        this.connection = connection;
        this.online = true;
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

  /**
   * Queue a named Review telemetry event for the embedded server. Events
   * captured while the server is down, or whose send fails, wait for it to
   * come back; `onDelivered` runs only once the server accepts one.
   */
  capture(
    name: string,
    properties: Readonly<Record<string, string | number | boolean>> = {},
    error?: ReviewErrorReport,
    onDelivered?: () => void,
  ): void {
    if (this.disposed) return;
    const pending = { name, properties, error, onDelivered };
    if (this.connection && this.online) {
      this.post(pending);
      return;
    }
    this.hold(pending);
  }

  /** The server died; hold events until it is ready again. */
  serverLost(): void {
    this.online = false;
  }

  /** A (re)started server announced itself; send what waited for it. */
  serverReady(): void {
    if (!this.connection) return;
    this.online = true;
    this.drain();
  }

  dispose(): void {
    this.disposed = true;
    this.queued.length = 0;
    this.unbind();
  }

  private hold(pending: PendingReviewTelemetryEvent): void {
    if (this.disposed) return;
    this.queued.push(pending);
    // The connection never resolves when the server cannot start, so the cap is
    // what bounds this queue.
    if (this.queued.length > (this.options.maxQueued ?? DEFAULT_MAX_QUEUED)) {
      this.queued.shift();
    }
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
      send(
        `${connection.url}/telemetry/event`,
        reviewTelemetryEventRequest(
          connection,
          {
            name: pending.name,
            properties: pending.properties,
            error: pending.error,
          },
        ),
      ).then(
        (response) => {
          if (!response.ok) return;
          pending.onDelivered?.();
          // A send that failed while the server was up retries after this one.
          if (this.online) this.drain();
        },
        // The server is unreachable: most likely it just died.
        () => this.hold(pending),
      );
    } catch (error) {
      this.options.logError?.(
        `[Review Desktop] could not report a main-process telemetry event: ${error}`,
      );
    }
  }
}
