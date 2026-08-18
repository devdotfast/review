/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DeferredPromise, timeout } from "../../base/common/async.js";
import { Event } from "../../base/common/event.js";
import {
  Disposable,
  DisposableStore,
  IDisposable,
} from "../../base/common/lifecycle.js";
import { join } from "../../base/common/path.js";
import * as semver from "../../base/common/semver/semver.js";
import {
  type ReviewDesktopConnection,
  ReviewReadyEventReader,
  resolveReviewServerEntry,
} from "../common/reviewDesktopBootstrap.js";
import { REVIEW_SERVER_RESTART_DELAYS } from "../common/reviewReconnect.js";

/**
 * The slice of `UtilityProcess` the supervisor drives. Depending on this rather
 * than the concrete class keeps the supervisor free of any Electron import, so
 * its readiness, restart, and credential-stability behaviour can be tested.
 */
export interface IReviewServerProcess extends IDisposable {
  readonly onStdout: Event<string>;
  readonly onStderr: Event<string>;
  readonly onExit: Event<{ readonly code: number; readonly signal: string }>;
  readonly onCrash: Event<{ readonly code: number; readonly reason: string }>;
  start(configuration: {
    readonly type: string;
    readonly name: string;
    readonly entryPoint: string;
    readonly parentLifecycleBound?: number;
    readonly env?: Record<string, string | undefined>;
  }): boolean;
  postMessage(message: unknown): unknown;
  kill(): void;
}

export interface ReviewServerSupervisorOptions {
  readonly appRoot: string;
  readonly appVersion: string;
  readonly isBuilt: boolean;
  readonly serverEntryOverride?: string | undefined;
  readonly readyTimeout?: number;
  readonly appPid?: number;
  readonly resolveEnvironment?: () => Promise<NodeJS.ProcessEnv>;
  readonly logInfo: (message: string) => void;
  readonly logError: (message: string) => void;
  readonly createProcess: () => IReviewServerProcess;
  readonly telemetryEnabled?: boolean;
  readonly userExtensionsPath?: string;
}

export function createReviewServerEnvironment(options: {
  readonly applicationEnvironment: NodeJS.ProcessEnv;
  readonly resolvedEnvironment: NodeJS.ProcessEnv;
  readonly appVersion: string;
  readonly serverEntry: string;
  readonly port: number;
  readonly token: string;
  readonly instanceId: string;
  readonly appPid: number;
  readonly telemetryEnabled: boolean;
  readonly rustAnalyzerSource?: string;
}): Record<string, string | undefined> {
  return {
    ...options.applicationEnvironment,
    ...options.resolvedEnvironment,
    DEV_FAST_REVIEW_SERVER_ENTRY: options.serverEntry,
    DEV_FAST_REVIEW_SERVER_PORT: String(options.port),
    DEV_FAST_REVIEW_SERVER_TOKEN: options.token,
    DEV_FAST_REVIEW_INSTANCE_ID: options.instanceId,
    DEV_FAST_REVIEW_APP_PID: String(options.appPid),
    DEV_FAST_REVIEW_APP_VERSION: options.appVersion,
    DEV_FAST_REVIEW_DESKTOP_HOST_AUTOSTART: "1",
    DEV_FAST_REVIEW_TELEMETRY_DISABLED: options.telemetryEnabled
      ? undefined
      : "1",
    // The app's own Electron binary doubles as the CLI's Node runtime
    // (ELECTRON_RUN_AS_NODE), so an installed `review` command never
    // depends on a system Node.
    DEV_FAST_REVIEW_CLI_RUNTIME: process.execPath,
    DEV_FAST_REVIEW_RUST_ANALYZER: options.rustAnalyzerSource,
  };
}

function executableName(): string {
  return process.platform === "win32" ? "rust-analyzer.exe" : "rust-analyzer";
}

function isExecutableFile(file: string): boolean {
  try {
    if (!fs.statSync(file).isFile()) return false;
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolveInstalledRustAnalyzer(userExtensionsPath: string | undefined): string | undefined {
  if (!userExtensionsPath) return undefined;
  const candidates: { version: string; executable: string }[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(userExtensionsPath, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("rust-lang.rust-analyzer-")) {
      continue;
    }
    const directory = path.join(userExtensionsPath, entry.name);
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8")) as { version?: unknown };
      if (typeof manifest.version !== "string" || !semver.valid(manifest.version)) {
        continue;
      }
      const executable = path.join(directory, "server", executableName());
      if (isExecutableFile(executable)) {
        candidates.push({ version: manifest.version, executable });
      }
    } catch {
      // Ignore incomplete extension directories left by interrupted installs.
    }
  }
  candidates.sort((left, right) => semver.rcompare(left.version, right.version));
  return candidates[0]?.executable;
}

export function resolveRustAnalyzerSource(options: {
  readonly userExtensionsPath?: string;
  readonly appRoot: string;
  readonly isBuilt: boolean;
}): string | undefined {
  const installed = resolveInstalledRustAnalyzer(options.userExtensionsPath);
  if (installed) return installed;
  if (options.isBuilt) return undefined;
  const developmentFallback = path.join(
    options.appRoot,
    "extensions",
    "rust-lang.rust-analyzer",
    "server",
    executableName(),
  );
  return isExecutableFile(developmentFallback) ? developmentFallback : undefined;
}

/**
 * Owns the embedded Review server's lifetime: resolving its entry point,
 * minting its credentials, waiting for it to announce a validated endpoint, and
 * restarting it without moving that endpoint.
 */
export class ReviewServerSupervisor extends Disposable {
  private serverProcess: IReviewServerProcess | undefined;
  private processListeners = new DisposableStore();
  private restartTimer: ReturnType<typeof setTimeout> | undefined;
  private restartCount = 0;
  private stopping = false;
  private telemetryEnabled: boolean;

  /**
   * Credentials are minted once and reused for the life of the application, so
   * a restart keeps every renderer's existing connection valid. The port is
   * chosen by the OS on first start and then pinned for the same reason.
   */
  private readonly token = randomBytes(32).toString("base64url");
  private readonly instanceId = randomUUID();
  private port = 0;

  private readonly connected = new DeferredPromise<ReviewDesktopConnection>();
  private readonly readyTimeout: number;

  constructor(private readonly options: ReviewServerSupervisorOptions) {
    super();
    this.readyTimeout = options.readyTimeout ?? 30_000;
    this.telemetryEnabled = options.telemetryEnabled !== false;
  }

  setTelemetryEnabled(enabled: boolean): void {
    this.telemetryEnabled = enabled;
    this.serverProcess?.postMessage({ type: "telemetry-setting", enabled });
  }

  stageRustAnalyzer(): void {
    const sourcePath = resolveRustAnalyzerSource(this.options);
    if (!sourcePath) {
      this.options.logError("[Review Desktop] no installed rust-analyzer source is available to stage.");
      return;
    }
    if (!this.serverProcess) {
      this.options.logError("[Review Desktop] the Review server is unavailable for rust-analyzer staging.");
      return;
    }
    this.serverProcess.postMessage({ type: "stage-rust-analyzer", path: sourcePath });
  }

  /** Resolves once the server has announced an endpoint this process trusts. */
  whenConnected(): Promise<ReviewDesktopConnection> {
    return this.connected.p;
  }

  start(): void {
    if (this.stopping) return;
    let resolution: Promise<NodeJS.ProcessEnv> | undefined;
    try {
      resolution = this.options.resolveEnvironment?.();
    } catch (error) {
      this.handleEnvironmentResolutionFailure(error);
      return;
    }
    if (!resolution) {
      this.startWithEnvironment({});
      return;
    }
    void resolution.then(
      (environment) => this.startWithEnvironment(environment),
      (error) => this.handleEnvironmentResolutionFailure(error),
    );
  }

  private handleEnvironmentResolutionFailure(error: unknown): void {
    const reason = error instanceof Error ? error.message : String(error);
    this.options.logError(
      `[Review Desktop] unable to resolve the login-shell environment; starting with the application environment: ${reason}`,
    );
    this.startWithEnvironment({});
  }

  private startWithEnvironment(
    resolvedEnvironment: NodeJS.ProcessEnv,
  ): void {
    if (this.stopping) return;
    const serverEntry = resolveReviewServerEntry({
      isBuilt: this.options.isBuilt,
      appRoot: this.options.appRoot,
      serverEntryOverride: this.options.serverEntryOverride,
      join,
    });
    this.processListeners.dispose();
    this.processListeners = new DisposableStore();
    const serverProcess = this.options.createProcess();
    this.serverProcess = serverProcess;
    this.processListeners.add(serverProcess);

    const reader = new ReviewReadyEventReader({
      token: this.token,
      instanceId: this.instanceId,
    });
    let ready = false;
    this.processListeners.add(
      serverProcess.onStdout((value) => {
        this.options.logInfo(`[Review server] ${value.trimEnd()}`);
        if (ready) return;
        let connection: ReviewDesktopConnection | undefined;
        try {
          connection = reader.push(value);
        } catch (error) {
          this.failStartup(error);
          return;
        }
        if (!connection) return;
        ready = true;
        this.port = Number(new URL(connection.url).port);
        this.restartCount = 0;
        if (!this.connected.isSettled) {
          this.options.logInfo(
            `[Review Desktop] server ready at ${connection.url}`,
          );
          void this.connected.complete(connection);
        }
      }),
    );
    this.processListeners.add(
      serverProcess.onStderr((value) =>
        this.options.logError(`[Review server] ${value.trimEnd()}`),
      ),
    );

    let terminated = false;
    const onTerminated = (detail: string) => {
      if (terminated) return;
      terminated = true;
      this.options.logError(
        `[Review Desktop] server host terminated: ${detail}`,
      );
      this.serverProcess = undefined;
      this.processListeners.dispose();
      if (this.stopping) return;
      if (!ready && !this.connected.isSettled) {
        this.options.logError(
          "[Review Desktop] server host exited before announcing an endpoint.",
        );
      }
      const delay = REVIEW_SERVER_RESTART_DELAYS[this.restartCount++];
      if (delay === undefined) {
        this.failStartup(
          new Error(
            "The Review server exhausted its restart budget without becoming ready.",
          ),
        );
        return;
      }
      this.restartTimer = setTimeout(() => this.start(), delay);
    };
    this.processListeners.add(
      serverProcess.onExit((event) =>
        onTerminated(
          `exit ${event.code ?? "unknown"} (${event.signal ?? "no signal"})`,
        ),
      ),
    );
    this.processListeners.add(
      serverProcess.onCrash((event) =>
        onTerminated(`${event.reason} (${event.code ?? "unknown"})`),
      ),
    );

    const appPid = this.options.appPid ?? process.pid;
    const rustAnalyzerSource = resolveRustAnalyzerSource(this.options);
    const environment = createReviewServerEnvironment({
      applicationEnvironment: process.env,
      resolvedEnvironment,
      appVersion: this.options.appVersion,
      serverEntry,
      port: this.port,
      token: this.token,
      instanceId: this.instanceId,
      appPid,
      telemetryEnabled: this.telemetryEnabled,
      rustAnalyzerSource,
    });
    const started = serverProcess.start({
      type: "review-desktop-host",
      name: "Review Desktop host",
      entryPoint: "vs/review/electron-utility/reviewDesktopHostMain",
      parentLifecycleBound: appPid,
      env: environment,
    });
    if (!started) {
      onTerminated("launch failed");
      return;
    }
    if (!this.connected.isSettled) this.armReadyTimeout();
  }

  private armReadyTimeout(): void {
    void timeout(this.readyTimeout).then(() => {
      if (this.stopping || this.connected.isSettled) return;
      this.failStartup(
        new Error(
          `The Review server did not become ready within ${this.readyTimeout}ms.`,
        ),
      );
    });
  }

  private failStartup(error: unknown): void {
    const reason = error instanceof Error ? error : new Error(String(error));
    this.options.logError(`[Review Desktop] ${reason.message}`);
    if (!this.connected.isSettled) this.connected.error(reason);
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    const serverProcess = this.serverProcess;
    if (!serverProcess) return;
    serverProcess.postMessage({ type: "shutdown" });
    await Promise.race([
      new Promise<void>((resolve) => {
        const store = new DisposableStore();
        store.add(
          serverProcess.onExit(() => {
            store.dispose();
            resolve();
          }),
        );
        store.add(
          serverProcess.onCrash(() => {
            store.dispose();
            resolve();
          }),
        );
      }),
      timeout(2_000),
    ]);
    serverProcess.kill();
    this.processListeners.dispose();
    this.serverProcess = undefined;
  }

  override dispose(): void {
    void this.stop();
    super.dispose();
  }
}
