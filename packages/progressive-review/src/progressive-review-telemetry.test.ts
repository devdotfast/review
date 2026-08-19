import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
import {
  type ProgressiveReviewTelemetryInstallConfig,
  normalizeTelemetryInstallConfig,
} from "./telemetry-config";

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
      commandRunId: "run-12345678",
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
      commandRunId: "run-12345678",
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

  it.each([
    ["absent", {}, false],
    ["false", { internal: false }, false],
    ["true", { internal: true }, true],
    ["invalid", { internal: "true" }, false],
  ])("normalizes the %s stored internal marker", (_name, marker, expected) => {
    const config = normalizeTelemetryInstallConfig(
      {
        installationId: "existing-install",
        ...marker,
      } as Partial<ProgressiveReviewTelemetryInstallConfig>,
      () => new Date("2026-01-02T03:04:05.000Z"),
    );

    expect(config?.internal).toBe(expected);
  });

  it("migrates an existing configuration without changing its installation id", async () => {
    const { configPath, rootPath, telemetry } = createTelemetry();
    cleanupPaths.push(rootPath);
    await writeStoredConfig(configPath, {
      installationId: "existing-install",
      createdAt: "2025-01-02T03:04:05.000Z",
      installationCreatedSent: true,
      enabled: true,
    });

    await expect(telemetry.getInstallationId()).resolves.toBe(
      "existing-install",
    );
    await expect(readStoredConfig(configPath)).resolves.toMatchObject({
      installationId: "existing-install",
      internal: false,
    });
  });

  it("migrates a legacy installation id with a false internal marker", async () => {
    const { configPath, legacyConfigPath, rootPath, telemetry } =
      createTelemetry();
    cleanupPaths.push(rootPath);
    await writeStoredConfig(legacyConfigPath, { installId: "legacy-install" });

    await expect(telemetry.getInstallationId()).resolves.toBe("legacy-install");
    await expect(readStoredConfig(configPath)).resolves.toMatchObject({
      installationId: "legacy-install",
      internal: false,
    });
  });

  it("preserves the stored internal marker when the telemetry setting changes", async () => {
    const { configPath, rootPath, telemetry } = createTelemetry();
    cleanupPaths.push(rootPath);
    await writeStoredConfig(configPath, storedConfig({ internal: true }));

    await telemetry.setEnabled(false);
    await expect(readStoredConfig(configPath)).resolves.toMatchObject({
      installationId: "stored-install",
      enabled: false,
      internal: true,
    });

    await telemetry.setEnabled(true);
    await expect(readStoredConfig(configPath)).resolves.toMatchObject({
      installationId: "stored-install",
      enabled: true,
      internal: true,
    });
  });

  it("lets an environment zero override a true stored marker", async () => {
    const { configPath, events, rootPath, telemetry } = createTelemetry({
      env: { PROGRESSIVE_REVIEW_TELEMETRY_INTERNAL: "0" },
    });
    cleanupPaths.push(rootPath);
    await writeStoredConfig(configPath, storedConfig({ internal: true }));

    await telemetry.captureCommandSucceeded({
      command: "info",
      commandRunId: "run-12345678",
      exitCode: 0,
    });

    expect(events[0].properties).toMatchObject({ internal: false });
  });

  it("lets an environment one override a false stored marker", async () => {
    const { configPath, events, rootPath, telemetry } = createTelemetry({
      env: { PROGRESSIVE_REVIEW_TELEMETRY_INTERNAL: "1" },
    });
    cleanupPaths.push(rootPath);
    await writeStoredConfig(configPath, storedConfig({ internal: false }));

    await telemetry.captureCommandSucceeded({
      command: "info",
      commandRunId: "run-12345678",
      exitCode: 0,
    });

    expect(events[0].properties).toMatchObject({ internal: true });
  });

  it("marks installation, command, server, and UI events from a stored marker", async () => {
    const { configPath, events, rootPath, telemetry } = createTelemetry();
    cleanupPaths.push(rootPath);
    await writeStoredConfig(configPath, storedConfig({ internal: true }));

    await telemetry.captureInstallationCreated();
    await telemetry.captureCommandSucceeded({
      command: "info",
      commandRunId: "run-12345678",
      exitCode: 0,
    });
    await telemetry.captureReviewReaped({ retentionDays: 30 });
    await telemetry.captureUiEvent("review_app_opened", {});

    expect(events.map((event) => event.event)).toEqual([
      "review_installation_created",
      "review_command_succeeded",
      "review_review_reaped",
      "review_app_opened",
    ]);
    for (const event of events) {
      expect(event.properties).toMatchObject({ internal: true });
    }
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
    await telemetry.captureCommandStarted({
      command: "info",
      commandRunId: telemetry.createCommandRunId(),
    });
    await telemetry.captureCommandFailed({
      command: "info",
      commandRunId: "run-12345678",
      exitCode: 1,
      properties: { healthy: false },
    });
    await telemetry.captureReviewPresented({
      reviewUuid: "86df96ed-65ef-46de-9348-c94811e3bb46",
      presentationSessionId: "0f98956f-ec90-45b5-ae21-19acbcd8b6ef",
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
      commandRunId: "run-12345678",
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
    await telemetry.captureCommandSucceeded({
      command: "info",
      commandRunId: "run-12345678",
      exitCode: 0,
    });
    expect(events).toEqual([]);
    await expect(readFile(configPath, "utf8")).resolves.toContain(
      '"enabled": false',
    );

    await telemetry.setEnabled(true);
    await telemetry.captureCommandSucceeded({
      command: "info",
      commandRunId: "run-12345678",
      exitCode: 0,
    });
    expect(events).toHaveLength(1);
  });

  it("keeps one command run id across start, binding, and completion", async () => {
    const { events, rootPath, telemetry } = createTelemetry({
      env: { CODEX_THREAD_ID: "agent-session-secret" },
      commandRunId: "8b733d48-1172-46a7-9df0-3cc71930c25a",
    });
    cleanupPaths.push(rootPath);
    const commandRunId = telemetry.createCommandRunId();
    const reviewUuid = "86df96ed-65ef-46de-9348-c94811e3bb46";

    await telemetry.captureCommandStarted({
      command: "scaffold",
      commandRunId,
    });
    await telemetry.captureCommandBound({
      command: "scaffold",
      commandRunId,
      reviewUuid,
    });
    await telemetry.captureCommandSucceeded({
      command: "scaffold",
      commandRunId,
      reviewUuid,
      exitCode: 0,
    });

    expect(events.map((event) => event.event)).toEqual([
      "review_command_started",
      "review_command_bound",
      "review_command_succeeded",
    ]);
    expect(events.map((event) => event.properties?.command_run_id)).toEqual([
      commandRunId,
      commandRunId,
      commandRunId,
    ]);
    expect(events[0].properties).toMatchObject({ agent_kind: "codex" });
    expect(events[1].properties?.review_id).toBe(
      events[2].properties?.review_id,
    );
    expect(JSON.stringify(events)).not.toContain(reviewUuid);
    expect(JSON.stringify(events)).not.toContain("agent-session-secret");
  });

  it("derives installation-scoped opaque review and presentation ids", async () => {
    const reviewUuid = "86df96ed-65ef-46de-9348-c94811e3bb46";
    const otherReviewUuid = "9d64ac3b-4de8-432c-b715-e338492553b9";
    const presentationSessionId = "0f98956f-ec90-45b5-ae21-19acbcd8b6ef";
    const otherPresentationSessionId = "512810fb-dd2a-4f56-9da3-bb5c3e3a5bcf";
    const first = createTelemetry({ installationId: "install-123" });
    const second = createTelemetry({ installationId: "install-456" });
    cleanupPaths.push(first.rootPath, second.rootPath);

    await first.telemetry.captureSessionStarted({
      reviewUuid,
      presentationSessionId,
    });
    await first.telemetry.captureUiEvent(
      "review_client_error",
      { error_name: "TypeError" },
      { reviewUuid, presentationSessionId },
    );
    await first.telemetry.captureSessionStarted({
      reviewUuid: otherReviewUuid,
      presentationSessionId: otherPresentationSessionId,
    });
    await second.telemetry.captureSessionStarted({
      reviewUuid,
      presentationSessionId,
    });

    const firstIds = first.events[0].properties!;
    const repeatedIds = first.events[1].properties!;
    const otherEntityIds = first.events[2].properties!;
    const otherInstallIds = second.events[0].properties!;
    expect(firstIds.review_id).toMatch(/^rv_[A-Za-z0-9_-]{22}$/);
    expect(firstIds.presentation_id).toMatch(/^pr_[A-Za-z0-9_-]{22}$/);
    expect(repeatedIds.review_id).toBe(firstIds.review_id);
    expect(repeatedIds.presentation_id).toBe(firstIds.presentation_id);
    expect(otherEntityIds.review_id).not.toBe(firstIds.review_id);
    expect(otherEntityIds.presentation_id).not.toBe(firstIds.presentation_id);
    expect(otherInstallIds.review_id).not.toBe(firstIds.review_id);
    expect(otherInstallIds.presentation_id).not.toBe(firstIds.presentation_id);
    expect(JSON.stringify([...first.events, ...second.events])).not.toContain(
      reviewUuid,
    );
    expect(JSON.stringify([...first.events, ...second.events])).not.toContain(
      presentationSessionId,
    );
  });

  it("leaves global client errors unscoped", async () => {
    const { events, rootPath, telemetry } = createTelemetry();
    cleanupPaths.push(rootPath);

    await telemetry.captureUiEvent("review_client_error", {
      error_process: "main",
      error_name: "TypeError",
    });

    expect(events).toHaveLength(1);
    expect(events[0].properties).not.toHaveProperty("review_id");
    expect(events[0].properties).not.toHaveProperty("presentation_id");
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

function createTelemetry(input?: {
  env?: NodeJS.ProcessEnv;
  installationId?: string;
  commandRunId?: string;
}): {
  configPath: string;
  events: PostHogCaptureInput[];
  legacyConfigPath: string;
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
  const legacyConfigPath = path.join(rootPath, "legacy.json");
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
    legacyInstallConfigPath: legacyConfigPath,
    idFactory: () => input?.installationId ?? "install-123",
    ...(input?.commandRunId ? { randomUUID: () => input.commandRunId! } : {}),
    now: () => new Date("2026-01-02T03:04:05.000Z"),
  });
  return { configPath, events, legacyConfigPath, rootPath, telemetry };
}

function storedConfig(
  input: Partial<ProgressiveReviewTelemetryInstallConfig> = {},
): ProgressiveReviewTelemetryInstallConfig {
  return {
    installationId: "stored-install",
    createdAt: "2025-01-02T03:04:05.000Z",
    installationCreatedSent: false,
    enabled: true,
    internal: false,
    ...input,
  };
}

async function writeStoredConfig(
  configPath: string,
  config: unknown,
): Promise<void> {
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

async function readStoredConfig(
  configPath: string,
): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(configPath, "utf8")) as Record<
    string,
    unknown
  >;
}

async function progressiveReviewPackageVersion(): Promise<string> {
  const packageRoot = findProgressiveReviewPackageRoot(import.meta.url);
  const packageJson = JSON.parse(
    await readFile(path.join(packageRoot, "package.json"), "utf8"),
  ) as { version: string };
  return packageJson.version;
}
