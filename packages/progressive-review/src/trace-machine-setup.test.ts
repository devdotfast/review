import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { clearTraceEnvCache } from "./review-agent-traces";
import { traceMachineEnabled, traceMachineStatus } from "./trace-machine-setup";
import { traceConfigPath } from "./trace-storage/config";

describe("trace machine capture switch", () => {
  let home: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "trace-machine-"));
    env = { DEV_REVIEW_HOME: path.join(home, ".dev") };
    clearTraceEnvCache();
  });

  afterEach(() => {
    clearTraceEnvCache();
    rmSync(home, { recursive: true, force: true });
  });

  function writeConfig(value: string): void {
    const filePath = traceConfigPath({ env, homeDir: home });
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, value);
  }

  it("is off on a machine with no trace configuration", async () => {
    expect(await traceMachineEnabled({ homeDir: home, env })).toBe(false);
    expect(await traceMachineStatus({ homeDir: home, env })).toMatchObject({
      enabled: false,
      configured: false,
      storageMode: "none",
    });
  });

  it("follows the legacy settings file for direct storage", async () => {
    const dir = path.join(home, ".config", "dev-trace");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "env"),
      'TRACE_R2_ENDPOINT="https://s3.example.invalid"\nTRACE_R2_BUCKET="b"\nTRACE_R2_ACCESS_KEY_ID="k"\nTRACE_R2_SECRET_ACCESS_KEY="s"\n',
    );
    expect(await traceMachineEnabled({ homeDir: home, env })).toBe(false);
    writeFileSync(
      path.join(dir, "settings.json"),
      JSON.stringify({
        version: 1,
        enabled: true,
        autoActivateRepositories: true,
      }),
    );
    expect(await traceMachineStatus({ homeDir: home, env })).toMatchObject({
      enabled: true,
      configured: true,
      autoActivateRepositories: true,
      storageMode: "s3",
      captureSource: "settings",
    });
  });

  it("treats an explicit hosted selection as the machine-level opt-in", async () => {
    writeConfig(
      JSON.stringify({
        version: 2,
        "current-store": "hosted",
      }),
    );
    // No bucket, no legacy settings file: hosted alone switches capture on;
    // consent and provenance gate each publication afterwards.
    expect(await traceMachineEnabled({ homeDir: home, env })).toBe(true);
    expect(await traceMachineStatus({ homeDir: home, env })).toMatchObject({
      enabled: true,
      configured: true,
      autoActivateRepositories: true,
      storageMode: "hosted",
    });
  });

  it("infers hosted from a consent list when no bucket exists", async () => {
    writeConfig(
      JSON.stringify({
        version: 2,
        repositories: [
          {
            repositoryId: 1,
            name: "acme/app",
            allowedAt: "2026-09-01T00:00:00Z",
          },
        ],
      }),
    );
    expect(await traceMachineStatus({ homeDir: home, env })).toMatchObject({
      enabled: true,
      storageMode: "hosted",
    });
  });
});
