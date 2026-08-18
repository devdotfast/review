import { readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { findProgressiveReviewPackageRoot } from "./package-paths";
import type { PostHogCaptureInput } from "./posthog-capture-client";
import {
  ProgressiveReviewTelemetry,
  type ProgressiveReviewTelemetryCaptureClient,
  REVIEW_APP_VERSION_ENV,
} from "./progressive-review-telemetry";

describe("ProgressiveReviewTelemetry", () => {
  const cleanupPaths: string[] = [];

  afterEach(async () => {
    await Promise.all(
      cleanupPaths
        .splice(0)
        .map((target) => rm(target, { recursive: true, force: true })),
    );
  });

  it("emits installation-created once and reuses the same client identity for commands", async () => {
    const { configPath, events, rootPath, telemetry } = createTelemetry();
    cleanupPaths.push(rootPath);

    await telemetry.captureInstallationCreated();
    await telemetry.captureInstallationCreated();
    await telemetry.captureCommandSucceeded({
      command: "scaffold",
      exitCode: 0,
      properties: { has_base_ref: false },
    });

    expect(events.map((event) => event.event)).toEqual([
      "review_installation_created",
      "review_command_succeeded",
    ]);
    expect(events[0].distinctId).toBe("install-123");
    expect(events[1].distinctId).toBe("install-123");
    expect(events[1].properties).toMatchObject({
      product: "review-cli",
      command_path: "scaffold",
      exit_code: 0,
      has_base_ref: false,
    });
    await expect(readFile(configPath, "utf8")).resolves.toContain(
      '"installationCreatedSent": true',
    );
  });

  it("adds package version and internal status to common properties", async () => {
    const { events, rootPath, telemetry } = createTelemetry({
      env: { PROGRESSIVE_REVIEW_TELEMETRY_INTERNAL: "1" },
    });
    cleanupPaths.push(rootPath);

    await telemetry.captureCommandSucceeded({
      command: "info",
      exitCode: 0,
    });

    expect(events).toHaveLength(1);
    expect(events[0].properties).toMatchObject({
      product: "review-cli",
      package: "@dev.fast/review",
      version: await progressiveReviewPackageVersion(),
      internal: true,
    });
  });

  it("adds a valid Desktop version without changing the package version", async () => {
    const { events, rootPath, telemetry } = createTelemetry({
      env: { [REVIEW_APP_VERSION_ENV]: "0.0.16" },
    });
    cleanupPaths.push(rootPath);

    await telemetry.captureSessionStarted({ mode: "refs" });

    expect(events).toHaveLength(1);
    expect(events[0].properties).toMatchObject({
      version: await progressiveReviewPackageVersion(),
      app_version: "0.0.16",
    });
  });

  it.each([undefined, "not-a-version"])(
    "omits an absent or invalid Desktop version: %s",
    async (appVersion) => {
      const { events, rootPath, telemetry } = createTelemetry({
        env: appVersion ? { [REVIEW_APP_VERSION_ENV]: appVersion } : {},
      });
      cleanupPaths.push(rootPath);

      await telemetry.captureSessionStarted({ mode: "refs" });

      expect(events).toHaveLength(1);
      expect(events[0].properties).not.toHaveProperty("app_version");
    },
  );

  it("captures session started and ended events without agent session identifiers", async () => {
    const { events, rootPath, telemetry } = createTelemetry({
      env: { CODEX_THREAD_ID: "secret-agent-session-id" },
    });
    cleanupPaths.push(rootPath);

    await telemetry.captureSessionStarted({ mode: "refs" });
    await telemetry.captureSessionEnded({
      mode: "refs",
      outcome: "accepted",
      durationMs: 250,
    });

    expect(events.map((event) => event.event)).toEqual([
      "review_session_started",
      "review_session_ended",
    ]);
    expect(events[0].properties).toMatchObject({
      source_kind: "git_branch",
      agent_kind: "codex",
    });
    expect(events[1].properties).toMatchObject({
      source_kind: "git_branch",
      agent_kind: "codex",
      outcome: "approve",
      duration_ms: 250,
    });
    expect(JSON.stringify(events)).not.toContain("secret-agent-session-id");
  });

  it("does not write config or send events when DO_NOT_TRACK is set", async () => {
    const { configPath, events, rootPath, telemetry } = createTelemetry({
      env: { DO_NOT_TRACK: "1" },
    });
    cleanupPaths.push(rootPath);

    await telemetry.captureInstallationCreated();
    await telemetry.captureCommandFailed({
      command: "info",
      exitCode: 1,
      properties: { healthy: false },
    });

    expect(events).toEqual([]);
    await expect(readFile(configPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("captures only closed error values", async () => {
    const { events, rootPath, telemetry } = createTelemetry();
    cleanupPaths.push(rootPath);

    await telemetry.captureCommandFailed({
      command: "publish",
      exitCode: 1,
      errorName: "review_state_error",
      errorCategory: "local_state",
      properties: { has_head_ref: true },
    });

    expect(events).toHaveLength(1);
    expect(events[0].properties).toMatchObject({
      error_name: "review_state_error",
      error_category: "local_state",
      has_head_ref: true,
    });
    expect(JSON.stringify(events[0])).not.toContain("error_message");
  });

  it("applies the stored telemetry setting", async () => {
    const { configPath, events, rootPath, telemetry } = createTelemetry();
    cleanupPaths.push(rootPath);

    await telemetry.setEnabled(false);
    await telemetry.captureCommandSucceeded({ command: "info", exitCode: 0 });
    expect(events).toEqual([]);
    await expect(readFile(configPath, "utf8")).resolves.toContain(
      '"enabled": false',
    );

    await telemetry.setEnabled(true);
    await telemetry.captureCommandSucceeded({ command: "info", exitCode: 0 });
    expect(events).toHaveLength(1);
  });

  it("returns the stable installation id without sending telemetry", async () => {
    const { events, rootPath, telemetry } = createTelemetry();
    cleanupPaths.push(rootPath);

    await telemetry.setEnabled(false);

    await expect(telemetry.getInstallationId()).resolves.toBe("install-123");
    await expect(telemetry.getInstallationId()).resolves.toBe("install-123");
    expect(events).toEqual([]);
  });
});

function createTelemetry(input?: { env?: NodeJS.ProcessEnv }): {
  configPath: string;
  events: PostHogCaptureInput[];
  rootPath: string;
  telemetry: ProgressiveReviewTelemetry;
} {
  const rootPath = path.join(
    os.tmpdir(),
    `progressive-review-telemetry-${Date.now()}-${Math.random()
      .toString(16)
      .slice(2)}`,
  );
  const configPath = path.join(rootPath, "telemetry.json");
  const events: PostHogCaptureInput[] = [];
  const captureClient: ProgressiveReviewTelemetryCaptureClient = {
    enabled: true,
    capture: async (event) => {
      events.push(event);
    },
  };
  const telemetry = new ProgressiveReviewTelemetry({
    captureClient,
    env: input?.env ?? {},
    installConfigPath: configPath,
    idFactory: () => "install-123",
    now: () => new Date("2026-01-02T03:04:05.000Z"),
  });
  return { configPath, events, rootPath, telemetry };
}

async function progressiveReviewPackageVersion(): Promise<string> {
  const packageRoot = findProgressiveReviewPackageRoot(import.meta.url);
  const packageJson = JSON.parse(
    await readFile(path.join(packageRoot, "package.json"), "utf8"),
  ) as { version: string };
  return packageJson.version;
}
