import { createHmac, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { withFileLock, writeFileAtomic } from "@dev.fast/trace-core";
import {
  jsonObject,
  jsonString,
  parseJsonText,
} from "@dev.fast/whiteboard-protocol";
import { valid as validSemver } from "semver";

import { resolveAuthoringSessionRef } from "./agent-session-ref";
import { EMBEDDED_PROGRESSIVE_WHITEBOARD_POSTHOG_KEY } from "./embedded-posthog-key";
import { findWhiteboardPackageRoot } from "./package-paths";
import {
  PROGRESSIVE_WHITEBOARD_POSTHOG_HOST_ENV,
  PROGRESSIVE_WHITEBOARD_POSTHOG_KEY_ENV,
  PostHogCaptureClient,
  type PostHogCaptureInput,
  type PostHogCaptureProperties,
} from "./posthog-capture-client";
import {
  type WhiteboardTelemetryInstallConfig,
  createTelemetryInstallConfig,
  isInternalTelemetry,
  isTelemetryOptedOut,
  legacyAppTelemetryConfigPath,
  normalizeTelemetryInstallConfig,
  whiteboardTelemetryConfigPath,
} from "./telemetry-config";
import { createTelemetryDebugSink } from "./telemetry-debug-sink";

export const WHITEBOARD_APP_VERSION_ENV = "DEV_FAST_WHITEBOARD_APP_VERSION";

export type WhiteboardCliCommand = "review" | "map" | "status";

export type WhiteboardCliCommandPath =
  | "help"
  | "version"
  | "app.launch"
  | "app.pick"
  | "info"
  | "connect"
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
  | "invalid";

export type WhiteboardTelemetryErrorName =
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

export type WhiteboardTelemetryErrorCategory =
  | "user_input"
  | "local_state"
  | "dependency"
  | "transport"
  | "internal";

export type WhiteboardSourceKind =
  | "pull_request"
  | "git_branch"
  | "git_commit"
  | "jj_bookmark"
  | "jj_change";

export type WhiteboardSessionAgent = "codex" | "claude" | "pi" | "other";

// The reader dismisses a review; approve and request-changes left with the
// comment submission loop.
export type WhiteboardSessionOutcome = "dismissed";

export type WhiteboardTelemetryTab =
  | "review"
  | "commits"
  | "map"
  | "files"
  | "trace";

export type WhiteboardTabTelemetryReason =
  | "tab_change"
  | "visibility_hidden"
  | "pagehide"
  | "unmount";

export interface WhiteboardTabTelemetryEvent {
  tab: WhiteboardTelemetryTab;
  durationMs: number;
  reason: WhiteboardTabTelemetryReason;
  appSessionId: string;
}

export interface WhiteboardCommandTelemetryInput {
  command: WhiteboardCliCommandPath;
  commandRunId: string;
  exitCode: number;
  durationMs?: number;
  properties?: PostHogCaptureProperties;
  errorName?: WhiteboardTelemetryErrorName;
  errorCategory?: WhiteboardTelemetryErrorCategory;
}

export interface WhiteboardCommandStartedInput {
  command: WhiteboardCliCommandPath;
  commandRunId: string;
}

export interface WhiteboardTelemetryContext {
  sessionId?: string;
  presentationSessionId?: string;
}

export interface WhiteboardSessionStartedInput {
  sourceKind?: WhiteboardSourceKind;
  agentKind?: WhiteboardSessionAgent;
  mode?: "pr" | "refs" | "branch";
  appSessionId?: string;
  sessionId?: string;
  presentationSessionId?: string;
}

export interface WhiteboardSessionEndedInput extends WhiteboardSessionStartedInput {
  outcome: WhiteboardSessionOutcome;
  durationMs: number;
}

export interface WhiteboardTelemetryCaptureClient {
  readonly enabled: boolean;
  /**
   * True for a client that prints events instead of sending them. The opt-out
   * stops sending, so it does not apply to such a client.
   */
  readonly ignoresOptOut?: boolean;
  capture(input: PostHogCaptureInput): Promise<void>;
  flush?(deadlineMs?: number): Promise<void>;
  shutdown?(deadlineMs?: number): Promise<void>;
  discard?(): Promise<void>;
}

export interface WhiteboardTelemetryOptions {
  captureClient?: WhiteboardTelemetryCaptureClient;
  env?: NodeJS.ProcessEnv;
  installConfigPath?: string;
  legacyInstallConfigPath?: string;
  idFactory?: () => string;
  randomUUID?: () => string;
  now?: () => Date;
  fetch?: typeof fetch;
  timeoutMs?: number;
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

const sharedInstallConfigs = new Map<
  string,
  WhiteboardTelemetryInstallConfig
>();

export function createLogger(_scope: string): Logger {
  return noopLogger;
}

/** The telemetry surface a CLI command run drives; tests fake this contract. */
export type WhiteboardCommandTelemetry = Pick<
  WhiteboardTelemetry,
  | "createCommandRunId"
  | "captureInstallationCreated"
  | "captureCommandStarted"
  | "captureCommandSucceeded"
  | "captureCommandFailed"
  | "shutdown"
>;

export class WhiteboardTelemetry {
  private readonly captureClient: WhiteboardTelemetryCaptureClient;
  private readonly env: NodeJS.ProcessEnv;
  private readonly installConfigPath: string;
  private readonly legacyInstallConfigPath: string;
  private readonly idFactory: () => string;
  private readonly commandRunIdFactory: () => string;
  private readonly now: () => Date;
  private installConfig: WhiteboardTelemetryInstallConfig | undefined;
  private packageVersion: Promise<string> | undefined;

  constructor(options: WhiteboardTelemetryOptions = {}) {
    this.env = options.env ?? process.env;
    this.captureClient =
      options.captureClient ??
      createTelemetryDebugSink(this.env) ??
      (options.fetch
        ? directCaptureClient(this.env, options.fetch, options.timeoutMs)
        : PostHogCaptureClient.fromEnv(this.env));
    this.installConfigPath =
      options.installConfigPath ?? whiteboardTelemetryConfigPath(this.env);
    this.legacyInstallConfigPath =
      options.legacyInstallConfigPath ?? legacyAppTelemetryConfigPath(this.env);
    this.commandRunIdFactory = options.randomUUID ?? randomUUID;
    this.idFactory = options.idFactory ?? this.commandRunIdFactory;
    this.now = options.now ?? (() => new Date());
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): WhiteboardTelemetry {
    return new WhiteboardTelemetry({ env });
  }

  async getInstallationId(): Promise<string> {
    return (await this.loadInstallConfig()).installationId;
  }

  createCommandRunId(): string {
    return this.commandRunIdFactory();
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
    }
  }

  async captureInstallationCreated(): Promise<void> {
    if (!this.captureClient.enabled || this.optedOut()) return;
    await this.withConfigLock(async () => {
      const config = await this.readOrCreateInstallConfig();
      this.installConfig = config;
      sharedInstallConfigs.set(this.installConfigPath, config);

      if (this.optedOut(config) || config.installationCreatedSent) {
        return;
      }

      await this.captureClient.capture({
        event: "review_installation_created",
        distinctId: config.installationId,
        properties: await this.commonProperties(config),
      });

      // A printed event is not a sent event. Persisting the flag here would
      // suppress the real installation event on this machine forever.
      if (this.captureClient.ignoresOptOut) return;
      config.installationCreatedSent = true;
      this.writeInstallConfig(config);
    });
  }

  async captureCommandSucceeded(
    input: WhiteboardCommandTelemetryInput,
  ): Promise<void> {
    await this.captureCommandEvent("review_command_succeeded", input);
  }

  async captureCommandFailed(
    input: WhiteboardCommandTelemetryInput,
  ): Promise<void> {
    await this.captureCommandEvent("review_command_failed", input);
  }

  async captureCommandStarted(
    input: WhiteboardCommandStartedInput,
  ): Promise<void> {
    await this.captureEvent("review_command_started", {
      command_path: input.command,
      command_run_id: input.commandRunId,
      agent_kind: this.sessionAgent(),
    });
  }

  async captureSessionStarted(
    input: WhiteboardSessionStartedInput,
  ): Promise<void> {
    await this.captureEvent(
      "review_session_started",
      withAppSession(
        {
          source_kind: sourceKind(input),
          agent_kind: input.agentKind ?? this.sessionAgent(),
        },
        input.appSessionId,
      ),
      sessionTelemetryContext(input),
    );
  }

  async captureSessionEnded(input: WhiteboardSessionEndedInput): Promise<void> {
    await this.captureEvent(
      "review_session_ended",
      withAppSession(
        {
          source_kind: sourceKind(input),
          agent_kind: input.agentKind ?? this.sessionAgent(),
          outcome: input.outcome,
          duration_ms: input.durationMs,
        },
        input.appSessionId,
      ),
      sessionTelemetryContext(input),
    );
  }

  async captureWhiteboardPresented(
    context: Required<WhiteboardTelemetryContext>,
    input: { appSessionId?: string } = {},
  ): Promise<void> {
    await this.captureEvent(
      "review_review_presented",
      withAppSession({ source: "review_app" }, input.appSessionId),
      context,
    );
  }

  async captureWhiteboardDeleted(): Promise<void> {
    await this.captureEvent("review_review_deleted");
  }

  /**
   * The reaper deleted a dismissed review. No reader is present, so this is a
   * server event rather than a UI one.
   */
  async captureWhiteboardReaped(input: {
    retentionDays: number;
  }): Promise<void> {
    await this.captureEvent("review_review_reaped", {
      retention_days: input.retentionDays,
    });
  }

  async captureTabViewed(
    event: WhiteboardTabTelemetryEvent,
    context?: WhiteboardTelemetryContext,
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

  async captureUiEvent(
    event: string,
    properties: Record<string, string | number | boolean>,
    context?: WhiteboardTelemetryContext,
  ): Promise<void> {
    await this.captureEvent(
      event,
      {
        source: "review_app",
        ...properties,
      },
      context,
    );
  }

  async captureEvent(
    event: string,
    properties: PostHogCaptureProperties = {},
    context?: WhiteboardTelemetryContext,
  ): Promise<void> {
    await this.withTelemetry(async (config) => {
      await this.captureClient.capture({
        event,
        distinctId: config.installationId,
        properties: {
          ...(await this.commonProperties(config)),
          ...properties,
          ...correlationProperties(config.installationId, context),
        },
      });
    });
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
    input: WhiteboardCommandTelemetryInput,
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
    fn: (config: WhiteboardTelemetryInstallConfig) => Promise<void>,
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

  private async loadInstallConfig(): Promise<WhiteboardTelemetryInstallConfig> {
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

  private optedOut(config?: WhiteboardTelemetryInstallConfig): boolean {
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

  private async readOrCreateInstallConfig(): Promise<WhiteboardTelemetryInstallConfig> {
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

    const config = createTelemetryInstallConfig(
      (await this.readLegacyInstallId()) ?? this.idFactory(),
      this.now,
    );

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

  private writeInstallConfig(config: WhiteboardTelemetryInstallConfig): void {
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
    config: Pick<WhiteboardTelemetryInstallConfig, "internal">,
  ): Promise<PostHogCaptureProperties> {
    const appVersion = whiteboardAppVersion(this.env);

    const properties: PostHogCaptureProperties = {
      product: "review-cli",
      package: "@dev.fast/whiteboard",
      version: await this.readPackageVersion(),
      node_major: Number(process.versions.node.split(".", 1)[0]),
      platform: process.platform,
      arch: process.arch,
      ci: Boolean(this.env.CI),
      internal: isInternalTelemetry(this.env, config),
    };

    if (appVersion) properties.app_version = appVersion;

    return properties;
  }

  private readPackageVersion(): Promise<string> {
    this.packageVersion ??= readWhiteboardPackageVersion();

    return this.packageVersion;
  }

  private sessionAgent(): WhiteboardSessionAgent {
    const harness = resolveAuthoringSessionRef(this.env)?.harness;

    if (harness === "codex") return "codex";

    if (harness === "claude-code") return "claude";

    if (harness === "pi") return "pi";

    return "other";
  }
}

export { isTelemetryOptedOut } from "./telemetry-config";

function sourceKind(
  input: WhiteboardSessionStartedInput,
): WhiteboardSourceKind {
  if (input.sourceKind) return input.sourceKind;

  if (input.mode === "pr") return "pull_request";

  return "git_branch";
}

function sessionTelemetryContext(
  input: WhiteboardSessionStartedInput,
): WhiteboardTelemetryContext {
  return {
    sessionId: input.sessionId,
    presentationSessionId: input.presentationSessionId,
  };
}

function correlationProperties(
  installationId: string,
  context: WhiteboardTelemetryContext | undefined,
): PostHogCaptureProperties {
  const properties: PostHogCaptureProperties = {};

  if (!context) return properties;

  if (context.sessionId) {
    properties.review_id = opaqueCorrelationId(
      "rv_",
      installationId,
      "review",
      context.sessionId,
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

/** Adds the app session that presented the review, when one did. */
function withAppSession(
  properties: PostHogCaptureProperties,
  appSessionId: string | undefined,
): PostHogCaptureProperties {
  if (appSessionId) properties.app_session_id = appSessionId;

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
      nonEmpty(env[PROGRESSIVE_WHITEBOARD_POSTHOG_KEY_ENV]) ??
      nonEmpty(env.DEV_FAST_POSTHOG_KEY) ??
      nonEmpty(env.POSTHOG_KEY) ??
      EMBEDDED_PROGRESSIVE_WHITEBOARD_POSTHOG_KEY,
    host:
      nonEmpty(env[PROGRESSIVE_WHITEBOARD_POSTHOG_HOST_ENV]) ??
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

function whiteboardAppVersion(env: NodeJS.ProcessEnv): string | undefined {
  const value = nonEmpty(env[WHITEBOARD_APP_VERSION_ENV]);

  return value && validSemver(value) ? value : undefined;
}

async function readWhiteboardPackageVersion(): Promise<string> {
  try {
    const packageRoot = findWhiteboardPackageRoot(import.meta.url);

    const packageJson = jsonObject(
      parseJsonText(
        await readFile(path.join(packageRoot, "package.json"), "utf8"),
      ),
    );

    return jsonString(packageJson?.version) ?? "unknown";
  } catch {
    return "unknown";
  }
}
