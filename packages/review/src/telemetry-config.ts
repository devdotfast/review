import { existsSync } from "node:fs";
import path from "node:path";

import type { JsonValue } from "@dev.fast/review-protocol";
import { z } from "zod";

import { findReviewPackageRoot } from "./package-paths";
import { DEV_REVIEW_HOME_ENV, devReviewHome } from "./review-home-paths";

export interface ReviewTelemetryInstallConfig {
  installationId: string;
  createdAt: string;
  installationCreatedSent: boolean;
  firstReviewPresentedSent: boolean;
  enabled: boolean;
  internal: boolean;
}

export type ReviewTelemetryChannel = "stable" | "preview" | "dev";

export type ReviewTelemetryEnvironment =
  | "production"
  | "ci"
  | "internal"
  | "e2e"
  | "smoke";

export type ReviewTelemetrySurface =
  | "desktop"
  | "cli"
  | "headless"
  | "mcp"
  | "api";

/** Set by Electron main from product.json `quality`; `dev` for an unpackaged run. */
export const REVIEW_CHANNEL_ENV = "DEV_FAST_REVIEW_CHANNEL";

/** Set by the e2e harness (`e2e`) and the packaged smoke scripts (`smoke`). */
export const REVIEW_TELEMETRY_ENV_ENV = "DEV_FAST_REVIEW_TELEMETRY_ENV";

const CHANNELS: readonly ReviewTelemetryChannel[] = [
  "stable",
  "preview",
  "dev",
];

export function reviewTelemetryChannel(
  env: NodeJS.ProcessEnv,
): ReviewTelemetryChannel {
  // SAFETY: the cast is provisional; CHANNELS.includes(value) below checks
  // membership before the value is ever returned, falling back to "stable".
  const value = env[REVIEW_CHANNEL_ENV]?.trim() as ReviewTelemetryChannel;

  return CHANNELS.includes(value) ? value : "stable";
}

/**
 * First match wins: a harness declares itself, then CI, then a dev.fast
 * checkout or a persisted internal marker, else a real user.
 */
export function reviewTelemetryEnvironment(
  env: NodeJS.ProcessEnv,
  config?: Pick<ReviewTelemetryInstallConfig, "internal">,
): ReviewTelemetryEnvironment {
  const harness = env[REVIEW_TELEMETRY_ENV_ENV]?.trim();

  if (harness === "e2e" || harness === "smoke") return harness;

  if (env.CI) return "ci";

  if (isInternalTelemetry(env, config)) return "internal";

  return "production";
}

const TELEMETRY_CONFIG_RELATIVE_PATH = path.join(
  "telemetry",
  "progressive-review.json",
);

const PREVIEW_TELEMETRY_CONFIG_RELATIVE_PATH = path.join(
  "telemetry",
  "progressive-review.preview.json",
);

const LEGACY_APP_TELEMETRY_CONFIG_RELATIVE_PATH = path.join(
  "telemetry",
  "install.json",
);

export function reviewTelemetryConfigPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(
    devReviewHome(env),
    reviewTelemetryChannel(env) === "preview"
      ? PREVIEW_TELEMETRY_CONFIG_RELATIVE_PATH
      : TELEMETRY_CONFIG_RELATIVE_PATH,
  );
}

export function legacyAppTelemetryConfigPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(
    devReviewHome(env),
    LEGACY_APP_TELEMETRY_CONFIG_RELATIVE_PATH,
  );
}

export function isTelemetryOptedOut(
  env: NodeJS.ProcessEnv,
  config?: Pick<ReviewTelemetryInstallConfig, "enabled">,
): boolean {
  // Test runners must never emit real telemetry: every vitest/node-test run
  // with a temp DEV_REVIEW_HOME mints a fresh installation id and floods the
  // installation and command metrics. Telemetry's own unit tests inject fake
  // capture clients, so they are unaffected by this guard.
  if (isEnabledEnvValue(env.VITEST) || env.NODE_ENV === "test") return true;

  if (config?.enabled === false) return true;

  // Keep every historical spelling so existing shell and CI configurations
  // continue to disable telemetry after package and product renames.
  return [
    env.DO_NOT_TRACK,
    env.DNT,
    env.PROGRESSIVE_REVIEW_TELEMETRY_DISABLED,
    env.DEV_FAST_TELEMETRY_DISABLED,
    env.DEV_FAST_PROGRESSIVE_REVIEW_TELEMETRY_DISABLED,
    env.DEV_FAST_REVIEW_TELEMETRY_DISABLED,
  ].some(isEnabledEnvValue);
}

/**
 * The on-disk install config as a hand-edited or older file may hold it: only
 * the installation id is required, and a malformed optional field reads as
 * absent.
 */
const storedTelemetryInstallConfigSchema = z.looseObject({
  installationId: z.string().min(1),
  createdAt: z.string().optional().catch(undefined),
  installationCreatedSent: z.boolean().optional().catch(undefined),
  firstReviewPresentedSent: z.boolean().optional().catch(undefined),
  enabled: z.boolean().optional().catch(undefined),
  internal: z.boolean().optional().catch(undefined),
});

export function normalizeTelemetryInstallConfig(
  parsed: JsonValue,
  now: () => Date,
): ReviewTelemetryInstallConfig | undefined {
  const stored = storedTelemetryInstallConfigSchema.safeParse(parsed);

  if (!stored.success) return undefined;

  return {
    installationId: stored.data.installationId,
    createdAt: stored.data.createdAt ?? now().toISOString(),
    installationCreatedSent: stored.data.installationCreatedSent === true,
    firstReviewPresentedSent: stored.data.firstReviewPresentedSent === true,
    enabled: stored.data.enabled !== false,
    internal: stored.data.internal === true,
  };
}

export function createTelemetryInstallConfig(
  installationId: string,
  now: () => Date,
): ReviewTelemetryInstallConfig {
  return {
    installationId,
    createdAt: now().toISOString(),
    installationCreatedSent: false,
    firstReviewPresentedSent: false,
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
    const packageRoot = findReviewPackageRoot();

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
  config?: Pick<ReviewTelemetryInstallConfig, "internal">,
): boolean {
  if (env.PROGRESSIVE_REVIEW_TELEMETRY_INTERNAL === "1") return true;

  if (env.PROGRESSIVE_REVIEW_TELEMETRY_INTERNAL === "0") return false;

  if (config?.internal === true) return true;

  return isWorkspaceCheckout();
}
