import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Writable } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { collectingWritable } from "./cli-output";
import type { runSoftwareMapCli } from "./map-cli";
import { runSoftwareMapCliEntry } from "./map-cli-entry";

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
      const fetchMock = stubPostHog();

      const exitCode = await runSoftwareMapCliEntry({
        args: [mode],
        cwd: await tempDir(tempDirs, "progressive-review-map-repo-"),
        env: await telemetryEnv(tempDirs),
        stdout: writableOutput([]),
        stderr: writableOutput([]),
        runSoftwareMapCli: mapMocks.runSoftwareMapCli,
      });

      expect(exitCode).toBe(0);
      const event = await waitForCaptureBody(
        fetchMock,
        (e) =>
          e.properties.command === "map" && e.properties.subcommand === mode,
      );
      expect(event.properties).toMatchObject({
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
      runSoftwareMapCli: mapMocks.runSoftwareMapCli,
    });

    const body = await waitForCaptureBody(
      fetchMock,
      (e) =>
        e.properties.command === "map" && e.properties.subcommand === "update",
    );
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
      runSoftwareMapCli: mapMocks.runSoftwareMapCli,
    });

    expect(exitCode).toBe(1);
    const body = await waitForCaptureBody(
      fetchMock,
      (e) => e.event === "review_command_failed",
    );
    expect(body).toMatchObject({
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

// The PostHog capture client queues events to files named
// `${createdAt}-${randomUUID}.json` and the flush reads them sorted by filename.
// Events captured in the same millisecond therefore appear in a RANDOM relative
// order (the UUID suffix dominates the sort), so the completion event is not
// reliably the LAST element of the last batch. Wait for the completion event
// to appear SOMEWHERE in the captured batches and return that event, rather
// than reading `at(-1)` and racing a non-deterministic flush order. (The flush
// is also sent on a timer the CLI does not always await before resolving, so
// poll until the event lands.)
async function waitForCaptureBody(
  fetchMock: { mock: { calls: Array<Parameters<typeof fetch>> } },
  predicate: (event: {
    event: string;
    properties: Record<string, string | number | boolean | undefined>;
  }) => boolean,
  timeoutMs = 2_000,
): Promise<{
  event: string;
  properties: Record<string, string | number | boolean | undefined>;
}> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    for (const call of fetchMock.mock.calls) {
      const parsed = z.string().safeParse(call[1]?.body);
      if (!parsed.success) continue;
      const payload = JSON.parse(parsed.data) as {
        batch: Array<{
          event: string;
          properties: Record<string, string | number | boolean | undefined>;
        }>;
      };
      const match = payload.batch.find((e) => predicate(e));
      if (match) return match;
    }
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for the telemetry completion event");
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}
