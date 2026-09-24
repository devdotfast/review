import { createHmac, randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";

import {
  jsonObject,
  jsonString,
  parseJsonText,
} from "@dev.fast/review-protocol";
import {
  processIsAlive,
  withFileLock,
  writeFileAtomic,
} from "@dev.fast/trace-core";
import { valid as validSemver } from "semver";

import { resolveAuthoringSessionRef } from "./agent-session-ref";
import { EMBEDDED_PROGRESSIVE_REVIEW_POSTHOG_KEY } from "./embedded-posthog-key";
import { readReviewPackageVersion as readReviewPackageVersionSync } from "./package-paths";
import {
  PROGRESSIVE_REVIEW_POSTHOG_HOST_ENV,
  PROGRESSIVE_REVIEW_POSTHOG_KEY_ENV,
  PostHogCaptureClient,
  type PostHogCaptureInput,
  type PostHogCaptureProperties,
} from "./posthog-capture-client";
import {
  type OpenSessionMarker,
  clearOpenSession,
  openSessionMarkersPath,
  recordOpenSession,
  takeOpenSessions,
} from "./session-markers";
import {
  type ReviewTelemetryInstallConfig,
  type ReviewTelemetrySurface,
  createTelemetryInstallConfig,
  isInternalTelemetry,
  isTelemetryOptedOut,
  legacyAppTelemetryConfigPath,
  normalizeTelemetryInstallConfig,
  reviewTelemetryChannel,
  reviewTelemetryConfigPath,
  reviewTelemetryEnvironment,
} from "./telemetry-config";
import { createTelemetryDebugSink } from "./telemetry-debug-sink";
import {
  type ReviewSessionAgent,
  type ReviewSessionOutcome,
} from "./ui-telemetry-events";

export const REVIEW_APP_VERSION_ENV = "DEV_FAST_REVIEW_APP_VERSION";

export const REVIEW_APP_SESSION_ID_ENV = "DEV_FAST_REVIEW_APP_SESSION_ID";

export type ReviewCliCommand = "review" | "map" | "status";

export type ReviewCliCommandPath =
  | "help"
  | "version"
  | "app.launch"
  | "app.pick"
  | "info"
  | "connect"
  | "instances"
  | "instances.use"
  | "instances.clear"
  | "migrate.apply"
  | "map.open"
  | "map.check"
  | "map.prune"
  | "map.push"
  | "map.fetch"
  | "login"
  | "logout"
  | "whoami"
  | "trace.store.create"
  | "trace.store.delete"
  | "trace.store.info"
  | "trace.install"
  | "trace.allow"
  | "trace.deny"
  | "trace.storage.use"
  | "trace.config.migrate"
  | "api"
  | "mcp"
  | "server.start"
  | "invalid";

export type ReviewTelemetryErrorName =
  | "usage_error"
  | "review_not_found"
  | "review_state_error"
  | "repository_error"
  | "desktop_connection_error"
  | "network_error"
  | "storage_error"
  | "index_error"
  | "process_error"
  | "unexpected_error";

export type ReviewTelemetryErrorCategory =
  | "user_input"
  | "local_state"
  | "dependency"
  | "transport"
  | "internal";

export type { ReviewSessionAgent, ReviewSessionOutcome };

export type ReviewTelemetryTab =
  | "review"
  | "commits"
  | "map"
  | "files"
  | "trace";

export type ReviewTabTelemetryReason =
  | "tab_change"
  | "visibility_hidden"
  | "pagehide"
  | "unmount";

export interface ReviewTabTelemetryEvent {
  tab: ReviewTelemetryTab;
  durationMs: number;
  reason: ReviewTabTelemetryReason;
  appSessionId: string;
}

export interface ReviewCommandTelemetryInput {
  command: ReviewCliCommandPath;
  commandRunId: string;
  exitCode: number;
  durationMs?: number;
  properties?: PostHogCaptureProperties;
  errorName?: ReviewTelemetryErrorName;
  errorCategory?: ReviewTelemetryErrorCategory;
}

export interface ReviewCommandStartedInput {
  command: ReviewCliCommandPath;
  commandRunId: string;
}

export interface ReviewTelemetryContext {
  reviewUuid?: string;
  presentationSessionId?: string;
}

export interface ReviewTelemetryCaptureClient {
  readonly enabled: boolean;
  /**
   * True for a client that prints events instead of sending them. The opt-out
   * stops sending, so it does not apply to such a client.
   */
  readonly ignoresOptOut?: boolean;
  capture(input: PostHogCaptureInput): Promise<void>;
  setDefaultProperties?(properties: PostHogCaptureProperties): void;
  flush?(deadlineMs?: number): Promise<void>;
  shutdown?(deadlineMs?: number): Promise<void>;
  discard?(): Promise<void>;
}

export interface ReviewTelemetryOptions {
  captureClient?: ReviewTelemetryCaptureClient;
  env?: NodeJS.ProcessEnv;
  installConfigPath?: string;
  legacyInstallConfigPath?: string;
  idFactory?: () => string;
  randomUUID?: () => string;
  now?: () => Date;
  fetch?: typeof fetch;
  timeoutMs?: number;
  openSessionMarkersPath?: string;
  /** The process recorded as owning open sessions; defaults to the parent. */
  openSessionOwnerPid?: number;
  /** Which process family sends this instance's events. */
  surface?: ReviewTelemetrySurface;
}

/** A single structured value a log line may carry beside its message. */
export type LoggerAttributeValue = string | number | boolean | null | undefined;

export type LoggerAttributes = Record<string, LoggerAttributeValue>;

export interface Logger {
  trace(message: string, attributes?: LoggerAttributes): void;
  debug(message: string, attributes?: LoggerAttributes): void;
  info(message: string, attributes?: LoggerAttributes): void;
  warn(message: string, attributes?: LoggerAttributes): void;
  error(message: string, attributes?: LoggerAttributes): void;
}

const noop = () => undefined;

const noopLogger: Logger = {
  trace: noop,
  debug: noop,
  info: noop,
  warn: noop,
  error: noop,
};

const sharedInstallConfigs = new Map<string, ReviewTelemetryInstallConfig>();

export function createLogger(_scope: string): Logger {
  return noopLogger;
}

/** The telemetry surface a CLI command run drives; tests fake this contract. */
export type ReviewCommandTelemetry = Pick<
  ReviewTelemetry,
  | "createCommandRunId"
  | "setSurface"
  | "captureInstallationCreated"
  | "captureCommandStarted"
  | "captureCommandSucceeded"
  | "captureCommandFailed"
  | "shutdown"
>;

export class ReviewTelemetry {
  private readonly captureClient: ReviewTelemetryCaptureClient;
  private readonly env: NodeJS.ProcessEnv;
  private readonly installConfigPath: string;
  private readonly legacyInstallConfigPath: string;
  private readonly openSessionMarkersPath: string;
  private readonly openSessionOwnerPid: number;
  private readonly idFactory: () => string;
  private readonly commandRunIdFactory: () => string;
  private readonly now: () => Date;
  private surface: ReviewTelemetrySurface;
  private readonly packageVersion: string;
  private installConfig: ReviewTelemetryInstallConfig | undefined;

  constructor(options: ReviewTelemetryOptions = {}) {
    this.env = options.env ?? process.env;
    this.captureClient =
      options.captureClient ??
      createTelemetryDebugSink(this.env) ??
      (options.fetch
        ? directCaptureClient(this.env, options.fetch, options.timeoutMs)
        : PostHogCaptureClient.fromEnv(this.env));
    this.installConfigPath =
      options.installConfigPath ?? reviewTelemetryConfigPath(this.env);
    this.legacyInstallConfigPath =
      options.legacyInstallConfigPath ?? legacyAppTelemetryConfigPath(this.env);
    this.openSessionMarkersPath =
      options.openSessionMarkersPath ?? openSessionMarkersPath(this.env);
    this.openSessionOwnerPid = options.openSessionOwnerPid ?? process.ppid;
    this.commandRunIdFactory = options.randomUUID ?? randomUUID;
    this.idFactory = options.idFactory ?? this.commandRunIdFactory;
    this.now = options.now ?? (() => new Date());
    this.surface = options.surface ?? "cli";
    this.packageVersion = readReviewPackageVersionSync(import.meta.url);
  }

  static fromEnv(
    env: NodeJS.ProcessEnv = process.env,
    options: Omit<ReviewTelemetryOptions, "env"> = {},
  ): ReviewTelemetry {
    return new ReviewTelemetry({ ...options, env });
  }

  async getInstallationId(): Promise<string> {
    return (await this.loadInstallConfig()).installationId;
  }

  createCommandRunId(): string {
    return this.commandRunIdFactory();
  }

  /** Sets the surface for every later event, envelope included. */
  setSurface(surface: ReviewTelemetrySurface): void {
    this.surface = surface;
  }

  async setEnabled(enabled: boolean): Promise<void> {
    await this.withConfigLock(async () => {
      const config = await this.readOrCreateInstallConfig();
      config.enabled = enabled;
      this.writeInstallConfig(config);
      this.installConfig = config;
      sharedInstallConfigs.set(this.installConfigPath, config);
    }, 5_000);

    if (!enabled) {
      await this.captureClient.discard?.().catch(() => undefined);
      // Sessions opened before the opt-out must not end as abnormal when
      // telemetry comes back weeks later.
      await this.lockOpenSessions(() =>
        rmSync(this.openSessionMarkersPath, { force: true }),
      );
    }
  }

  async setInternal(internal: boolean): Promise<void> {
    await this.withConfigLock(async () => {
      const config = await this.readOrCreateInstallConfig();
      config.internal = internal;
      this.writeInstallConfig(config);
      this.installConfig = config;
      sharedInstallConfigs.set(this.installConfigPath, config);
    }, 5_000);
  }

  /** The common properties every event carries; bug reports embed them. */
  async envelope(): Promise<PostHogCaptureProperties> {
    return this.commonProperties(await this.loadInstallConfig());
  }

  async captureInstallationCreated(): Promise<void> {
    await this.announceOnce("installationCreatedSent", async (config) => {
      await this.captureClient.capture({
        event: "review_installation_created",
        distinctId: config.installationId,
        properties: await this.commonProperties(config),
      });
    });
  }

  /**
   * Sends an event exactly once per identity, guarded by a persisted flag on
   * the install config. The flag is persisted before the send completes:
   * under-counting an install is recoverable, announcing one machine twice
   * is not. A printed event is not a sent event, so the debug sink leaves
   * the flag alone (it still always sends, ignoring opt-out as today).
   */
  private async announceOnce(
    flag: "installationCreatedSent" | "firstReviewPresentedSent",
    send: (config: ReviewTelemetryInstallConfig) => Promise<void>,
  ): Promise<void> {
    if (!this.captureClient.enabled || this.optedOut()) return;
    await this.withConfigLock(async () => {
      const config = await this.readOrCreateInstallConfig();
      this.installConfig = config;
      sharedInstallConfigs.set(this.installConfigPath, config);

      if (this.optedOut(config) || config[flag]) return;

      if (!this.captureClient.ignoresOptOut) {
        config[flag] = true;
        this.writeInstallConfig(config);
      }

      await send(config);
    });
  }

  async captureCommandSucceeded(
    input: ReviewCommandTelemetryInput,
  ): Promise<void> {
    await this.captureCommandEvent("review_command_succeeded", input);
  }

  async captureCommandFailed(
    input: ReviewCommandTelemetryInput,
  ): Promise<void> {
    await this.captureCommandEvent("review_command_failed", input);
  }

  async captureCommandStarted(input: ReviewCommandStartedInput): Promise<void> {
    const properties: PostHogCaptureProperties = {
      command_path: input.command,
      command_run_id: input.commandRunId,
      agent_kind: this.sessionAgent(),
    };

    await this.captureEvent("review_command_started", properties);
  }

  async captureReviewDeleted(): Promise<void> {
    await this.captureEvent("review_review_deleted");
  }

  /**
   * The reaper deleted a dismissed review. No reader is present, so this is a
   * server event rather than a UI one.
   */
  async captureReviewReaped(input: { retentionDays: number }): Promise<void> {
    await this.captureEvent("review_review_reaped", {
      retention_days: input.retentionDays,
    });
  }

  async captureTabViewed(
    event: ReviewTabTelemetryEvent,
    context?: ReviewTelemetryContext,
  ): Promise<void> {
    await this.captureEvent(
      "review_tab_viewed",
      {
        tab: event.tab,
        duration_ms: event.durationMs,
        reason: event.reason,
        source: "review_app",
        app_session_id: event.appSessionId,
      },
      context,
    );
  }

  /**
   * A session start leaves a marker until its end arrives, so a session the
   * process never closed can be reported as abnormal on the next launch. The
   * marker is cleared before the end is sent: a lost marker for a sent end
   * is harmless, a stale one would report the session ended twice.
   */
  async captureUiEvent(
    event: string,
    properties: Record<string, string | number | boolean>,
    context?: ReviewTelemetryContext,
  ): Promise<void> {
    const reviewUuid = context?.reviewUuid;
    const presentationSessionId = context?.presentationSessionId;
    const inSession = reviewUuid && presentationSessionId;

    if (inSession && event === "review_session_started") {
      const marker: OpenSessionMarker = {
        presentationSessionId,
        reviewUuid,
        startedAt: this.now().getTime(),
        ownerPid: this.openSessionOwnerPid,
      };

      const appSessionId = nonEmpty(properties.app_session_id?.toString());

      if (appSessionId) marker.appSessionId = appSessionId;
      await this.updateOpenSessions(() =>
        recordOpenSession(this.openSessionMarkersPath, marker),
      );
    } else if (inSession && event === "review_session_ended") {
      await this.updateOpenSessions(() =>
        clearOpenSession(this.openSessionMarkersPath, presentationSessionId),
      );
    }

    await this.captureEvent(
      event,
      {
        source: "review_app",
        ...properties,
      },
      context,
    );

    if (inSession && event === "review_review_presented") {
      await this.captureFirstReviewPresented(context).catch(() => undefined);
    }
  }

  /**
   * Reports sessions an earlier app launch never closed as abnormal ends.
   * Sessions of the current launch survive a server restart untouched. Call
   * once at startup.
   */
  async reconcileOpenSessions(): Promise<void> {
    const currentAppSessionId = nonEmpty(this.env[REVIEW_APP_SESSION_ID_ENV]);
    const ended: OpenSessionMarker[] = [];

    await this.updateOpenSessions(() => {
      for (const marker of takeOpenSessions(this.openSessionMarkersPath)) {
        const stillOpen =
          (currentAppSessionId !== undefined &&
            marker.appSessionId === currentAppSessionId) ||
          (marker.ownerPid !== undefined && processIsAlive(marker.ownerPid));

        if (stillOpen) {
          recordOpenSession(this.openSessionMarkersPath, marker);
        } else {
          ended.push(marker);
        }
      }
    });

    for (const marker of ended) {
      const outcome: ReviewSessionOutcome = "abnormal";

      // Overrides the envelope's app session: the session belonged to an
      // earlier launch, and an unknown one is dropped rather than misattributed.
      const properties: PostHogCaptureProperties = {
        source: "review_app",
        outcome,
        app_session_id: marker.appSessionId,
      };

      await this.captureEvent("review_session_ended", properties, {
        reviewUuid: marker.reviewUuid,
        presentationSessionId: marker.presentationSessionId,
      });
    }
  }

  async captureEvent(
    event: string,
    properties: PostHogCaptureProperties = {},
    context?: ReviewTelemetryContext,
  ): Promise<void> {
    await this.withTelemetry(async (config) => {
      const common = await this.commonProperties(config);
      this.captureClient.setDefaultProperties?.(common);
      await this.captureClient.capture({
        event,
        distinctId: config.installationId,
        properties: {
          ...common,
          ...properties,
          ...correlationProperties(config.installationId, context),
        },
      });
    });
  }

  private async captureFirstReviewPresented(
    context: ReviewTelemetryContext,
  ): Promise<void> {
    await this.announceOnce("firstReviewPresentedSent", async () => {
      await this.captureEvent(
        "review_first_review_presented",
        { source: "review_app" },
        context,
      );
    });
  }

  /**
   * Marker I/O is best effort, skipped entirely when telemetry is off, and
   * locked because concurrent Desktops share the file.
   */
  private async updateOpenSessions(update: () => void): Promise<void> {
    if (!(await this.isEnabled())) return;
    await this.lockOpenSessions(update);
  }

  private async lockOpenSessions(update: () => void): Promise<void> {
    try {
      await withFileLock(
        `${this.openSessionMarkersPath}.lock`,
        {
          retryMs: 10,
          staleMs: 30_000,
          timeoutMs: 250,
          unownedGraceMs: 1_000,
          heartbeatMs: 5_000,
        },
        async () => update(),
      );
    } catch {
      // A full disk must not break the review.
    }
  }

  async flush(deadlineMs = 1_000): Promise<void> {
    if (!(await this.isEnabled())) return;
    await this.captureClient.flush?.(deadlineMs).catch(() => undefined);
  }

  async shutdown(deadlineMs = 1_000): Promise<void> {
    if (!(await this.isEnabled())) return;
    await this.captureClient.shutdown?.(deadlineMs).catch(() => undefined);
  }

  private async captureCommandEvent(
    event: "review_command_succeeded" | "review_command_failed",
    input: ReviewCommandTelemetryInput,
  ): Promise<void> {
    const properties: PostHogCaptureProperties = {
      command_path: input.command,
      exit_code: input.exitCode,
    };

    if (input.durationMs !== undefined)
      properties.duration_ms = input.durationMs;
    Object.assign(properties, input.properties);
    properties.command_run_id = input.commandRunId;

    if (input.errorName) properties.error_name = input.errorName;

    if (input.errorCategory) properties.error_category = input.errorCategory;

    await this.captureEvent(event, properties);
  }

  private async withTelemetry(
    fn: (config: ReviewTelemetryInstallConfig) => Promise<void>,
  ): Promise<void> {
    if (!this.captureClient.enabled || this.optedOut()) return;

    try {
      const config = await this.loadInstallConfig();

      if (this.optedOut(config)) return;
      await fn(config);
    } catch {
      // Telemetry is best effort and must never affect Review behavior.
    }
  }

  private async loadInstallConfig(): Promise<ReviewTelemetryInstallConfig> {
    const shared = sharedInstallConfigs.get(this.installConfigPath);

    if (shared) {
      this.installConfig = shared;

      return shared;
    }

    if (this.installConfig) return this.installConfig;
    await this.withConfigLock(async () => {
      this.installConfig = await this.readOrCreateInstallConfig();
      sharedInstallConfigs.set(this.installConfigPath, this.installConfig);
    });

    return (
      this.installConfig ??
      createTelemetryInstallConfig(this.idFactory(), this.now)
    );
  }

  private optedOut(config?: ReviewTelemetryInstallConfig): boolean {
    if (this.captureClient.ignoresOptOut) return false;

    return isTelemetryOptedOut(this.env, config);
  }

  private async isEnabled(): Promise<boolean> {
    if (!this.captureClient.enabled || this.optedOut()) {
      return false;
    }

    try {
      const config = normalizeTelemetryInstallConfig(
        parseJsonText(await readFile(this.installConfigPath, "utf8")),
        this.now,
      );

      if (!config) return true;
      this.installConfig = config;
      sharedInstallConfigs.set(this.installConfigPath, config);

      return !this.optedOut(config);
    } catch {
      return true;
    }
  }

  private async readOrCreateInstallConfig(): Promise<ReviewTelemetryInstallConfig> {
    try {
      const parsed = parseJsonText(
        await readFile(this.installConfigPath, "utf8"),
      );

      const config = normalizeTelemetryInstallConfig(parsed, this.now);

      if (config) {
        if (jsonObject(parsed)?.internal !== config.internal) {
          try {
            this.writeInstallConfig(config);
          } catch {
            // Keep the existing identity when a best-effort migration fails.
          }
        }

        return config;
      }
    } catch {
      // Missing or invalid config gets replaced below.
    }

    // The legacy file holds the stable identity; preview counts separately.
    const legacyInstallId =
      reviewTelemetryChannel(this.env) === "preview"
        ? undefined
        : await this.readLegacyInstallId();

    const config = createTelemetryInstallConfig(
      legacyInstallId ?? this.idFactory(),
      this.now,
    );

    // A legacy id is by definition an existing installation: never announce
    // it as newly created.
    if (legacyInstallId) config.installationCreatedSent = true;

    this.writeInstallConfig(config);

    return config;
  }

  private async readLegacyInstallId(): Promise<string | undefined> {
    try {
      const installId = jsonString(
        jsonObject(
          parseJsonText(await readFile(this.legacyInstallConfigPath, "utf8")),
        )?.installId,
      );

      return installId ? installId : undefined;
    } catch {
      return undefined;
    }
  }

  private writeInstallConfig(config: ReviewTelemetryInstallConfig): void {
    writeFileAtomic(
      this.installConfigPath,
      `${JSON.stringify(config, null, 2)}\n`,
      "utf8",
    );
  }

  private async withConfigLock(
    operation: () => Promise<void>,
    timeoutMs = 250,
  ): Promise<void> {
    const outcome = await withFileLock(
      `${this.installConfigPath}.lock`,
      {
        retryMs: 10,
        staleMs: 30_000,
        timeoutMs,
        unownedGraceMs: 1_000,
        heartbeatMs: 5_000,
      },
      operation,
    );

    if (!outcome.acquired) {
      throw new Error("Timed out while updating the telemetry configuration");
    }
  }

  private async commonProperties(
    config: Pick<ReviewTelemetryInstallConfig, "internal">,
  ): Promise<PostHogCaptureProperties> {
    const appVersion = reviewAppVersion(this.env);
    const appSessionId = nonEmpty(this.env[REVIEW_APP_SESSION_ID_ENV]);

    const properties: PostHogCaptureProperties = {
      cli_version: this.packageVersion,
      // Kept for one release while the DAU/WAU insights still read it.
      version: this.packageVersion,
      channel: reviewTelemetryChannel(this.env),
      environment: reviewTelemetryEnvironment(this.env, config),
      surface: this.surface,
      node_major: Number(process.versions.node.split(".", 1)[0]),
      platform: process.platform,
      arch: process.arch,
      os_version: os.release(),
      ci: Boolean(this.env.CI),
      internal: isInternalTelemetry(this.env, config),
    };

    if (appVersion) properties.app_version = appVersion;

    if (appSessionId) properties.app_session_id = appSessionId;

    return properties;
  }

  private sessionAgent(): ReviewSessionAgent {
    const harness = resolveAuthoringSessionRef(this.env)?.harness;

    if (harness === "codex") return "codex";

    if (harness === "claude-code") return "claude";

    if (harness === "pi") return "pi";

    return "other";
  }
}

export { isTelemetryOptedOut } from "./telemetry-config";

function correlationProperties(
  installationId: string,
  context: ReviewTelemetryContext | undefined,
): PostHogCaptureProperties {
  const properties: PostHogCaptureProperties = {};

  if (!context) return properties;

  if (context.reviewUuid) {
    properties.review_id = opaqueCorrelationId(
      "rv_",
      installationId,
      "review",
      context.reviewUuid,
    );
  }

  if (context.presentationSessionId) {
    properties.presentation_id = opaqueCorrelationId(
      "pr_",
      installationId,
      "presentation",
      context.presentationSessionId,
    );
  }

  return properties;
}

function opaqueCorrelationId(
  prefix: "rv_" | "pr_",
  installationId: string,
  namespace: "review" | "presentation",
  value: string,
): string {
  const digest = createHmac("sha256", installationId)
    .update(`dev.fast.review.telemetry.v1\0${namespace}\0${value}`)
    .digest()
    .subarray(0, 16)
    .toString("base64url");

  return `${prefix}${digest}`;
}

function directCaptureClient(
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch,
  timeoutMs: number | undefined,
): PostHogCaptureClient {
  return new PostHogCaptureClient({
    apiKey:
      nonEmpty(env[PROGRESSIVE_REVIEW_POSTHOG_KEY_ENV]) ??
      nonEmpty(env.DEV_FAST_POSTHOG_KEY) ??
      nonEmpty(env.POSTHOG_KEY) ??
      EMBEDDED_PROGRESSIVE_REVIEW_POSTHOG_KEY,
    host:
      nonEmpty(env[PROGRESSIVE_REVIEW_POSTHOG_HOST_ENV]) ??
      nonEmpty(env.DEV_FAST_POSTHOG_HOST) ??
      nonEmpty(env.POSTHOG_HOST),
    fetch: fetchImpl,
    timeoutMs,
  });
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();

  return trimmed ? trimmed : undefined;
}

function reviewAppVersion(env: NodeJS.ProcessEnv): string | undefined {
  const value = nonEmpty(env[REVIEW_APP_VERSION_ENV]);

  return value && validSemver(value) ? value : undefined;
}
