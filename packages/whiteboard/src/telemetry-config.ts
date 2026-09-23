import { existsSync } from "node:fs";
import path from "node:path";

import type { JsonValue } from "@dev.fast/whiteboard-protocol";
import { z } from "zod";

import { findWhiteboardPackageRoot } from "./package-paths";
import {
  DEV_WHITEBOARD_HOME_ENV,
  devWhiteboardHome,
} from "./whiteboard-home-paths";

export interface WhiteboardTelemetryInstallConfig {
  installationId: string;
  createdAt: string;
  installationCreatedSent: boolean;
  enabled: boolean;
  internal: boolean;
}

const TELEMETRY_CONFIG_RELATIVE_PATH = path.join(
  "telemetry",
  "progressive-review.json",
);

const LEGACY_APP_TELEMETRY_CONFIG_RELATIVE_PATH = path.join(
  "telemetry",
  "install.json",
);

export function whiteboardTelemetryConfigPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(devWhiteboardHome(env), TELEMETRY_CONFIG_RELATIVE_PATH);
}

export function legacyAppTelemetryConfigPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(
    devWhiteboardHome(env),
    LEGACY_APP_TELEMETRY_CONFIG_RELATIVE_PATH,
  );
}

export function isTelemetryOptedOut(
  env: NodeJS.ProcessEnv,
  config?: Pick<WhiteboardTelemetryInstallConfig, "enabled">,
): boolean {
  // Test runners must never emit real telemetry: every vitest/node-test run
  // with a temp DEV_WHITEBOARD_HOME mints a fresh installation id and floods the
  // installation and command metrics. Telemetry's own unit tests inject fake
  // capture clients, so they are unaffected by this guard.
  if (isEnabledEnvValue(env.VITEST) || env.NODE_ENV === "test") return true;

  if (config?.enabled === false) return true;

  // Keep every historical spelling so existing shell and CI configurations
  // continue to disable telemetry after package and product renames.
  return [
    env.DO_NOT_TRACK,
    env.DNT,
    env.PROGRESSIVE_WHITEBOARD_TELEMETRY_DISABLED,
    env.DEV_FAST_TELEMETRY_DISABLED,
    env.DEV_FAST_PROGRESSIVE_WHITEBOARD_TELEMETRY_DISABLED,
    env.DEV_FAST_WHITEBOARD_TELEMETRY_DISABLED,
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
  enabled: z.boolean().optional().catch(undefined),
  internal: z.boolean().optional().catch(undefined),
});

export function normalizeTelemetryInstallConfig(
  parsed: JsonValue,
  now: () => Date,
): WhiteboardTelemetryInstallConfig | undefined {
  const stored = storedTelemetryInstallConfigSchema.safeParse(parsed);

  if (!stored.success) return undefined;

  return {
    installationId: stored.data.installationId,
    createdAt: stored.data.createdAt ?? now().toISOString(),
    installationCreatedSent: stored.data.installationCreatedSent === true,
    enabled: stored.data.enabled !== false,
    internal: stored.data.internal === true,
  };
}

export function createTelemetryInstallConfig(
  installationId: string,
  now: () => Date,
): WhiteboardTelemetryInstallConfig {
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
    const packageRoot = findWhiteboardPackageRoot();

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
  config?: Pick<WhiteboardTelemetryInstallConfig, "internal">,
): boolean {
  if (env.PROGRESSIVE_WHITEBOARD_TELEMETRY_INTERNAL === "1") return true;

  if (env.PROGRESSIVE_WHITEBOARD_TELEMETRY_INTERNAL === "0") return false;

  if (config?.internal === true) return true;

  return isWorkspaceCheckout();
}
