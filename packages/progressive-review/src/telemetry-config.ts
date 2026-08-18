import { existsSync } from "node:fs";
import path from "node:path";

import { findProgressiveReviewPackageRoot } from "./package-paths";
import { DEV_REVIEW_HOME_ENV, devReviewHome } from "./review-storage";

export interface ProgressiveReviewTelemetryInstallConfig {
  installationId: string;
  createdAt: string;
  installationCreatedSent: boolean;
  enabled: boolean;
  internal: boolean;
}

export const TELEMETRY_CONFIG_RELATIVE_PATH = path.join(
  "telemetry",
  "progressive-review.json",
);

export const LEGACY_APP_TELEMETRY_CONFIG_RELATIVE_PATH = path.join(
  "telemetry",
  "install.json",
);

export function progressiveReviewTelemetryConfigPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(
    env[DEV_REVIEW_HOME_ENV] ?? devReviewHome(),
    TELEMETRY_CONFIG_RELATIVE_PATH,
  );
}

export function legacyAppTelemetryConfigPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(
    env[DEV_REVIEW_HOME_ENV] ?? devReviewHome(),
    LEGACY_APP_TELEMETRY_CONFIG_RELATIVE_PATH,
  );
}

export function isTelemetryOptedOut(
  env: NodeJS.ProcessEnv,
  config?: Pick<ProgressiveReviewTelemetryInstallConfig, "enabled">,
): boolean {
  // Test runners must never emit real telemetry: every vitest/node-test run
  // with a temp DEV_REVIEW_HOME mints a fresh installation id and floods the
  // installation and command metrics. Telemetry's own unit tests inject fake
  // capture clients, so they are unaffected by this guard.
  if (isEnabledEnvValue(env.VITEST) || env.NODE_ENV === "test") return true;
  if (config?.enabled === false) return true;
  return [
    env.DO_NOT_TRACK,
    env.DNT,
    env.PROGRESSIVE_REVIEW_TELEMETRY_DISABLED,
    env.DEV_FAST_TELEMETRY_DISABLED,
    env.DEV_FAST_PROGRESSIVE_REVIEW_TELEMETRY_DISABLED,
    env.DEV_FAST_REVIEW_TELEMETRY_DISABLED,
  ].some(isEnabledEnvValue);
}

export function normalizeTelemetryInstallConfig(
  parsed: Partial<ProgressiveReviewTelemetryInstallConfig>,
  now: () => Date,
): ProgressiveReviewTelemetryInstallConfig | undefined {
  if (
    typeof parsed.installationId !== "string" ||
    parsed.installationId.length === 0
  ) {
    return undefined;
  }
  return {
    installationId: parsed.installationId,
    createdAt:
      typeof parsed.createdAt === "string"
        ? parsed.createdAt
        : now().toISOString(),
    installationCreatedSent: Boolean(parsed.installationCreatedSent),
    enabled: parsed.enabled !== false,
    internal: parsed.internal === true,
  };
}

export function createTelemetryInstallConfig(
  installationId: string,
  now: () => Date,
): ProgressiveReviewTelemetryInstallConfig {
  return {
    installationId,
    createdAt: now().toISOString(),
    installationCreatedSent: false,
    enabled: true,
    internal: false,
  };
}

function isEnabledEnvValue(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true";
}

let cachedWorkspaceCheckout: boolean | undefined;

// Running from a workspace checkout (the dev.fast monorepo or any pnpm
// workspace clone) means the traffic is ours, not a customer's. A published
// npm install always lives under node_modules and has no workspace manifest
// above it.
function isWorkspaceCheckout(): boolean {
  if (cachedWorkspaceCheckout !== undefined) return cachedWorkspaceCheckout;
  try {
    const packageRoot = findProgressiveReviewPackageRoot();
    if (packageRoot.split(path.sep).includes("node_modules")) {
      cachedWorkspaceCheckout = false;
      return cachedWorkspaceCheckout;
    }
    let dir = packageRoot;
    while (true) {
      if (existsSync(path.join(dir, "pnpm-workspace.yaml"))) {
        cachedWorkspaceCheckout = true;
        return cachedWorkspaceCheckout;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    cachedWorkspaceCheckout = false;
  } catch {
    cachedWorkspaceCheckout = false;
  }
  return cachedWorkspaceCheckout;
}

/**
 * Whether telemetry from this process should carry `internal: true` so
 * partner-facing dashboards can exclude it. The environment overrides a
 * stored true marker, which overrides workspace detection.
 */
export function isInternalTelemetry(
  env: NodeJS.ProcessEnv,
  config?: Pick<ProgressiveReviewTelemetryInstallConfig, "internal">,
): boolean {
  if (env.PROGRESSIVE_REVIEW_TELEMETRY_INTERNAL === "1") return true;
  if (env.PROGRESSIVE_REVIEW_TELEMETRY_INTERNAL === "0") return false;
  if (config?.internal === true) return true;
  return isWorkspaceCheckout();
}
