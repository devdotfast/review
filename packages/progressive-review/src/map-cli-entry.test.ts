import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Writable } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import { collectingWritable } from "./cli-output";
import type { runSoftwareMapCli } from "./map-cli";
import { runSoftwareMapCliEntry } from "./map-cli-entry";
import type { ProgressiveReviewCommandTelemetry } from "./progressive-review-telemetry";

const mapMocks = {
  runSoftwareMapCli: vi.fn<typeof runSoftwareMapCli>(),
};

describe("runSoftwareMapCliEntry telemetry", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    vi.unstubAllGlobals();
    mapMocks.runSoftwareMapCli.mockReset();
    await Promise.all(
      tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
    );
    tempDirs.length = 0;
  });

  it.each(["check", "init", "update"] as const)(
    "emits completion telemetry for map %s",
    async (mode) => {
      mapMocks.runSoftwareMapCli.mockResolvedValue(0);
      const telemetry = telemetrySpy();

      const exitCode = await runSoftwareMapCliEntry({
        args: [mode],
        cwd: await tempDir(tempDirs, "progressive-review-map-repo-"),
        env: await telemetryEnv(tempDirs),
        stdout: writableOutput([]),
        stderr: writableOutput([]),
        runSoftwareMapCli: mapMocks.runSoftwareMapCli,
        telemetry,
      });

      expect(exitCode).toBe(0);
      expect(telemetry.captureCommandSucceeded).toHaveBeenCalledWith(
        expect.objectContaining({
          command: mode === "check" ? "map.check" : "invalid",
          properties: expect.objectContaining({
            command: "map",
            subcommand: mode,
            mode,
          }),
        }),
      );
    },
  );

  it("never leaks ref names for the removed update flags", async () => {
    // update's --base/--head are a parse error now; telemetry falls back to
    // check-shaped metadata and must still never carry the ref strings.
    mapMocks.runSoftwareMapCli.mockResolvedValue(0);
    const telemetry = telemetrySpy();

    const exitCode = await runSoftwareMapCliEntry({
      args: [
        "update",
        "--base",
        "secret-base-ref",
        "--head",
        "secret-head-ref",
      ],
      cwd: await tempDir(tempDirs, "progressive-review-map-repo-"),
      env: await telemetryEnv(tempDirs),
      stdout: writableOutput([]),
      stderr: writableOutput([]),
      runSoftwareMapCli: mapMocks.runSoftwareMapCli,
      telemetry,
    });

    expect(exitCode).toBe(0);
    expect(telemetry.captureCommandSucceeded).toHaveBeenCalledWith(
      expect.objectContaining({
        properties: expect.objectContaining({
          command: "map",
          subcommand: "update",
          mode: "check",
          has_base_ref: false,
          has_head_ref: false,
          force: false,
        }),
      }),
    );
    expect(
      JSON.stringify(telemetry.captureCommandSucceeded.mock.calls),
    ).not.toContain("secret-base-ref");
    expect(
      JSON.stringify(telemetry.captureCommandSucceeded.mock.calls),
    ).not.toContain("secret-head-ref");
  });

  it("emits failure telemetry for map command failures", async () => {
    mapMocks.runSoftwareMapCli.mockResolvedValue(1);
    const telemetry = telemetrySpy();

    const exitCode = await runSoftwareMapCliEntry({
      args: ["check"],
      cwd: await tempDir(tempDirs, "progressive-review-map-repo-"),
      env: await telemetryEnv(tempDirs),
      stdout: writableOutput([]),
      stderr: writableOutput([]),
      runSoftwareMapCli: mapMocks.runSoftwareMapCli,
      telemetry,
    });

    expect(exitCode).toBe(1);
    expect(telemetry.captureCommandFailed).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "map.check",
        exitCode: 1,
        errorName: "repository_error",
        errorCategory: "local_state",
        properties: expect.objectContaining({
          command: "map",
          mode: "check",
        }),
      }),
    );
  });
});

async function telemetryEnv(tempDirs: string[]): Promise<NodeJS.ProcessEnv> {
  return {
    DEV_REVIEW_HOME: await tempDir(tempDirs, "progressive-review-map-config-"),
    PROGRESSIVE_REVIEW_POSTHOG_KEY: "test-key",
  };
}

async function tempDir(tempDirs: string[], prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writableOutput(output: string[]): Writable {
  return collectingWritable(output);
}

function telemetrySpy() {
  return {
    createCommandRunId: vi.fn<
      ProgressiveReviewCommandTelemetry["createCommandRunId"]
    >(() => "run-12345678"),
    captureInstallationCreated: vi.fn<
      ProgressiveReviewCommandTelemetry["captureInstallationCreated"]
    >(async () => undefined),
    captureCommandStarted: vi.fn<
      ProgressiveReviewCommandTelemetry["captureCommandStarted"]
    >(async () => undefined),
    captureCommandBound: vi.fn<
      ProgressiveReviewCommandTelemetry["captureCommandBound"]
    >(async () => undefined),
    captureCommandSucceeded: vi.fn<
      ProgressiveReviewCommandTelemetry["captureCommandSucceeded"]
    >(async () => undefined),
    captureCommandFailed: vi.fn<
      ProgressiveReviewCommandTelemetry["captureCommandFailed"]
    >(async () => undefined),
    shutdown: vi.fn<ProgressiveReviewCommandTelemetry["shutdown"]>(
      async () => undefined,
    ),
  } satisfies ProgressiveReviewCommandTelemetry;
}
