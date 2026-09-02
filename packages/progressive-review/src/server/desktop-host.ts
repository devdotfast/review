#!/usr/bin/env node

import { findProgressiveReviewPackageRoot } from "../package-paths";
import { ProgressiveReviewTelemetry } from "../progressive-review-telemetry";
import { ensureBundledRustAnalyzer } from "../review-bundled-tools";
import { listenForDesktopHostShutdown } from "./desktop-host-shutdown";
import { createGlobalReviewServer } from "./desktop-server";

export async function runDesktopHost(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  // Port 0 lets the OS choose; the ready event below reports what was bound.
  const port = requiredPort(env.DEV_FAST_REVIEW_SERVER_PORT);
  const appPid = requiredPositiveInteger(
    env.DEV_FAST_REVIEW_APP_PID,
    "DEV_FAST_REVIEW_APP_PID",
  );
  const packageRoot = findProgressiveReviewPackageRoot(import.meta.url);
  const toolingRoot = env.DEV_FAST_REVIEW_TOOLING_ROOT || packageRoot;
  const telemetryEnv = { ...env };
  delete telemetryEnv.DEV_FAST_REVIEW_TELEMETRY_DISABLED;
  const telemetry = ProgressiveReviewTelemetry.fromEnv(telemetryEnv);
  await telemetry.setEnabled(
    !isEnabledEnvValue(env.DEV_FAST_REVIEW_TELEMETRY_DISABLED),
  );
  const installationId = await telemetry.getInstallationId();
  // This value bootstraps the stored setting. Remove it after persistence so
  // a later in-app enable also reaches telemetry instances created elsewhere.
  delete env.DEV_FAST_REVIEW_TELEMETRY_DISABLED;
  const server = createGlobalReviewServer({
    appPid,
    packageRoot,
    toolingRoot,
    port,
    token: env.DEV_FAST_REVIEW_SERVER_TOKEN,
    instanceId: env.DEV_FAST_REVIEW_INSTANCE_ID,
    telemetry,
    ...(env.DEV_FAST_REVIEW_CLI_RUNTIME
      ? { cliRuntimePath: env.DEV_FAST_REVIEW_CLI_RUNTIME }
      : {}),
  });
  await server.listen();
  process.stdout.write(
    `${JSON.stringify({ event: "ready", ...server.discovery, installationId })}\n`,
  );
  const stageRustAnalyzer = () =>
    ensureBundledRustAnalyzer({ env }).catch((error) => {
      const reason = error instanceof Error ? error.message : String(error);
      process.stderr.write(
        `[Review tools] Could not stage bundled rust-analyzer: ${reason}\n`,
      );
    });
  void stageRustAnalyzer();

  let stopping: Promise<void> | null = null;
  const stop = () => {
    if (!stopping) {
      stopping = server.close("app-exit");
    }
    return stopping;
  };
  listenForDesktopHostShutdown(
    process,
    () => {
      void stop().then(() => process.exit(0));
    },
    (enabled) => {
      void telemetry.setEnabled(enabled).catch(() => undefined);
    },
    (sourcePath) => {
      env.DEV_FAST_REVIEW_RUST_ANALYZER = sourcePath;
      void stageRustAnalyzer();
    },
  );
  process.once("SIGINT", () => {
    void stop().then(() => process.exit(0));
  });
  process.once("SIGTERM", () => {
    void stop().then(() => process.exit(0));
  });
}

function isEnabledEnvValue(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true";
}

function requiredPort(value: string | undefined): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 65_535) {
    throw new Error(
      "DEV_FAST_REVIEW_SERVER_PORT must be a port between 0 and 65535.",
    );
  }
  return parsed;
}

function requiredPositiveInteger(
  value: string | undefined,
  name: string,
): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

if (process.env.DEV_FAST_REVIEW_DESKTOP_HOST_AUTOSTART !== "0") {
  void runDesktopHost().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
