import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  type JsonObject,
  isJsonObject,
  parseJsonText,
} from "@dev.fast/review-protocol";
import { withFileLock } from "@dev.fast/trace-core";
import { afterEach, describe, expect, it } from "vitest";

import { findReviewPackageRoot } from "./package-paths";
import type {
  PostHogCaptureInput,
  PostHogCaptureProperties,
} from "./posthog-capture-client";
import { DEV_REVIEW_HOME_ENV } from "./review-home-paths";
import {
  REVIEW_APP_SESSION_ID_ENV,
  REVIEW_APP_VERSION_ENV,
  ReviewTelemetry,
  type ReviewTelemetryCaptureClient,
  type ReviewTelemetryOptions,
  accountAlias,
} from "./review-telemetry";
import { recordOpenSession } from "./session-markers";
import {
  REVIEW_CHANNEL_ENV,
  REVIEW_TELEMETRY_ENV_ENV,
  type ReviewTelemetryInstallConfig,
  normalizeTelemetryInstallConfig,
} from "./telemetry-config";

// A process that has exited: the owner of a session that died with it.
const deadPid = spawnSync(process.execPath, ["-e", ""]).pid;

// Two Desktop launches' session ids, UUIDv7 as Electron main mints them.
const LAUNCH_A = "01997a3c-8f10-7a2b-9c3d-4e5f60718293";

const LAUNCH_B = "01997a3d-0000-7bcd-8ef0-123456789abc";

const DAY_MS = 24 * 60 * 60 * 1000;

const COMMAND = { command: "info", commandRunId: "run-12345678" } as const;

describe("ReviewTelemetry", () => {
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
      command: "info",
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
      surface: "cli",
      command_path: "info",
      exit_code: 0,
      has_base_ref: false,
    });
    await expect(readFile(configPath, "utf8")).resolves.toContain(
      '"installationCreatedSent": true',
    );
  });

  it("aliases the install to the first hashed account id only, and turns person profiles on", async () => {
    const { configPath, events, rootPath, telemetry } = createTelemetry();
    cleanupPaths.push(rootPath);
    await telemetry.captureCommandSucceeded({
      command: "info",
      commandRunId: "run-1",
      exitCode: 0,
    });
    expect(events[0].properties).toMatchObject({
      $process_person_profile: false,
    });

    await telemetry.captureAccountAlias("account-12345");
    await telemetry.captureAccountAlias("account-12345");
    await telemetry.captureCommandSucceeded({
      command: "info",
      commandRunId: "run-2",
      exitCode: 0,
    });

    const aliases = events.filter((event) => event.event === "$create_alias");
    expect(aliases).toHaveLength(1);
    expect(aliases[0].distinctId).toBe(events[0].distinctId);
    expect(aliases[0].properties).toMatchObject({
      alias: accountAlias("account-12345"),
      $process_person_profile: true,
    });
    expect(accountAlias("account-12345")).toMatch(/^gh_[A-Za-z0-9_-]{22}$/);
    expect(JSON.stringify(events)).not.toContain("account-12345");
    expect(events.at(-1)?.properties).toMatchObject({
      $process_person_profile: true,
    });
    expect(JSON.parse(await readFile(configPath, "utf8")).accountAlias).toBe(
      accountAlias("account-12345"),
    );

    // The first account wins: another login must not merge a second account
    // into this install's person.
    await telemetry.captureAccountAlias("account-67890");
    expect(
      events.filter((event) => event.event === "$create_alias"),
    ).toHaveLength(1);
    expect(JSON.parse(await readFile(configPath, "utf8")).accountAlias).toBe(
      accountAlias("account-12345"),
    );
  });

  it("records tool calls, keeping only identifier-shaped tool names", async () => {
    const { events, rootPath, telemetry } = createTelemetry();
    cleanupPaths.push(rootPath);

    await telemetry.captureToolCalled({
      tool: "session_create",
      via: "mcp",
      ok: true,
      durationMs: 41.6,
    });
    await telemetry.captureToolCalled({
      tool: "Weird Name/../x",
      via: "api",
      ok: false,
      durationMs: -1,
    });

    expect(
      events.map(({ event, properties }) => [
        event,
        properties?.tool,
        properties?.via,
        properties?.ok,
        properties?.duration_ms,
      ]),
    ).toEqual([
      ["review_mcp_tool_called", "session_create", "mcp", true, 42],
      ["review_mcp_tool_called", "other", "api", false, 0],
    ]);
  });

  it("sends a $exception twin after every client error", async () => {
    const { events, rootPath, telemetry } = createTelemetry();
    cleanupPaths.push(rootPath);

    await telemetry.captureUiEvent("review_client_error", {
      error_source: "window",
      error_process: "canvas",
      error_name: "TypeError",
      message_hash: "0123456789abcdef",
    });

    expect(events.map((event) => event.event)).toEqual([
      "review_client_error",
      "$exception",
    ]);
    expect(events[1].properties).toMatchObject({
      source: "review_app",
      error_name: "TypeError",
      $exception_fingerprint: "0123456789abcdef",
    });
  });

  it("sends one envelope on every event", async () => {
    const { events, rootPath, telemetry } = createTelemetry({
      env: {
        PROGRESSIVE_REVIEW_TELEMETRY_INTERNAL: "1",
        [REVIEW_APP_VERSION_ENV]: "0.0.34",
        [REVIEW_CHANNEL_ENV]: "preview",
        [REVIEW_APP_SESSION_ID_ENV]: "app-session-1",
      },
      surface: "desktop",
    });

    cleanupPaths.push(rootPath);

    await telemetry.captureCommandSucceeded({
      command: "info",
      commandRunId: "run-12345678",
      exitCode: 0,
    });

    expect(events).toHaveLength(1);
    const version = await reviewPackageVersion();
    expect(events[0].properties).toMatchObject({
      cli_version: version,
      version,
      app_version: "0.0.34",
      channel: "preview",
      environment: "internal",
      surface: "desktop",
      internal: true,
      ci: false,
      platform: process.platform,
      arch: process.arch,
      os_version: os.release(),
      app_session_id: "app-session-1",
    });
    expect(events[0].properties).not.toHaveProperty("product");
    expect(events[0].properties).not.toHaveProperty("package");
    // PostHog accepts only a UUIDv7 as a session id.
    expect(events[0].properties).not.toHaveProperty("$session_id");
  });

  it("sends the install's age in whole days since it was created", async () => {
    let clock = Date.parse("2026-01-02T03:04:05.000Z");

    const { configPath, events, rootPath, telemetry } = createTelemetry({
      now: () => new Date(clock),
    });

    cleanupPaths.push(rootPath);
    await telemetry.captureCommandStarted(COMMAND);
    clock += 3.5 * DAY_MS;
    await telemetry.captureCommandStarted(COMMAND);

    expect(events.map((event) => event.properties?.install_age_days)).toEqual([
      0, 3,
    ]);
    await expect(readStoredConfig(configPath)).resolves.toMatchObject({
      createdAt: "2026-01-02T03:04:05.000Z",
    });
    await expect(telemetry.envelope()).resolves.toMatchObject({
      install_age_days: 3,
    });
  });

  it("counts an existing install's age from the first time an upgrade saw it", async () => {
    let clock = Date.parse("2026-01-02T03:04:05.000Z");

    const { configPath, events, rootPath, telemetry } = createTelemetry({
      now: () => new Date(clock),
    });

    cleanupPaths.push(rootPath);
    await writeStoredConfig(configPath, {
      installationId: "existing-install",
      installationCreatedSent: true,
      enabled: true,
    });

    await telemetry.captureCommandStarted(COMMAND);
    clock += 10 * DAY_MS;
    await telemetry.flush();
    await telemetry.captureCommandStarted(COMMAND);

    expect(events.map((event) => event.properties?.install_age_days)).toEqual([
      0, 10,
    ]);
    await expect(readStoredConfig(configPath)).resolves.toMatchObject({
      installationId: "existing-install",
      createdAt: "2026-01-02T03:04:05.000Z",
    });
  });

  it("does not let an opt-out check fix the backfilled creation time", async () => {
    let clock = Date.parse("2026-01-02T03:04:05.000Z");

    const { configPath, events, rootPath, telemetry } = createTelemetry({
      now: () => new Date(clock),
    });

    cleanupPaths.push(rootPath);
    await writeStoredConfig(configPath, { installationId: "existing-install" });

    // Reads the config before anything has written the backfill.
    await telemetry.flush();
    clock += DAY_MS;
    await telemetry.captureCommandStarted(COMMAND);
    clock += 2 * DAY_MS;
    await telemetry.captureCommandStarted(COMMAND);

    expect(events.map((event) => event.properties?.install_age_days)).toEqual([
      0, 2,
    ]);
    await expect(readStoredConfig(configPath)).resolves.toMatchObject({
      createdAt: "2026-01-03T03:04:05.000Z",
    });
  });

  it("mirrors a UUIDv7 app session id into $session_id, following any override", async () => {
    const { events, rootPath, telemetry } = createTelemetry({
      env: { [REVIEW_APP_SESSION_ID_ENV]: LAUNCH_A },
      surface: "desktop",
    });

    cleanupPaths.push(rootPath);

    await telemetry.captureCommandStarted({
      command: "info",
      commandRunId: "run-12345678",
    });
    await telemetry.captureTabViewed({
      tab: "map",
      durationMs: 300,
      reason: "tab_change",
      appSessionId: LAUNCH_B,
    });
    await telemetry.captureUiEvent("review_app_opened", {
      app_session_id: "canvas-fallback-0123456789",
    });

    expect(
      events.map(({ properties }) => [
        properties?.app_session_id,
        properties?.$session_id,
      ]),
    ).toEqual([
      [LAUNCH_A, LAUNCH_A],
      [LAUNCH_B, LAUNCH_B],
      ["canvas-fallback-0123456789", undefined],
    ]);
    expect(events[2].properties).not.toHaveProperty("$session_id");
    await expect(telemetry.envelope()).resolves.toMatchObject({
      app_session_id: LAUNCH_A,
      $session_id: LAUNCH_A,
    });
  });

  it("defaults to the cli surface and the stable channel", async () => {
    const { events, rootPath, telemetry } = createTelemetry({
      env: { PROGRESSIVE_REVIEW_TELEMETRY_INTERNAL: "0" },
    });

    cleanupPaths.push(rootPath);
    await telemetry.captureCommandStarted({
      command: "info",
      commandRunId: "run-12345678",
    });

    expect(events[0].properties).toMatchObject({
      surface: "cli",
      channel: "stable",
      environment: "production",
    });
    expect(events[0].properties).not.toHaveProperty("app_session_id");
  });

  it("exposes the envelope for bug reports and persists the internal marker", async () => {
    const { configPath, rootPath, telemetry } = createTelemetry();

    cleanupPaths.push(rootPath);
    await telemetry.setInternal(true);

    await expect(readStoredConfig(configPath)).resolves.toMatchObject({
      internal: true,
    });
    await expect(telemetry.envelope()).resolves.toMatchObject({
      internal: true,
      environment: "internal",
      surface: "cli",
    });
  });

  it.each([
    ["absent", {}, false],
    ["false", { internal: false }, false],
    ["true", { internal: true }, true],
    ["invalid", { internal: "true" }, false],
  ])("normalizes the %s stored internal marker", (_name, marker, expected) => {
    const config = normalizeTelemetryInstallConfig(
      { installationId: "existing-install", ...marker },
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

  it("never announces a legacy installation as newly created", async () => {
    const { configPath, events, legacyConfigPath, rootPath, telemetry } =
      createTelemetry();

    cleanupPaths.push(rootPath);
    await writeStoredConfig(legacyConfigPath, { installId: "legacy-install" });

    await telemetry.captureInstallationCreated();

    expect(events).toEqual([]);
    await expect(readStoredConfig(configPath)).resolves.toMatchObject({
      installationId: "legacy-install",
      installationCreatedSent: true,
    });
  });

  it("gives a preview channel its own identity instead of the legacy one", async () => {
    const { events, legacyConfigPath, rootPath, telemetry } = createTelemetry({
      env: { [REVIEW_CHANNEL_ENV]: "preview" },
    });

    cleanupPaths.push(rootPath);
    await writeStoredConfig(legacyConfigPath, { installId: "legacy-install" });

    await telemetry.captureInstallationCreated();

    expect(events.map((event) => event.distinctId)).toEqual(["install-123"]);
  });

  it("marks the installation as announced before the event is queued", async () => {
    const { configPath, rootPath, telemetry } = createTelemetry({
      captureClient: {
        enabled: true,
        capture: async () => {
          throw new Error("queue is full");
        },
      },
    });

    cleanupPaths.push(rootPath);

    await telemetry.captureInstallationCreated().catch(() => undefined);

    await expect(readStoredConfig(configPath)).resolves.toMatchObject({
      installationCreatedSent: true,
    });
  });

  it("labels every later event and the envelope with a changed surface", async () => {
    const { captureClient, events, rootPath, telemetry } = createTelemetry();
    cleanupPaths.push(rootPath);

    telemetry.setSurface("headless");
    await telemetry.captureInstallationCreated();
    await telemetry.captureCommandStarted({
      command: "server.start",
      commandRunId: "run-12345678",
    });

    expect(events.map((event) => event.properties?.surface)).toEqual([
      "headless",
      "headless",
    ]);
    expect(captureClient.defaults).toMatchObject({ surface: "headless" });
  });

  it("sends events only through a real client with telemetry on", async () => {
    const enabled = createTelemetry();
    cleanupPaths.push(enabled.rootPath);
    await expect(enabled.telemetry.sendsEvents()).resolves.toBe(true);
    await enabled.telemetry.setEnabled(false);
    await expect(enabled.telemetry.sendsEvents()).resolves.toBe(false);

    const printed = createTelemetry({
      captureClient: {
        enabled: true,
        ignoresOptOut: true,
        capture: async () => undefined,
      },
    });

    cleanupPaths.push(printed.rootPath);
    await expect(printed.telemetry.sendsEvents()).resolves.toBe(false);
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

    await telemetry.captureUiEvent("review_app_opened", {});

    expect(events).toHaveLength(1);
    expect(events[0].properties).toMatchObject({
      version: await reviewPackageVersion(),
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

      await telemetry.captureUiEvent("review_app_opened", {});

      expect(events).toHaveLength(1);
      expect(events[0].properties).not.toHaveProperty("app_version");
    },
  );

  it("does not write config or send events when DO_NOT_TRACK is set", async () => {
    const { configPath, events, markersPath, rootPath, telemetry } =
      createTelemetry({
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

    const context = {
      reviewUuid: "86df96ed-65ef-46de-9348-c94811e3bb46",
      presentationSessionId: "0f98956f-ec90-45b5-ae21-19acbcd8b6ef",
    };

    await telemetry.captureUiEvent("review_session_started", {}, context);
    await telemetry.captureUiEvent("review_review_presented", {}, context);

    expect(events).toEqual([]);
    await expect(readFile(configPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(existsSync(markersPath)).toBe(false);
  });

  it("captures only closed error values", async () => {
    const { events, rootPath, telemetry } = createTelemetry();
    cleanupPaths.push(rootPath);

    await telemetry.captureCommandFailed({
      command: "info",
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

  it("keeps one command run id across start and completion", async () => {
    const { events, rootPath, telemetry } = createTelemetry({
      env: { CODEX_THREAD_ID: "agent-session-secret" },
      commandRunId: "8b733d48-1172-46a7-9df0-3cc71930c25a",
    });

    cleanupPaths.push(rootPath);
    const commandRunId = telemetry.createCommandRunId();

    await telemetry.captureCommandStarted({
      command: "info",
      commandRunId,
    });
    await telemetry.captureCommandSucceeded({
      command: "info",
      commandRunId,
      exitCode: 0,
    });

    expect(events.map((event) => event.event)).toEqual([
      "review_command_started",
      "review_command_succeeded",
    ]);
    expect(events.map((event) => event.properties?.command_run_id)).toEqual([
      commandRunId,
      commandRunId,
    ]);
    expect(events[0].properties).toMatchObject({ agent_kind: "codex" });
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

    await first.telemetry.captureUiEvent(
      "review_session_started",
      {},
      { reviewUuid, presentationSessionId },
    );
    await first.telemetry.captureUiEvent(
      "review_client_error",
      { error_name: "TypeError" },
      { reviewUuid, presentationSessionId },
    );
    await first.telemetry.captureUiEvent(
      "review_session_started",
      {},
      {
        reviewUuid: otherReviewUuid,
        presentationSessionId: otherPresentationSessionId,
      },
    );
    await second.telemetry.captureUiEvent(
      "review_session_started",
      {},
      { reviewUuid, presentationSessionId },
    );

    // events[2] is the client error's $exception twin, scoped the same way.
    const firstIds = first.events[0].properties!;
    const repeatedIds = first.events[1].properties!;
    const twinIds = first.events[2].properties!;
    const otherEntityIds = first.events[3].properties!;
    const otherInstallIds = second.events[0].properties!;
    expect(firstIds.review_id).toMatch(/^rv_[A-Za-z0-9_-]{22}$/);
    expect(firstIds.presentation_id).toMatch(/^pr_[A-Za-z0-9_-]{22}$/);
    expect(repeatedIds.review_id).toBe(firstIds.review_id);
    expect(repeatedIds.presentation_id).toBe(firstIds.presentation_id);
    expect(twinIds.review_id).toBe(firstIds.review_id);
    expect(twinIds.presentation_id).toBe(firstIds.presentation_id);
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

  it("keeps an open-session marker until the session ends", async () => {
    const { markersPath, rootPath, telemetry } = createTelemetry();
    cleanupPaths.push(rootPath);

    const context = {
      reviewUuid: "86df96ed-65ef-46de-9348-c94811e3bb46",
      presentationSessionId: "0f98956f-ec90-45b5-ae21-19acbcd8b6ef",
    };

    await telemetry.captureUiEvent(
      "review_session_started",
      { app_session_id: "app-1" },
      context,
    );
    expect(JSON.parse(await readFile(markersPath, "utf8"))).toMatchObject([
      {
        presentationSessionId: context.presentationSessionId,
        reviewUuid: context.reviewUuid,
        appSessionId: "app-1",
      },
    ]);

    await telemetry.captureUiEvent(
      "review_session_ended",
      { outcome: "closed", duration_ms: 10 },
      context,
    );
    expect(JSON.parse(await readFile(markersPath, "utf8"))).toEqual([]);
  });

  it("closes sessions that died with the previous process as abnormal", async () => {
    const { events, markersPath, rootPath, telemetry } = createTelemetry();
    cleanupPaths.push(rootPath);

    const context = {
      reviewUuid: "86df96ed-65ef-46de-9348-c94811e3bb46",
      presentationSessionId: "0f98956f-ec90-45b5-ae21-19acbcd8b6ef",
    };

    await telemetry.captureUiEvent("review_session_started", {}, context);
    events.length = 0;

    await telemetry.reconcileOpenSessions();

    expect(events).toHaveLength(1);
    expect(events[0].event).toBe("review_session_ended");
    expect(events[0].properties).toMatchObject({
      outcome: "abnormal",
      source: "review_app",
    });
    expect(events[0].properties?.review_id).toMatch(/^rv_/);
    expect(events[0].properties?.presentation_id).toMatch(/^pr_/);
    expect(JSON.stringify(events)).not.toContain(context.reviewUuid);
    expect(existsSync(markersPath)).toBe(false);
  });

  it("leaves sessions of the current app launch open across a server restart", async () => {
    const env = { [REVIEW_APP_SESSION_ID_ENV]: "app-current" };

    const { events, markersPath, rootPath, telemetry } = createTelemetry({
      env,
    });

    cleanupPaths.push(rootPath);

    const live = {
      reviewUuid: "86df96ed-65ef-46de-9348-c94811e3bb46",
      presentationSessionId: "0f98956f-ec90-45b5-ae21-19acbcd8b6ef",
    };

    const stale = {
      reviewUuid: "9d64ac3b-4de8-432c-b715-e338492553b9",
      presentationSessionId: "512810fb-dd2a-4f56-9da3-bb5c3e3a5bcf",
    };

    await telemetry.captureUiEvent(
      "review_session_started",
      { app_session_id: "app-current" },
      live,
    );
    await telemetry.captureUiEvent(
      "review_session_started",
      { app_session_id: "app-previous" },
      stale,
    );
    events.length = 0;

    await telemetry.reconcileOpenSessions();

    expect(events).toHaveLength(1);
    expect(events[0].properties).toMatchObject({
      outcome: "abnormal",
      app_session_id: "app-previous",
    });
    expect(JSON.parse(await readFile(markersPath, "utf8"))).toMatchObject([
      {
        presentationSessionId: live.presentationSessionId,
        appSessionId: "app-current",
      },
    ]);
  });

  it("does not attribute an abnormal end to the current app launch", async () => {
    const { events, markersPath, rootPath, telemetry } = createTelemetry({
      env: { [REVIEW_APP_SESSION_ID_ENV]: "app-current" },
    });

    cleanupPaths.push(rootPath);
    recordOpenSession(markersPath, {
      presentationSessionId: "0f98956f-ec90-45b5-ae21-19acbcd8b6ef",
      reviewUuid: "86df96ed-65ef-46de-9348-c94811e3bb46",
      startedAt: 1,
    });

    await telemetry.reconcileOpenSessions();

    expect(events).toHaveLength(1);
    expect(events[0].properties).toMatchObject({ outcome: "abnormal" });
    expect(events[0].properties?.app_session_id).not.toBe("app-current");
  });

  it("attributes an abnormal end to the launch that opened the session", async () => {
    const rootPath = path.join(
      os.tmpdir(),
      `progressive-review-telemetry-upgrade-${Date.now()}`,
    );

    cleanupPaths.push(rootPath);

    const markersPath = path.join(rootPath, "open-sessions.json");

    const launch = (env: NodeJS.ProcessEnv) => {
      const events: PostHogCaptureInput[] = [];

      const telemetry = new ReviewTelemetry({
        captureClient: {
          enabled: true,
          capture: async (event) => {
            events.push(event);
          },
        },
        env,
        installConfigPath: path.join(rootPath, "telemetry.json"),
        openSessionMarkersPath: markersPath,
        openSessionOwnerPid: deadPid,
        surface: "desktop",
      });

      return { events, telemetry };
    };

    const versionA = launch({
      [REVIEW_APP_VERSION_ENV]: "1.0.0",
      [REVIEW_APP_SESSION_ID_ENV]: LAUNCH_A,
      [REVIEW_TELEMETRY_ENV_ENV]: "e2e",
    });

    await versionA.telemetry.captureUiEvent(
      "review_session_started",
      { app_session_id: LAUNCH_A },
      {
        reviewUuid: "86df96ed-65ef-46de-9348-c94811e3bb46",
        presentationSessionId: "0f98956f-ec90-45b5-ae21-19acbcd8b6ef",
      },
    );

    // Version A shipped an older CLI package than the one under test.
    const [marker] = JSON.parse(await readFile(markersPath, "utf8")) as {
      envelope: JsonObject;
    }[];

    expect(marker.envelope.$session_id).toBe(LAUNCH_A);
    expect(marker.envelope.install_age_days).toBe(0);
    marker.envelope.cli_version = "0.9.0";
    marker.envelope.install_age_days = 7;
    marker.envelope.version = "0.9.0";
    await writeFile(markersPath, JSON.stringify([marker]));

    const versionB = launch({
      [REVIEW_APP_VERSION_ENV]: "2.0.0",
      [REVIEW_APP_SESSION_ID_ENV]: LAUNCH_B,
    });

    await versionB.telemetry.reconcileOpenSessions();

    expect(versionB.events).toHaveLength(1);
    expect(versionB.events[0].properties).toMatchObject({
      outcome: "abnormal",
      app_session_id: LAUNCH_A,
      $session_id: LAUNCH_A,
      install_age_days: 7,
      app_version: "1.0.0",
      cli_version: "0.9.0",
      version: "0.9.0",
      environment: "e2e",
      surface: "desktop",
    });
  });

  it("reconciles a marker written before launches stored their envelope", async () => {
    const { events, markersPath, rootPath, telemetry } = createTelemetry({
      env: { [REVIEW_APP_VERSION_ENV]: "2.0.0" },
    });

    cleanupPaths.push(rootPath);
    await mkdir(rootPath, { recursive: true });
    await writeFile(
      markersPath,
      JSON.stringify([
        {
          presentationSessionId: "0f98956f-ec90-45b5-ae21-19acbcd8b6ef",
          reviewUuid: "86df96ed-65ef-46de-9348-c94811e3bb46",
          startedAt: 1,
          appSessionId: "app-a",
        },
      ]),
    );

    await telemetry.reconcileOpenSessions();

    expect(events).toHaveLength(1);
    expect(events[0].properties).toMatchObject({
      outcome: "abnormal",
      app_session_id: "app-a",
      app_version: "2.0.0",
    });
  });

  it("stamps a session start before it waits for the marker lock", async () => {
    let clock = Date.parse("2026-01-02T03:04:05.000Z");

    const { events, markersPath, rootPath, telemetry } = createTelemetry({
      now: () => new Date(clock),
    });

    cleanupPaths.push(rootPath);

    const context = {
      reviewUuid: "86df96ed-65ef-46de-9348-c94811e3bb46",
      presentationSessionId: "0f98956f-ec90-45b5-ae21-19acbcd8b6ef",
    };

    // Another Desktop holds the shared marker file while this session starts.
    let release = () => {};

    const held = withFileLock(
      `${markersPath}.lock`,
      {
        retryMs: 10,
        staleMs: 30_000,
        timeoutMs: 1_000,
        unownedGraceMs: 1_000,
        heartbeatMs: 5_000,
      },
      () => new Promise<void>((resolve) => (release = resolve)),
    );

    await new Promise((resolve) => setTimeout(resolve, 20));

    const started = telemetry.captureUiEvent(
      "review_session_started",
      {},
      context,
    );

    clock += 5;
    await telemetry.captureUiEvent(
      "review_review_presented",
      { load_ms: 5 },
      context,
    );
    release();
    await Promise.all([held, started]);

    const at = (name: string) =>
      events.find((event) => event.event === name)?.timestamp;

    // Delivered out of order, stamped in order.
    expect(
      events
        .map((event) => event.event)
        .filter((name) => name !== "review_first_review_presented"),
    ).toEqual(["review_review_presented", "review_session_started"]);
    expect(at("review_session_started")).toBeLessThan(
      at("review_review_presented")!,
    );
  });

  it("does not hold the shared markers lock while it waits on its own config", async () => {
    const { configPath, markersPath, rootPath, telemetry } = createTelemetry();
    cleanupPaths.push(rootPath);
    await mkdir(rootPath, { recursive: true });

    const lockOptions = {
      retryMs: 10,
      staleMs: 30_000,
      timeoutMs: 1_000,
      unownedGraceMs: 1_000,
      heartbeatMs: 5_000,
    };

    // A slow config lock (another process rewriting the telemetry config).
    let releaseConfig = () => {};

    const configHeld = withFileLock(
      `${configPath}.lock`,
      lockOptions,
      () => new Promise<void>((resolve) => (releaseConfig = resolve)),
    );

    await new Promise((resolve) => setTimeout(resolve, 20));

    const started = telemetry.captureUiEvent(
      "review_session_started",
      {},
      {
        reviewUuid: "86df96ed-65ef-46de-9348-c94811e3bb46",
        presentationSessionId: "0f98956f-ec90-45b5-ae21-19acbcd8b6ef",
      },
    );

    await new Promise((resolve) => setTimeout(resolve, 30));

    // Another Desktop on this home can still take the markers lock.
    const other = await withFileLock(
      `${markersPath}.lock`,
      { ...lockOptions, timeoutMs: 50 },
      async () => undefined,
    );

    releaseConfig();
    await Promise.all([configHeld, started]);

    expect(other.acquired).toBe(true);

    const [marker] = JSON.parse(await readFile(markersPath, "utf8")) as {
      envelope?: JsonObject;
    }[];

    expect(marker.envelope).toMatchObject({ surface: "cli" });
  });

  it("leaves sessions owned by a live process open", async () => {
    const { events, markersPath, rootPath, telemetry } = createTelemetry();
    cleanupPaths.push(rootPath);

    const live = {
      presentationSessionId: "0f98956f-ec90-45b5-ae21-19acbcd8b6ef",
      reviewUuid: "86df96ed-65ef-46de-9348-c94811e3bb46",
      startedAt: 1,
      ownerPid: process.pid,
    };

    recordOpenSession(markersPath, live);
    recordOpenSession(markersPath, {
      presentationSessionId: "512810fb-dd2a-4f56-9da3-bb5c3e3a5bcf",
      reviewUuid: "9d64ac3b-4de8-432c-b715-e338492553b9",
      startedAt: 2,
      ownerPid: deadPid,
    });

    await telemetry.reconcileOpenSessions();

    expect(events).toHaveLength(1);
    expect(events[0].properties).toMatchObject({ outcome: "abnormal" });
    expect(JSON.parse(await readFile(markersPath, "utf8"))).toEqual([live]);
  });

  it("lets two live Desktops on one home keep each other's sessions open", async () => {
    const rootPath = path.join(
      os.tmpdir(),
      `progressive-review-telemetry-desktops-${Date.now()}`,
    );

    cleanupPaths.push(rootPath);

    // Two dev checkouts share a home and a channel, so they share one file.
    const desktop = (appSessionId: string, ownerPid: number) => {
      const events: PostHogCaptureInput[] = [];

      const telemetry = new ReviewTelemetry({
        captureClient: {
          enabled: true,
          capture: async (event) => {
            events.push(event);
          },
        },
        env: {
          [DEV_REVIEW_HOME_ENV]: rootPath,
          [REVIEW_CHANNEL_ENV]: "dev",
          [REVIEW_APP_SESSION_ID_ENV]: appSessionId,
        },
        openSessionOwnerPid: ownerPid,
      });

      const sessionIds = [1, 2, 3].map(
        (index) => `${appSessionId}-presentation-${index}`,
      );

      const start = () =>
        Promise.all(
          sessionIds.map((presentationSessionId) =>
            telemetry.captureUiEvent(
              "review_session_started",
              { app_session_id: appSessionId },
              { reviewUuid: `${appSessionId}-review`, presentationSessionId },
            ),
          ),
        );

      return { events, sessionIds, start, telemetry };
    };

    const first = desktop("app-first", process.pid);
    const second = desktop("app-second", process.ppid);
    const markersPath = path.join(rootPath, "telemetry", "open-sessions.json");

    const openIds = async () =>
      (
        JSON.parse(await readFile(markersPath, "utf8")) as {
          presentationSessionId: string;
        }[]
      )
        .map((marker) => marker.presentationSessionId)
        .sort();

    await Promise.all([first.start(), second.start()]);
    await expect(openIds()).resolves.toEqual(
      [...first.sessionIds, ...second.sessionIds].sort(),
    );

    second.events.length = 0;
    await second.telemetry.reconcileOpenSessions();
    expect(second.events).toEqual([]);

    await first.telemetry.captureUiEvent(
      "review_session_ended",
      { outcome: "closed", duration_ms: 10 },
      {
        reviewUuid: "app-first-review",
        presentationSessionId: first.sessionIds[0],
      },
    );
    await expect(openIds()).resolves.toEqual(
      [...first.sessionIds.slice(1), ...second.sessionIds].sort(),
    );
  });

  it("forgets open sessions when telemetry is turned off", async () => {
    const { events, markersPath, rootPath, telemetry } = createTelemetry();
    cleanupPaths.push(rootPath);
    await telemetry.captureUiEvent(
      "review_session_started",
      {},
      {
        reviewUuid: "86df96ed-65ef-46de-9348-c94811e3bb46",
        presentationSessionId: "0f98956f-ec90-45b5-ae21-19acbcd8b6ef",
      },
    );

    await telemetry.setEnabled(false);
    await telemetry.setEnabled(true);
    events.length = 0;
    await telemetry.reconcileOpenSessions();

    expect(existsSync(markersPath)).toBe(false);
    expect(events).toEqual([]);
  });

  it("keeps each channel's open sessions to itself", async () => {
    const rootPath = path.join(
      os.tmpdir(),
      `progressive-review-telemetry-channels-${Date.now()}`,
    );

    cleanupPaths.push(rootPath);

    const channel = (name: "stable" | "preview") => {
      const events: PostHogCaptureInput[] = [];

      const telemetry = new ReviewTelemetry({
        captureClient: {
          enabled: true,
          capture: async (event) => {
            events.push(event);
          },
        },
        env: { [DEV_REVIEW_HOME_ENV]: rootPath, [REVIEW_CHANNEL_ENV]: name },
        openSessionOwnerPid: deadPid,
      });

      return { events, telemetry };
    };

    const stable = channel("stable");
    const preview = channel("preview");

    await stable.telemetry.captureUiEvent(
      "review_session_started",
      {},
      {
        reviewUuid: "86df96ed-65ef-46de-9348-c94811e3bb46",
        presentationSessionId: "0f98956f-ec90-45b5-ae21-19acbcd8b6ef",
      },
    );
    await preview.telemetry.reconcileOpenSessions();
    await preview.telemetry.setEnabled(false);
    stable.events.length = 0;
    await stable.telemetry.reconcileOpenSessions();

    expect(preview.events.map((event) => event.event)).not.toContain(
      "review_session_ended",
    );
    expect(stable.events.map((event) => event.event)).toEqual([
      "review_session_ended",
    ]);
  });

  it("announces the first presented review once per installation", async () => {
    const { configPath, events, rootPath, telemetry } = createTelemetry();
    cleanupPaths.push(rootPath);

    const context = {
      reviewUuid: "86df96ed-65ef-46de-9348-c94811e3bb46",
      presentationSessionId: "0f98956f-ec90-45b5-ae21-19acbcd8b6ef",
    };

    await telemetry.captureUiEvent(
      "review_review_presented",
      { load_ms: 120 },
      context,
    );
    await telemetry.captureUiEvent(
      "review_review_presented",
      { load_ms: 80 },
      context,
    );

    expect(events.map((event) => event.event)).toEqual([
      "review_review_presented",
      "review_first_review_presented",
      "review_review_presented",
    ]);
    expect(events[1].properties?.review_id).toMatch(/^rv_/);
    await expect(readStoredConfig(configPath)).resolves.toMatchObject({
      firstReviewPresentedSent: true,
    });
  });

  it("leaves global client errors unscoped", async () => {
    const { events, rootPath, telemetry } = createTelemetry();
    cleanupPaths.push(rootPath);

    await telemetry.captureUiEvent("review_client_error", {
      error_process: "main",
      error_name: "TypeError",
    });

    expect(events.map((event) => event.event)).toEqual([
      "review_client_error",
      "$exception",
    ]);

    for (const event of events) {
      expect(event.properties).not.toHaveProperty("review_id");
      expect(event.properties).not.toHaveProperty("presentation_id");
    }
  });

  it("returns the stable installation id without sending telemetry", async () => {
    const { events, rootPath, telemetry } = createTelemetry();
    cleanupPaths.push(rootPath);

    await telemetry.setEnabled(false);

    await expect(telemetry.getInstallationId()).resolves.toBe("install-123");
    await expect(telemetry.getInstallationId()).resolves.toBe("install-123");
    expect(events).toEqual([]);
  });

  it("hands the envelope to the capture client for its own diagnostics", async () => {
    const { rootPath, telemetry, captureClient } = createTelemetry();
    cleanupPaths.push(rootPath);

    await telemetry.captureCommandStarted({
      command: "info",
      commandRunId: "run-12345678",
    });

    expect(captureClient.defaults).toMatchObject({
      surface: "cli",
      channel: "stable",
    });
  });
});

function createTelemetry(input?: {
  env?: NodeJS.ProcessEnv;
  installationId?: string;
  commandRunId?: string;
  surface?: ReviewTelemetryOptions["surface"];
  captureClient?: ReviewTelemetryCaptureClient;
  ownerPid?: number;
  now?: () => Date;
}) {
  const rootPath = path.join(
    os.tmpdir(),
    `progressive-review-telemetry-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );

  const configPath = path.join(rootPath, "telemetry.json");
  const legacyConfigPath = path.join(rootPath, "legacy.json");
  const markersPath = path.join(rootPath, "open-sessions.json");
  const events: PostHogCaptureInput[] = [];

  const defaultCaptureClient: ReviewTelemetryCaptureClient & {
    defaults?: PostHogCaptureProperties;
  } = {
    enabled: true,
    capture: async (event) => {
      events.push(event);
    },
    setDefaultProperties(properties) {
      defaultCaptureClient.defaults = properties;
    },
  };

  const captureClient: ReviewTelemetryCaptureClient & {
    defaults?: PostHogCaptureProperties;
  } = input?.captureClient ?? defaultCaptureClient;

  const options: ReviewTelemetryOptions = {
    captureClient,
    env: input?.env ?? {},
    installConfigPath: configPath,
    legacyInstallConfigPath: legacyConfigPath,
    openSessionMarkersPath: markersPath,
    openSessionOwnerPid: input?.ownerPid ?? deadPid,
    idFactory: () => input?.installationId ?? "install-123",
    now: input?.now ?? (() => new Date("2026-01-02T03:04:05.000Z")),
    surface: input?.surface,
  };

  const commandRunId = input?.commandRunId;

  if (commandRunId) options.randomUUID = () => commandRunId;
  const telemetry = new ReviewTelemetry(options);

  return {
    captureClient,
    configPath,
    events,
    legacyConfigPath,
    markersPath,
    rootPath,
    telemetry,
  };
}

function storedConfig(
  input: Partial<ReviewTelemetryInstallConfig> = {},
): ReviewTelemetryInstallConfig {
  return {
    installationId: "stored-install",
    createdAt: "2025-01-02T03:04:05.000Z",
    installationCreatedSent: false,
    firstReviewPresentedSent: false,
    enabled: true,
    internal: false,
    ...input,
  };
}

async function writeStoredConfig(
  configPath: string,
  config: Partial<ReviewTelemetryInstallConfig> | { installId: string },
): Promise<void> {
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

async function readStoredConfig(configPath: string): Promise<JsonObject> {
  const value = parseJsonText(await readFile(configPath, "utf8"));

  if (!isJsonObject(value)) {
    throw new Error(`Stored config at ${configPath} is not an object.`);
  }

  return value;
}

async function reviewPackageVersion(): Promise<string> {
  const packageRoot = findReviewPackageRoot(import.meta.url);

  const packageJson = JSON.parse(
    await readFile(path.join(packageRoot, "package.json"), "utf8"),
  ) as { version: string };

  return packageJson.version;
}
