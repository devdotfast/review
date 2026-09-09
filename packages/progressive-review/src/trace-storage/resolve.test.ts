import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { JsonValue } from "@dev.fast/review-protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { traceConfigPath } from "./config";
import { clearTraceEnvCache, resolveDirectSetup } from "./direct-config";
import { resolveTraceStorage, selectTraceStorage } from "./resolve";

const bucketProfile = {
  endpoint: "https://s3.example.invalid",
  bucket: "profile-traces",
  accessKeyId: "profile-key",
  secretAccessKey: "profile-secret",
  region: "us-east-1",
  capture: { enabled: true, autoActivateRepositories: true },
};

describe("trace storage selection", () => {
  let home: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "trace-select-"));
    env = { DEV_REVIEW_HOME: path.join(home, ".dev") };
    clearTraceEnvCache();
  });

  afterEach(() => {
    clearTraceEnvCache();
    rmSync(home, { recursive: true, force: true });
  });

  function writeConfig(value: JsonValue): void {
    const filePath = traceConfigPath({ env, homeDir: home });
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify(value));
  }

  function writeLegacyEnv(): string {
    const dir = path.join(home, ".config", "dev-trace");
    mkdirSync(dir, { recursive: true });
    const envPath = path.join(dir, "env");
    writeFileSync(
      envPath,
      [
        'export TRACE_R2_ENDPOINT="https://legacy.example.invalid"',
        'export TRACE_R2_BUCKET="legacy-traces"',
        'export TRACE_R2_ACCESS_KEY_ID="legacy-key"',
        'export TRACE_R2_SECRET_ACCESS_KEY="legacy-secret"',
        "",
      ].join("\n"),
    );
    return envPath;
  }

  it("selects direct implicitly from an existing bucket configuration", async () => {
    writeLegacyEnv();
    const selection = selectTraceStorage({ env, homeDir: home });
    expect(selection).toMatchObject({ mode: "direct", explicit: false });
    expect(selection.direct?.source).toBe("legacy-file");
    expect(selection.direct?.credentials?.bucket).toBe("legacy-traces");
    const storage = await resolveTraceStorage({ env, homeDir: home });
    expect(storage?.kind).toBe("direct");
    expect(storage?.target).toEqual({
      kind: "direct",
      endpoint: "https://legacy.example.invalid",
      bucket: "legacy-traces",
      region: "auto",
    });
  });

  it("selects nothing when no configuration exists", async () => {
    const selection = selectTraceStorage({ env, homeDir: home });
    expect(selection).toMatchObject({ mode: "none", explicit: false });
    expect(selection.error).toBeUndefined();
    expect(await resolveTraceStorage({ env, homeDir: home })).toBeNull();
  });

  it("treats explicit direct without credentials as a configuration error", async () => {
    writeConfig({ version: 2, storage: { mode: "direct" } });
    const selection = selectTraceStorage({ env, homeDir: home });
    expect(selection.mode).toBe("direct");
    expect(selection.error).toContain("no bucket credentials");
    await expect(resolveTraceStorage({ env, homeDir: home })).rejects.toThrow(
      /no bucket credentials/,
    );
  });

  it("uses the version-2 profile before the legacy file, with environment overrides on top", () => {
    writeLegacyEnv();
    writeConfig({ version: 2, direct: bucketProfile });
    const fromProfile = resolveDirectSetup({ env, homeDir: home });
    expect(fromProfile.source).toBe("profile");
    expect(fromProfile.credentials).toEqual({
      endpoint: "https://s3.example.invalid",
      bucket: "profile-traces",
      accessKeyId: "profile-key",
      secretAccessKey: "profile-secret",
      region: "us-east-1",
    });

    const overridden = resolveDirectSetup({
      env: { ...env, TRACE_R2_BUCKET: "override-traces" },
      homeDir: home,
    });
    expect(overridden.credentials?.bucket).toBe("override-traces");
    expect(overridden.credentials?.endpoint).toBe("https://s3.example.invalid");
    expect(overridden.overrides).toEqual(["TRACE_R2_BUCKET"]);
  });

  it("does not patch an incomplete profile from the legacy file", () => {
    writeLegacyEnv();
    writeConfig({
      version: 2,
      direct: { endpoint: "https://s3.example.invalid", bucket: "half" },
    });
    const selection = selectTraceStorage({ env, homeDir: home });
    expect(selection.mode).toBe("none");
    expect(selection.error).toContain("invalid");
    expect(() => resolveDirectSetup({ env, homeDir: home })).toThrow(/invalid/);
  });

  it("keeps bucket credentials inert when hosted is selected", async () => {
    writeLegacyEnv();
    writeConfig({
      version: 2,
      storage: { mode: "hosted", origin: "https://app.dev.fast" },
      direct: bucketProfile,
    });
    const selection = selectTraceStorage({ env, homeDir: home });
    expect(selection).toMatchObject({
      mode: "hosted",
      explicit: true,
      hosted: { origin: "https://app.dev.fast" },
    });
    expect(selection.direct?.credentials?.bucket).toBe("profile-traces");
    // A read-only override reaches the bucket without changing the selection.
    const direct = await resolveTraceStorage({
      env,
      homeDir: home,
      override: "direct",
    });
    expect(direct?.kind).toBe("direct");
    expect(selectTraceStorage({ env, homeDir: home }).mode).toBe("hosted");
  });

  it("does not let a consent entry or version-1 file select hosted storage", () => {
    writeLegacyEnv();
    writeConfig({
      version: 1,
      repositories: [
        {
          repositoryId: 7,
          name: "acme/widgets",
          store: "https://app.dev.fast",
        },
      ],
    });
    const selection = selectTraceStorage({ env, homeDir: home });
    expect(selection.mode).toBe("direct");
    expect(selection.config.source).toBe("v1");
    expect(selection.config.config?.repositories).toHaveLength(1);
  });

  it("reports a malformed file instead of selecting another destination", async () => {
    writeLegacyEnv();
    writeConfig({ version: 2, storage: { mode: "sideways" } });
    const selection = selectTraceStorage({ env, homeDir: home });
    expect(selection.mode).toBe("none");
    expect(selection.error).toContain("invalid");
    await expect(resolveTraceStorage({ env, homeDir: home })).rejects.toThrow(
      /invalid/,
    );
  });
});
