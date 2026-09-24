/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { app, BrowserWindow } from "electron";
import { Disposable, toDisposable } from "../../base/common/lifecycle.js";
import { join } from "../../base/common/path.js";
import { IConfigurationService } from "../../platform/configuration/common/configuration.js";
import { IEnvironmentMainService } from "../../platform/environment/electron-main/environmentMainService.js";
import { ILifecycleMainService } from "../../platform/lifecycle/electron-main/lifecycleMainService.js";
import { ILogService } from "../../platform/log/common/log.js";
import { IProductService } from "../../platform/product/common/productService.js";
import { getResolvedShellEnv } from "../../platform/shell/node/shellEnv.js";
import { IApplicationStorageMainService } from "../../platform/storage/electron-main/storageMainService.js";
import { NullTelemetryService } from "../../platform/telemetry/common/telemetryUtils.js";
import { IUpdateService } from "../../platform/update/common/update.js";
import { UtilityProcess } from "../../platform/utilityProcess/electron-main/utilityProcess.js";
import type { ReviewDesktopConnection } from "../common/reviewDesktopBootstrap.js";
import { REVIEW_TELEMETRY_SETTING } from "../common/reviewConfigurationDefaults.js";
import { REVIEW_CRASH_DUMPS_DIRNAME } from "../node/reviewCrashReporter.js";
import { ReviewCrashDumps } from "./reviewCrashDumps.js";
import { ReviewCrashTelemetry } from "./reviewCrashTelemetry.js";
import { ReviewMainErrorTelemetry } from "./reviewMainErrorTelemetry.js";
import { ReviewServerSupervisor } from "./reviewServerSupervisor.js";
import {
  darwinShipItLogPath,
  ReviewUpdateTelemetry,
} from "./reviewUpdateTelemetry.js";

/**
 * Binds the embedded Review server's lifetime to the application's. All of the
 * supervision logic lives in `ReviewServerSupervisor`, which holds no Electron
 * dependency so it stays testable; this class only supplies the platform.
 */
export class ReviewDesktopHost extends Disposable {
  private readonly supervisor: ReviewServerSupervisor;
  private terminating = false;

  private readonly onTerminationSignal = () => {
    if (this.terminating) return;
    this.terminating = true;
    void this.lifecycleMainService.kill(0);
  };

  constructor(
    @IConfigurationService
    private readonly configurationService: IConfigurationService,
    @ILogService private readonly logService: ILogService,
    @ILifecycleMainService
    private readonly lifecycleMainService: ILifecycleMainService,
    @IEnvironmentMainService
    private readonly environmentMainService: IEnvironmentMainService,
    @IProductService private readonly productService: IProductService,
    @IUpdateService private readonly updateService: IUpdateService,
    @IApplicationStorageMainService
    private readonly applicationStorageMainService: IApplicationStorageMainService,
  ) {
    super();
    let resolvedEnvironment: Promise<NodeJS.ProcessEnv> | undefined;
    let crashTelemetry: ReviewCrashTelemetry | undefined;
    const crashDumpsDir = join(
      this.environmentMainService.userDataPath,
      REVIEW_CRASH_DUMPS_DIRNAME,
    );
    this.supervisor = this._register(
      new ReviewServerSupervisor({
        appRoot: this.environmentMainService.appRoot,
        channel: !this.environmentMainService.isBuilt
          ? "dev"
          : this.productService.quality === "preview"
            ? "preview"
            : "stable",
        isBuilt: this.environmentMainService.isBuilt,
        userExtensionsPath: this.environmentMainService.extensionsPath,
        appVersion:
          this.productService.reviewVersion ?? this.productService.version,
        appUrlProtocol: this.productService.urlProtocol,
        releaseChannel: this.productService.quality,
        serverEntryOverride: process.env["DEV_FAST_REVIEW_SERVER_ENTRY"],
        resolveEnvironment: () =>
          (resolvedEnvironment ??= getResolvedShellEnv(
            this.configurationService,
            this.logService,
            this.environmentMainService.args,
            process.env,
          )),
        logInfo: (message) => this.logService.info(message),
        logError: (message) => this.logService.error(message),
        createProcess: () =>
          new UtilityProcess(
            this.logService,
            NullTelemetryService,
            this.lifecycleMainService,
          ),
        telemetryEnabled:
          this.configurationService.getValue<boolean>(REVIEW_TELEMETRY_SETTING) !==
          false,
        crashDumpsDir,
        onServerTerminated: (detail) => crashTelemetry?.reportServerExit(detail),
      }),
    );
    this._register(
      this.configurationService.onDidChangeConfiguration((event) => {
        if (!event.affectsConfiguration(REVIEW_TELEMETRY_SETTING)) return;
        this.supervisor.setTelemetryEnabled(
          this.configurationService.getValue<boolean>(
            REVIEW_TELEMETRY_SETTING,
          ) !== false,
        );
      }),
    );
    this._register(
      this.lifecycleMainService.onWillShutdown((event) => {
        event.join("reviewDesktopHost", this.supervisor.stop());
      }),
    );
    // Main-process errors report through the embedded server, so they pass the
    // same opt-out checks and the same redaction step as every other event.
    const errorTelemetry = new ReviewMainErrorTelemetry({
      whenConnected: () => this.whenConnected(),
      isTelemetryEnabled: () =>
        this.configurationService.getValue<boolean>(REVIEW_TELEMETRY_SETTING) !==
        false,
      userDataPath: this.environmentMainService.userDataPath,
      logError: (message) => this.logService.error(message),
    });
    this._register(toDisposable(() => errorTelemetry.dispose()));
    const crashDumps = new ReviewCrashDumps({
      dumpsDir: crashDumpsDir,
      launch: {
        startedAt: Date.now(),
        appSessionId: this.supervisor.appSessionId,
        appVersion:
          this.productService.reviewVersion ?? this.productService.version,
      },
      whenConnected: () => this.whenConnected(),
      isTelemetryEnabled: () =>
        this.configurationService.getValue<boolean>(REVIEW_TELEMETRY_SETTING) !==
        false,
      logError: (message) => this.logService.error(message),
    });
    crashTelemetry = this._register(
      new ReviewCrashTelemetry({
        app,
        windows: BrowserWindow.getAllWindows(),
        capture: (name, properties) => errorTelemetry.capture(name, properties),
        onCrashRecorded: (at) => crashDumps.recordLiveCrash(at),
      }),
    );
    crashDumps.reconcile().catch((error) =>
      this.logService.error(`[Review Desktop] crash dump reconcile failed: ${error}`),
    );
    this._register(
      new ReviewUpdateTelemetry({
        updateService: this.updateService,
        storageService: this.applicationStorageMainService,
        telemetry: errorTelemetry,
        isTelemetryEnabled: () =>
          this.configurationService.getValue<boolean>(
            REVIEW_TELEMETRY_SETTING,
          ) !== false,
        shipItLogPath: this.productService.darwinBundleIdentifier
          ? darwinShipItLogPath(
              this.environmentMainService.userHome.fsPath,
              this.productService.darwinBundleIdentifier,
            )
          : undefined,
        logError: (message) => this.logService.error(message),
      }),
    );
    process.once("SIGINT", this.onTerminationSignal);
    process.once("SIGTERM", this.onTerminationSignal);
    this.supervisor.start();
  }

  /**
   * Resolves once the embedded server has announced a validated endpoint. The
   * renderer awaits this instead of reading bootstrap environment variables.
   */
  whenConnected(): Promise<ReviewDesktopConnection> {
    return this.supervisor.whenConnected();
  }

  stageRustAnalyzer(): void {
    this.supervisor.stageRustAnalyzer();
  }

  override dispose(): void {
    process.off("SIGINT", this.onTerminationSignal);
    process.off("SIGTERM", this.onTerminationSignal);
    super.dispose();
  }
}
