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
import { exceptionProperties } from "./exception-telemetry";
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
  launchEnvelope,
  openSessionMarkersPath,
  recordOpenSession,
  takeOpenSessions,
} from "./session-markers";
import {
  type ReviewTelemetryInstallConfig,
  type ReviewTelemetrySurface,
  createTelemetryInstallConfig,
  installAgeDays,
  isInternalTelemetry,
  isTelemetryOptedOut,
  isUuidV7,
  legacyAppTelemetryConfigPath,
  normalizeTelemetryInstallConfig,
  reviewTelemetryChannel,
  reviewTelemetryConfigPath,
  reviewTelemetryEnvironment,
  telemetryInstallConfigNeedsWrite,
} from "./telemetry-config";
import { createTelemetryDebugSink } from "./telemetry-debug-sink";
import {
  type ReviewSessionAgent,
  type ReviewSessionOutcome,
} from "./ui-telemetry-events";

export const REVIEW_APP_VERSION_ENV = "DEV_FAST_REVIEW_APP_VERSION";

export const REVIEW_APP_SESSION_ID_ENV = "DEV_FAST_REVIEW_APP_SESSION_ID";

/** Install config fields announceOnce guards. */
type AnnouncedField =
  | "installationCreatedSent"
  | "firstReviewPresentedSent"
  | "accountAlias";

/**
 * A fixed namespace, not the installation id: a key per install would give
 * every install a different alias for one account and defeat the linking.
 * The hash is one-way; the account id itself is never sent.
 */
const ACCOUNT_ALIAS_KEY = "dev.fast.review.telemetry.account.v1";

/** `gh_` + the first 16 bytes of HMAC-SHA256(namespace, account id). */
export function accountAlias(accountId: string): string {
  const digest = createHmac("sha256", ACCOUNT_ALIAS_KEY)
    .update(accountId)
    .digest()
    .subarray(0, 16)
    .toString("base64url");

  return `gh_${digest}`;
}

/** A tool name is program-owned, but only an identifier is ever sent. */
const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;

export interface ReviewToolCall {
  tool: string;
  via: "api" | "mcp";
  ok: boolean;
  durationMs: number;
}

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
  | "captureUiEvent"
  | "captureToolCalled"
  | "captureAccountAlias"
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

  /**
   * Whether events leave this machine right now: a real client, no opt-out.
   * The debug sink prints instead of sending, so it answers false.
   */
  async sendsEvents(): Promise<boolean> {
    if (this.captureClient.ignoresOptOut) return false;

    return this.isEnabled();
  }

  /** The common properties every event carries; bug reports embed them. */
  async envelope(): Promise<PostHogCaptureProperties> {
    return this.commonProperties(await this.loadInstallConfig());
  }

  async captureInstallationCreated(): Promise<void> {
    await this.announceOnce("installationCreatedSent", true, async (config) => {
      await this.captureClient.capture({
        event: "review_installation_created",
        distinctId: config.installationId,
        properties: await this.commonProperties(config),
      });
    });
  }

  /**
   * Link this installation to a signed-in account by a one-way hash, so
   * several installs by one person count as one; the raw account id never
   * leaves this process. Once per installation: the first account wins. A
   * later login to another account sends nothing, because a second alias
   * would merge two accounts, and every later install of either, into one
   * PostHog person. The account is looked up only when an alias would be
   * sent, so a login with telemetry off makes no network call.
   */
  async captureAccountAlias(
    lookupAccountId: () => Promise<string>,
  ): Promise<void> {
    if (!(await this.isEnabled()) || this.installConfig?.accountAlias) return;

    const alias = accountAlias(await lookupAccountId());

    await this.announceOnce("accountAlias", alias, async (config) => {
      await this.captureClient.capture({
        event: "$create_alias",
        distinctId: config.installationId,
        // PostHog merges identities only while processing persons, so the
        // alias itself must turn processing on.
        properties: {
          ...(await this.commonProperties(config)),
          alias,
          $process_person_profile: true,
        },
      });
    });
  }

  /**
   * Sends an event exactly once per installation, guarded by a persisted
   * install config field that `value` fills. The field is persisted before
   * the send completes: under-counting
   * is recoverable, announcing twice is not. A printed event is not a sent
   * event, so the debug sink leaves the field alone (it still always sends,
   * ignoring opt-out as today).
   */
  private async announceOnce<Field extends AnnouncedField>(
    field: Field,
    value: NonNullable<ReviewTelemetryInstallConfig[Field]>,
    send: (config: ReviewTelemetryInstallConfig) => Promise<void>,
  ): Promise<void> {
    if (!this.captureClient.enabled || this.optedOut()) return;
    await this.withConfigLock(async () => {
      const config = await this.readOrCreateInstallConfig();
      this.installConfig = config;
      sharedInstallConfigs.set(this.installConfigPath, config);

      if (this.optedOut(config) || config[field]) return;

      if (!this.captureClient.ignoresOptOut) {
        config[field] = value;
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

  async captureToolCalled(call: ReviewToolCall): Promise<void> {
    await this.captureEvent("review_mcp_tool_called", {
      tool: TOOL_NAME_PATTERN.test(call.tool) ? call.tool : "other",
      via: call.via,
      ok: call.ok,
      duration_ms: Math.max(0, Math.round(call.durationMs)),
    });
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

  /**
   * A tab dwell period ended. Time on the files tab is also the diff dwell,
   * so it doubles as `review_diff_viewed` without a second client beacon.
   */
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

    if (event.tab !== "files") return;

    await this.captureEvent(
      "review_diff_viewed",
      {
        duration_ms: event.durationMs,
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
    occurredAt = this.now().getTime(),
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

      if (await this.isEnabled()) {
        // Read before the lock: the envelope may wait on the config lock, and
        // every Desktop on this home shares the markers lock.
        const envelope = launchEnvelope(
          await this.envelope().catch(() => ({})),
        );

        if (envelope) marker.envelope = envelope;
        await this.lockOpenSessions(() =>
          recordOpenSession(this.openSessionMarkersPath, marker),
        );
      }
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
      occurredAt,
    );

    if (inSession && event === "review_review_presented") {
      await this.captureFirstReviewPresented(context).catch(() => undefined);
    }

    // PostHog error tracking groups on $exception; the custom event stays for
    // one release so the existing error insights keep working.
    if (event !== "review_client_error") return;
    const exception = exceptionProperties(properties);

    if (!exception) return;
    await this.captureEvent(
      "$exception",
      { source: "review_app", ...properties, ...exception },
      context,
    );
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

      // Overrides the envelope with the launch the session belonged to. An
      // unknown app session is dropped rather than misattributed; a legacy
      // marker without a stored envelope keeps the current one.
      const launch = marker.envelope && {
        app_version: undefined,
        ...marker.envelope,
      };

      const properties: PostHogCaptureProperties = {
        ...launch,
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

  /**
   * `occurredAt` defaults to the call, before any await: config and marker
   * locks must not reorder events that happened in order.
   */
  async captureEvent(
    event: string,
    properties: PostHogCaptureProperties = {},
    context?: ReviewTelemetryContext,
    occurredAt = this.now().getTime(),
  ): Promise<void> {
    await this.withTelemetry(async (config) => {
      const common = await this.commonProperties(config);
      this.captureClient.setDefaultProperties?.(common);
      await this.captureClient.capture({
        event,
        distinctId: config.installationId,
        properties: withSessionId({
          ...common,
          ...properties,
          ...correlationProperties(config.installationId, context),
        }),
        timestamp: occurredAt,
      });
    });
  }

  private async captureFirstReviewPresented(
    context: ReviewTelemetryContext,
  ): Promise<void> {
    await this.announceOnce("firstReviewPresentedSent", true, async () => {
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
  private async updateOpenSessions(
    update: () => void | Promise<void>,
  ): Promise<void> {
    if (!(await this.isEnabled())) return;
    await this.lockOpenSessions(update);
  }

  private async lockOpenSessions(
    update: () => void | Promise<void>,
  ): Promise<void> {
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
      const parsed = parseJsonText(
        await readFile(this.installConfigPath, "utf8"),
      );

      const config = normalizeTelemetryInstallConfig(parsed, this.now);

      if (!config) return true;

      // A config that still needs its one-time write is left for
      // readOrCreateInstallConfig, which persists what it backfills.
      if (!telemetryInstallConfigNeedsWrite(parsed, config)) {
        this.installConfig = config;
        sharedInstallConfigs.set(this.installConfigPath, config);
      }

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
        if (telemetryInstallConfigNeedsWrite(parsed, config)) {
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
    config: Pick<
      ReviewTelemetryInstallConfig,
      "internal" | "accountAlias" | "createdAt"
    >,
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
      install_age_days: installAgeDays(config, this.now()),
      // Anonymous until an account is aliased; then PostHog keeps a person.
      $process_person_profile: config.accountAlias !== undefined,
    };

    if (appVersion) properties.app_version = appVersion;

    if (appSessionId) properties.app_session_id = appSessionId;

    return withSessionId(properties);
  }

  private sessionAgent(): ReviewSessionAgent {
    return reviewSessionAgent(this.env);
  }
}

/** The agent harness this process runs under, from its session environment. */
export function reviewSessionAgent(env: NodeJS.ProcessEnv): ReviewSessionAgent {
  const harness = resolveAuthoringSessionRef(env)?.harness;

  if (harness === "codex") return "codex";

  if (harness === "claude-code") return "claude";

  if (harness === "pi") return "pi";

  return "other";
}

export { isTelemetryOptedOut } from "./telemetry-config";

/**
 * `$session_id` always mirrors the event's final `app_session_id`, which an
 * event may override (a recovered end carries the launch that died). An id
 * that is not a UUIDv7, such as a canvas's own fallback id or one from a
 * launch before v7 ids, leaves `$session_id` out.
 */
function withSessionId(
  properties: PostHogCaptureProperties,
): PostHogCaptureProperties {
  const { $session_id: _stale, ...rest } = properties;

  return isUuidV7(rest.app_session_id)
    ? { ...rest, $session_id: rest.app_session_id }
    : rest;
}

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
