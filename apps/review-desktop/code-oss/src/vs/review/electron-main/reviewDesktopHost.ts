/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, toDisposable } from "../../base/common/lifecycle.js";
import { IConfigurationService } from "../../platform/configuration/common/configuration.js";
import { IEnvironmentMainService } from "../../platform/environment/electron-main/environmentMainService.js";
import { ILifecycleMainService } from "../../platform/lifecycle/electron-main/lifecycleMainService.js";
import { ILogService } from "../../platform/log/common/log.js";
import { IProductService } from "../../platform/product/common/productService.js";
import { getResolvedShellEnv } from "../../platform/shell/node/shellEnv.js";
import { NullTelemetryService } from "../../platform/telemetry/common/telemetryUtils.js";
import { UtilityProcess } from "../../platform/utilityProcess/electron-main/utilityProcess.js";
import type { ReviewDesktopConnection } from "../common/reviewDesktopBootstrap.js";
import { REVIEW_TELEMETRY_SETTING } from "../common/reviewConfigurationDefaults.js";
import { ReviewMainErrorTelemetry } from "./reviewMainErrorTelemetry.js";
import { ReviewServerSupervisor } from "./reviewServerSupervisor.js";

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
  ) {
    super();
    let resolvedEnvironment: Promise<NodeJS.ProcessEnv> | undefined;
    this.supervisor = this._register(
      new ReviewServerSupervisor({
        appRoot: this.environmentMainService.appRoot,
        isBuilt: this.environmentMainService.isBuilt,
        userExtensionsPath: this.environmentMainService.extensionsPath,
        appVersion:
          this.productService.reviewVersion ?? this.productService.version,
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
