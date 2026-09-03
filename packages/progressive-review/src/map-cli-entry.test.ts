import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Writable } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import { collectingWritable } from "./cli-output";

const mapMocks = vi.hoisted(() => ({
  runSoftwareMapCli: vi.fn<typeof import("./map-cli").runSoftwareMapCli>(),
}));

vi.mock("./map-cli", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./map-cli")>();
  return {
    ...actual,
    runSoftwareMapCli: mapMocks.runSoftwareMapCli,
  };
});

const { runSoftwareMapCliEntry } = await import("./map-cli-entry");

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
      const fetchMock = stubPostHog();

      const exitCode = await runSoftwareMapCliEntry({
        args: [mode],
        cwd: await tempDir(tempDirs, "progressive-review-map-repo-"),
        env: await telemetryEnv(tempDirs),
        stdout: writableOutput([]),
        stderr: writableOutput([]),
      });

      expect(exitCode).toBe(0);
      expect(lastCaptureBody(fetchMock).properties).toMatchObject({
        command: "map",
        command_path: mode === "check" ? "map.check" : "invalid",
        subcommand: mode,
        mode,
      });
    },
  );

  it("never leaks ref names for the removed update flags", async () => {
    // update's --base/--head are a parse error now; telemetry falls back to
    // check-shaped metadata and must still never carry the ref strings.
    mapMocks.runSoftwareMapCli.mockResolvedValue(0);
    const fetchMock = stubPostHog();

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
    });

    const body = lastCaptureBody(fetchMock);
    expect(exitCode).toBe(0);
    expect(body.properties).toMatchObject({
      command: "map",
      subcommand: "update",
      mode: "check",
      has_base_ref: false,
      has_head_ref: false,
      force: false,
    });
    expect(JSON.stringify(body)).not.toContain("secret-base-ref");
    expect(JSON.stringify(body)).not.toContain("secret-head-ref");
  });

  it("emits failure telemetry for map command failures", async () => {
    mapMocks.runSoftwareMapCli.mockResolvedValue(1);
    const fetchMock = stubPostHog();

    const exitCode = await runSoftwareMapCliEntry({
      args: ["check"],
      cwd: await tempDir(tempDirs, "progressive-review-map-repo-"),
      env: await telemetryEnv(tempDirs),
      stdout: writableOutput([]),
      stderr: writableOutput([]),
    });

    expect(exitCode).toBe(1);
    expect(lastCaptureBody(fetchMock)).toMatchObject({
      event: "review_command_failed",
      properties: {
        command: "map",
        mode: "check",
        exit_code: 1,
        error_name: "repository_error",
        error_category: "local_state",
      },
    });
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

function stubPostHog() {
  const fetchMock = vi.fn<typeof fetch>(async () => new Response("ok"));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function writableOutput(output: string[]): Writable {
  return collectingWritable(output);
}

function lastCaptureBody(fetchMock: {
  mock: { calls: Array<Parameters<typeof fetch>> };
}) {
  const body = fetchMock.mock.calls.at(-1)?.[1]?.body;
  if (typeof body !== "string") throw new Error("Expected JSON string body");
  const parsed = JSON.parse(body) as {
    batch: Array<{
      event: string;
      properties: Record<string, string | number | boolean | undefined>;
    }>;
  };
  const event = parsed.batch.at(-1);
  if (!event) throw new Error("Expected a PostHog batch event");
  return event;
}
