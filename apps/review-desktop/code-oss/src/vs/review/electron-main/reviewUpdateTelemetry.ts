/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { open } from "node:fs/promises";
import { join } from "node:path";

import { Disposable, DisposableStore } from "../../base/common/lifecycle.js";
import {
  DARWIN_UPDATE_ATTEMPT_STORAGE_KEY,
  DARWIN_UPDATE_OUTCOME_STORAGE_KEY,
  parseDarwinUpdateAttempt,
  parseDarwinUpdateOutcomeRecord,
  type IDarwinUpdateAttempt,
} from "../../platform/update/common/darwinUpdateRecovery.js";
import {
  type IUpdateService,
  type State,
  StateType,
} from "../../platform/update/common/update.js";
import {
  StorageScope,
  StorageTarget,
} from "../../platform/storage/common/storage.js";
import type { IApplicationStorageMainService } from "../../platform/storage/electron-main/storageMainService.js";
import type { ReviewMainErrorTelemetry } from "./reviewMainErrorTelemetry.js";

const UPDATE_STARTED_STORAGE_KEY = "review/update/telemetry/started.v1";
const MAX_SHIPIT_LOG_BYTES = 64 * 1024;
const INSTALL_FALLBACK_MESSAGE =
  "The downloaded update did not replace the running application.";

export type ReviewUpdateFailurePhase = "check" | "download" | "install";
export type ReviewUpdateMessageSource =
  | "electron"
  | "request"
  | "shipit"
  | "fallback";

interface ReviewUpdateTelemetryOptions {
  readonly updateService: IUpdateService;
  readonly storageService: IApplicationStorageMainService;
  readonly telemetry: ReviewMainErrorTelemetry;
  readonly isTelemetryEnabled: () => boolean;
  readonly shipItLogPath?: string;
  readonly readInstallFailure?: (
    path: string,
    offset: number | undefined,
  ) => Promise<{ message: string; source: ReviewUpdateMessageSource }>;
  readonly logError?: (message: string) => void;
}

/**
 * Converts updater state and persisted Darwin restart outcomes into the three
 * Review update lifecycle events. Raw ShipIt output never leaves this module.
 */
export class ReviewUpdateTelemetry extends Disposable {
  private lastState: State;

  constructor(private readonly options: ReviewUpdateTelemetryOptions) {
    super();
    this.lastState = options.updateService.state;
    this._register(
      options.updateService.onStateChange((state) => {
        this.onStateChange(state);
        this.lastState = state;
      }),
    );

    const storageListeners = this._register(new DisposableStore());
    const onOutcomeChanged = options.storageService.onDidChangeValue(
      StorageScope.APPLICATION,
      DARWIN_UPDATE_OUTCOME_STORAGE_KEY,
      storageListeners,
    );
    this._register(onOutcomeChanged(() => void this.processOutcome()));

    void options.storageService.whenReady
      .then(() => {
        if (options.updateService.state.type === StateType.Ready) {
          this.recordStarted();
        }
        return this.processOutcome();
      })
      .catch((error) =>
        options.logError?.(
          `[Review Desktop] could not process update telemetry: ${error}`,
        ),
      );
  }

  private onStateChange(state: State): void {
    if (state.type === StateType.Ready) {
      this.recordStarted();
      return;
    }
    if (state.type !== StateType.Idle || !state.error) {
      return;
    }
    const phase = updateFailurePhase(this.lastState);
    if (!phase || !this.options.isTelemetryEnabled()) {
      return;
    }
    this.captureFailure(
      phase,
      state.errorSource ?? "electron",
      state.error,
    );
  }

  private recordStarted(): void {
    const attempt = parseDarwinUpdateAttempt(
      this.options.storageService.get(
        DARWIN_UPDATE_ATTEMPT_STORAGE_KEY,
        StorageScope.APPLICATION,
      ),
    );
    if (!attempt?.attemptId || !attempt.productVersion) {
      return;
    }
    const lastStarted = this.options.storageService.get(
      UPDATE_STARTED_STORAGE_KEY,
      StorageScope.APPLICATION,
    );
    if (lastStarted === attempt.attemptId) {
      return;
    }

    // Mark it observed even when telemetry is disabled. Enabling telemetry
    // later must not send an event for an earlier update.
    this.options.storageService.store(
      UPDATE_STARTED_STORAGE_KEY,
      attempt.attemptId,
      StorageScope.APPLICATION,
      StorageTarget.MACHINE,
    );
    void this.options.storageService.flush().catch(() => undefined);
    if (!this.options.isTelemetryEnabled()) {
      return;
    }
    this.options.telemetry.capture("update_started", {
      update_attempt_id: attempt.attemptId,
      target_version: attempt.productVersion,
    });
  }

  private async processOutcome(): Promise<void> {
    const raw = this.options.storageService.get(
      DARWIN_UPDATE_OUTCOME_STORAGE_KEY,
      StorageScope.APPLICATION,
    );
    const outcome = parseDarwinUpdateOutcomeRecord(raw);
    if (!outcome) {
      return;
    }

    // Consume first for both consent states, so a crash or later opt-in cannot
    // turn this into a duplicate or retroactive event.
    this.options.storageService.remove(
      DARWIN_UPDATE_OUTCOME_STORAGE_KEY,
      StorageScope.APPLICATION,
    );
    void this.options.storageService.flush().catch(() => undefined);

    const { attempt } = outcome;
    if (
      !attempt.attemptId ||
      !attempt.productVersion ||
      !this.options.isTelemetryEnabled()
    ) {
      return;
    }
    const properties = lifecycleProperties(attempt, outcome.resolvedAt);
    if (outcome.kind === "applied") {
      this.options.telemetry.capture("update_completed", properties);
      return;
    }

    const failure = await this.readInstallFailure(attempt.shipItLogOffset);
    this.captureFailure("install", failure.source, failure.message, properties);
  }

  private async readInstallFailure(
    offset: number | undefined,
  ): Promise<{ message: string; source: ReviewUpdateMessageSource }> {
    const path = this.options.shipItLogPath;
    if (!path) {
      return { message: INSTALL_FALLBACK_MESSAGE, source: "fallback" };
    }
    try {
      return await (
        this.options.readInstallFailure ?? readDarwinShipItFailure
      )(path, offset);
    } catch {
      return { message: INSTALL_FALLBACK_MESSAGE, source: "fallback" };
    }
  }

  private captureFailure(
    phase: ReviewUpdateFailurePhase,
    source: ReviewUpdateMessageSource,
    message: string,
    properties: Readonly<Record<string, string | number>> = {},
  ): void {
    this.options.telemetry.capture(
      "update_failed",
      { ...properties, phase, message_source: source },
      {
        name: `Update${phase[0].toUpperCase()}${phase.slice(1)}Error`,
        message,
        stack: "Update lifecycle telemetry",
      },
    );
  }
}

export function darwinShipItLogPath(
  userHomePath: string,
  bundleIdentifier: string,
): string {
  return join(
    userHomePath,
    "Library",
    "Caches",
    `${bundleIdentifier}.ShipIt`,
    "ShipIt_stderr.log",
  );
}

export function extractDarwinShipItFailureMessage(
  appendedLog: string,
): string | undefined {
  const lines = appendedLog.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index];
    const marker = line.lastIndexOf("Installation error:");
    if (marker < 0) continue;
    const error = line.slice(marker + "Installation error:".length).trim();
    const summary = error.match(
      /Error Domain=([A-Za-z0-9._-]{1,80}) Code=(-?\d{1,10}) "([^"\r\n]{1,2000})"/,
    );
    if (summary) {
      return `Error Domain=${summary[1]} Code=${summary[2]} "${summary[3]}"`;
    }
  }
  for (let index = lines.length - 1; index >= 0; index--) {
    if (lines[index].includes("Too many attempts to install, aborting update")) {
      return "Too many attempts to install, aborting update";
    }
  }
  return undefined;
}

export async function readDarwinShipItFailure(
  path: string,
  offset: number | undefined,
): Promise<{ message: string; source: ReviewUpdateMessageSource }> {
  if (offset === undefined) {
    return { message: INSTALL_FALLBACK_MESSAGE, source: "fallback" };
  }
  const file = await open(path, "r");
  try {
    const size = (await file.stat()).size;
    if (size < offset) {
      return { message: INSTALL_FALLBACK_MESSAGE, source: "fallback" };
    }
    const start = Math.max(offset, size - MAX_SHIPIT_LOG_BYTES);
    const length = size - start;
    if (length <= 0) {
      return { message: INSTALL_FALLBACK_MESSAGE, source: "fallback" };
    }
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await file.read(buffer, 0, length, start);
    const message = extractDarwinShipItFailureMessage(
      buffer.subarray(0, bytesRead).toString("utf8"),
    );
    return message
      ? { message, source: "shipit" }
      : { message: INSTALL_FALLBACK_MESSAGE, source: "fallback" };
  } finally {
    await file.close();
  }
}

function updateFailurePhase(
  previous: State,
): Exclude<ReviewUpdateFailurePhase, "install"> | undefined {
  if (previous.type === StateType.CheckingForUpdates) {
    return "check";
  }
  if (
    previous.type === StateType.Downloading ||
    previous.type === StateType.Overwriting
  ) {
    return "download";
  }
  return undefined;
}

function lifecycleProperties(
  attempt: IDarwinUpdateAttempt,
  resolvedAt: number,
): Record<string, string | number> {
  return {
    update_attempt_id: attempt.attemptId!,
    target_version: attempt.productVersion!,
    duration_ms: Math.max(0, resolvedAt - attempt.attemptedAt),
  };
}
