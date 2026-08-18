import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { valid as validSemver } from "semver";

import { writeFileAtomic } from "./atomic-write";
import { resolveAuthoringSessionRef } from "./authoring-session";
import { findProgressiveReviewPackageRoot } from "./package-paths";
import { EMBEDDED_PROGRESSIVE_REVIEW_POSTHOG_KEY } from "./embedded-posthog-key";
import {
  PROGRESSIVE_REVIEW_POSTHOG_HOST_ENV,
  PROGRESSIVE_REVIEW_POSTHOG_KEY_ENV,
  PostHogCaptureClient,
  type PostHogCaptureInput,
  type PostHogCaptureProperties,
} from "./posthog-capture-client";
import {
  type ProgressiveReviewTelemetryInstallConfig,
  createTelemetryInstallConfig,
  isInternalTelemetry,
  isTelemetryOptedOut,
  legacyAppTelemetryConfigPath,
  normalizeTelemetryInstallConfig,
  progressiveReviewTelemetryConfigPath,
} from "./telemetry-config";
import { createTelemetryDebugSink } from "./telemetry-debug-sink";
import { withFileLock } from "./with-file-lock";

export const REVIEW_APP_VERSION_ENV = "DEV_FAST_REVIEW_APP_VERSION";

export type ProgressiveReviewCommand = "review" | "map" | "status";
export type ProgressiveReviewCommandPath =
  | "help"
  | "version"
  | "app.launch"
  | "app.pick"
  | "rebind"
  | "publish"
  | "wait"
  | "info"
  | "scaffold"
  | "install"
  | "migrate.apply"
  | "threads.list"
  | "threads.resolve"
  | "threads.reply"
  | "map.open"
  | "map.check"
  | "map.publish"
  | "map.prune"
  | "map.push"
  | "map.fetch"
  | "invalid";

export type ProgressiveReviewTelemetryErrorName =
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

export type ProgressiveReviewTelemetryErrorCategory =
  | "user_input"
  | "local_state"
  | "dependency"
  | "transport"
  | "internal";

export type ProgressiveReviewSourceKind =
  | "pull_request"
  | "git_branch"
  | "jj_bookmark"
  | "jj_change";
export type ProgressiveReviewSessionAgent = "codex" | "claude" | "pi" | "other";
export type ProgressiveReviewSessionOutcome =
  | "approve"
  | "request-changes"
  // Replaced "rejected": the reader dismisses a review instead of rejecting it.
  | "dismissed";

export type ReviewTelemetryTab = "review" | "commits" | "map" | "files";
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

export interface ProgressiveReviewCommandTelemetryInput {
  command: ProgressiveReviewCommandPath;
  exitCode: number;
  durationMs?: number;
  properties?: PostHogCaptureProperties;
  errorName?: ProgressiveReviewTelemetryErrorName;
  errorCategory?: ProgressiveReviewTelemetryErrorCategory;
}

export interface ProgressiveReviewSessionStartedInput {
  sourceKind?: ProgressiveReviewSourceKind;
  agentKind?: ProgressiveReviewSessionAgent;
  mode?: "pr" | "refs" | "branch";
  appSessionId?: string;
}

export interface ProgressiveReviewSessionEndedInput extends ProgressiveReviewSessionStartedInput {
  outcome: ProgressiveReviewSessionOutcome | "accepted";
  durationMs: number;
}

export interface ProgressiveReviewTelemetryCaptureClient {
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

export interface ProgressiveReviewTelemetryOptions {
  captureClient?: ProgressiveReviewTelemetryCaptureClient;
  env?: NodeJS.ProcessEnv;
  installConfigPath?: string;
  legacyInstallConfigPath?: string;
  idFactory?: () => string;
  randomUUID?: () => string;
  now?: () => Date;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export interface Logger {
  trace(message: string, attributes?: Record<string, unknown>): void;
  debug(message: string, attributes?: Record<string, unknown>): void;
  info(message: string, attributes?: Record<string, unknown>): void;
  warn(message: string, attributes?: Record<string, unknown>): void;
  error(message: string, attributes?: Record<string, unknown>): void;
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
  ProgressiveReviewTelemetryInstallConfig
>();

export function createLogger(_scope: string): Logger {
  return noopLogger;
}

export class ProgressiveReviewTelemetry {
  private readonly captureClient: ProgressiveReviewTelemetryCaptureClient;
  private readonly env: NodeJS.ProcessEnv;
  private readonly installConfigPath: string;
  private readonly legacyInstallConfigPath: string;
  private readonly idFactory: () => string;
  private readonly now: () => Date;
  private installConfig: ProgressiveReviewTelemetryInstallConfig | undefined;
  private packageVersion: Promise<string> | undefined;

  constructor(options: ProgressiveReviewTelemetryOptions = {}) {
    this.env = options.env ?? process.env;
    this.captureClient =
      options.captureClient ??
      createTelemetryDebugSink(this.env) ??
      (options.fetch
        ? directCaptureClient(this.env, options.fetch, options.timeoutMs)
        : PostHogCaptureClient.fromEnv(this.env));
    this.installConfigPath =
      options.installConfigPath ??
      progressiveReviewTelemetryConfigPath(this.env);
    this.legacyInstallConfigPath =
      options.legacyInstallConfigPath ?? legacyAppTelemetryConfigPath(this.env);
    this.idFactory = options.idFactory ?? options.randomUUID ?? randomUUID;
    this.now = options.now ?? (() => new Date());
  }

  static fromEnv(
    env: NodeJS.ProcessEnv = process.env,
  ): ProgressiveReviewTelemetry {
    return new ProgressiveReviewTelemetry({ env });
  }

  async getInstallationId(): Promise<string> {
    return (await this.loadInstallConfig()).installationId;
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
        properties: await this.commonProperties(),
      });
      // A printed event is not a sent event. Persisting the flag here would
      // suppress the real installation event on this machine forever.
      if (this.captureClient.ignoresOptOut) return;
      config.installationCreatedSent = true;
      this.writeInstallConfig(config);
    });
  }

  async captureCommandSucceeded(
    input: ProgressiveReviewCommandTelemetryInput,
  ): Promise<void> {
    await this.captureCommandEvent("review_command_succeeded", input);
  }

  async captureCommandFailed(
    input: ProgressiveReviewCommandTelemetryInput,
  ): Promise<void> {
    await this.captureCommandEvent("review_command_failed", input);
  }

  async captureSessionStarted(
    input: ProgressiveReviewSessionStartedInput,
  ): Promise<void> {
    await this.captureEvent("review_session_started", {
      source_kind: sourceKind(input),
      agent_kind: input.agentKind ?? this.sessionAgent(),
      ...(input.appSessionId ? { app_session_id: input.appSessionId } : {}),
    });
  }

  async captureSessionEnded(
    input: ProgressiveReviewSessionEndedInput,
  ): Promise<void> {
    await this.captureEvent("review_session_ended", {
      source_kind: sourceKind(input),
      agent_kind: input.agentKind ?? this.sessionAgent(),
      outcome: input.outcome === "accepted" ? "approve" : input.outcome,
      duration_ms: input.durationMs,
      ...(input.appSessionId ? { app_session_id: input.appSessionId } : {}),
    });
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

  async capturePublishGateRejected(input: {
    gate: "publish_ready" | "map_publish_ready";
  }): Promise<void> {
    await this.captureEvent("review_publish_gate_rejected", {
      gate: input.gate,
    });
  }

  async captureTabViewed(event: ReviewTabTelemetryEvent): Promise<void> {
    await this.captureEvent("review_tab_viewed", {
      tab: event.tab,
      duration_ms: event.durationMs,
      reason: event.reason,
      source: "review_app",
      app_session_id: event.appSessionId,
    });
  }

  async captureUiEvent(
    event: string,
    properties: Record<string, string | number | boolean>,
  ): Promise<void> {
    await this.captureEvent(event, {
      source: "review_app",
      ...properties,
    });
  }

  async captureEvent(
    event: string,
    properties: PostHogCaptureProperties = {},
  ): Promise<void> {
    await this.withTelemetry(async (config) => {
      await this.captureClient.capture({
        event,
        distinctId: config.installationId,
        properties: {
          ...(await this.commonProperties()),
          ...properties,
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
    input: ProgressiveReviewCommandTelemetryInput,
  ): Promise<void> {
    await this.captureEvent(event, {
      command_path: input.command,
      exit_code: input.exitCode,
      ...(input.durationMs === undefined
        ? {}
        : { duration_ms: input.durationMs }),
      ...(input.properties ?? {}),
      ...(input.errorName ? { error_name: input.errorName } : {}),
      ...(input.errorCategory ? { error_category: input.errorCategory } : {}),
    });
  }

  private async withTelemetry(
    fn: (config: ProgressiveReviewTelemetryInstallConfig) => Promise<void>,
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

  private async loadInstallConfig(): Promise<ProgressiveReviewTelemetryInstallConfig> {
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

  private optedOut(config?: ProgressiveReviewTelemetryInstallConfig): boolean {
    if (this.captureClient.ignoresOptOut) return false;
    return isTelemetryOptedOut(this.env, config);
  }

  private async isEnabled(): Promise<boolean> {
    if (!this.captureClient.enabled || this.optedOut()) {
      return false;
    }
    try {
      const parsed = JSON.parse(
        await readFile(this.installConfigPath, "utf8"),
      ) as Partial<ProgressiveReviewTelemetryInstallConfig>;
      const config = normalizeTelemetryInstallConfig(parsed, this.now);
      if (!config) return true;
      this.installConfig = config;
      sharedInstallConfigs.set(this.installConfigPath, config);
      return !this.optedOut(config);
    } catch {
      return true;
    }
  }

  private async readOrCreateInstallConfig(): Promise<ProgressiveReviewTelemetryInstallConfig> {
    try {
      const parsed = JSON.parse(
        await readFile(this.installConfigPath, "utf8"),
      ) as Partial<ProgressiveReviewTelemetryInstallConfig>;
      const config = normalizeTelemetryInstallConfig(parsed, this.now);
      if (config) return config;
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
      const parsed = JSON.parse(
        await readFile(this.legacyInstallConfigPath, "utf8"),
      ) as { installId?: unknown };
      return typeof parsed.installId === "string" && parsed.installId.length > 0
        ? parsed.installId
        : undefined;
    } catch {
      return undefined;
    }
  }

  private writeInstallConfig(
    config: ProgressiveReviewTelemetryInstallConfig,
  ): void {
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

  private async commonProperties(): Promise<PostHogCaptureProperties> {
    const appVersion = reviewAppVersion(this.env);
    return {
      product: "review-cli",
      package: "@dev.fast/review",
      version: await this.readPackageVersion(),
      ...(appVersion ? { app_version: appVersion } : {}),
      node_major: Number(process.versions.node.split(".", 1)[0]),
      platform: process.platform,
      arch: process.arch,
      ci: Boolean(this.env.CI),
      internal: isInternalTelemetry(this.env),
    };
  }

  private readPackageVersion(): Promise<string> {
    this.packageVersion ??= readProgressiveReviewPackageVersion();
    return this.packageVersion;
  }

  private sessionAgent(): ProgressiveReviewSessionAgent {
    const harness = resolveAuthoringSessionRef(this.env)?.harness;
    if (harness === "codex") return "codex";
    if (harness === "claude-code") return "claude";
    if (harness === "pi") return "pi";
    return "other";
  }
}

export { isTelemetryOptedOut } from "./telemetry-config";

function sourceKind(
  input: ProgressiveReviewSessionStartedInput,
): ProgressiveReviewSourceKind {
  if (input.sourceKind) return input.sourceKind;
  if (input.mode === "pr") return "pull_request";
  return "git_branch";
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

async function readProgressiveReviewPackageVersion(): Promise<string> {
  try {
    const packageRoot = findProgressiveReviewPackageRoot(import.meta.url);
    const packageJson = JSON.parse(
      await readFile(path.join(packageRoot, "package.json"), "utf8"),
    ) as { version?: unknown };
    return typeof packageJson.version === "string"
      ? packageJson.version
      : "unknown";
  } catch {
    return "unknown";
  }
}
