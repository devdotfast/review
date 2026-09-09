import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { JsonValue } from "@dev.fast/review-protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_HOSTED_ORIGIN, traceConfigPath } from "./config";
import { resolveTraceStorage, selectTraceStorage } from "./resolve";
import { clearTraceEnvCache, resolveS3Setup } from "./s3-config";

const bucketProfile = {
  endpoint: "https://s3.example.invalid",
  bucket: "profile-traces",
  accessKeyId: "profile-key",
  secretAccessKey: "profile-secret",
  region: "us-east-1",
  capture: { enabled: true, autoActivateRepositories: true },
};

const consent = [
  { repositoryId: 7, name: "acme/widgets", allowedAt: "2026-09-01T00:00:00Z" },
];

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

  it("selects s3 implicitly from an existing bucket configuration", async () => {
    writeLegacyEnv();
    const selection = selectTraceStorage({ env, homeDir: home });
    expect(selection).toMatchObject({ mode: "s3", explicit: false });
    expect(selection.s3?.source).toBe("legacy-file");
    expect(selection.s3?.credentials?.bucket).toBe("legacy-traces");
    const storage = await resolveTraceStorage({ env, homeDir: home });
    expect(storage?.kind).toBe("s3");
    expect(storage?.target).toEqual({
      kind: "s3",
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

  it("selects s3 from a profile alone and hosted from a hosted entry alone", () => {
    writeConfig({ version: 2, stores: { s3: bucketProfile } });
    expect(selectTraceStorage({ env, homeDir: home })).toMatchObject({
      mode: "s3",
      explicit: false,
    });
    writeConfig({
      version: 2,
      stores: { hosted: { origin: "https://staging.dev.fast" } },
    });
    expect(selectTraceStorage({ env, homeDir: home })).toMatchObject({
      mode: "hosted",
      explicit: false,
      hosted: { origin: "https://staging.dev.fast" },
    });
  });

  it("infers hosted at the default origin from consent alone", () => {
    writeConfig({ version: 2, repositories: consent });
    expect(selectTraceStorage({ env, homeDir: home })).toMatchObject({
      mode: "hosted",
      explicit: false,
      hosted: { origin: DEFAULT_HOSTED_ORIGIN },
    });
  });

  it("lets an existing bucket outrank consent, so nothing is redirected", () => {
    writeLegacyEnv();
    writeConfig({ version: 2, repositories: consent });
    const selection = selectTraceStorage({ env, homeDir: home });
    expect(selection.mode).toBe("s3");
    expect(selection.hosted).toEqual({ origin: DEFAULT_HOSTED_ORIGIN });
  });

  it("requires the pointer when both stores exist", async () => {
    writeConfig({
      version: 2,
      stores: { s3: bucketProfile, hosted: { origin: DEFAULT_HOSTED_ORIGIN } },
    });
    const selection = selectTraceStorage({ env, homeDir: home });
    expect(selection.mode).toBe("none");
    expect(selection.error).toContain("current-store");
    await expect(resolveTraceStorage({ env, homeDir: home })).rejects.toThrow(
      /current-store/,
    );
  });

  it("treats explicit s3 without credentials as a configuration error", async () => {
    writeConfig({ version: 2, "current-store": "s3" });
    const selection = selectTraceStorage({ env, homeDir: home });
    expect(selection.mode).toBe("s3");
    expect(selection.error).toContain("no bucket credentials");
    await expect(resolveTraceStorage({ env, homeDir: home })).rejects.toThrow(
      /no bucket credentials/,
    );
  });

  it("uses the profile before the legacy file, with environment overrides on top", () => {
    writeLegacyEnv();
    writeConfig({ version: 2, stores: { s3: bucketProfile } });
    const fromProfile = resolveS3Setup({ env, homeDir: home });
    expect(fromProfile.source).toBe("profile");
    expect(fromProfile.credentials).toEqual({
      endpoint: "https://s3.example.invalid",
      bucket: "profile-traces",
      accessKeyId: "profile-key",
      secretAccessKey: "profile-secret",
      region: "us-east-1",
    });

    const overridden = resolveS3Setup({
      env: { ...env, TRACE_R2_BUCKET: "override-traces" },
      homeDir: home,
    });
    expect(overridden.credentials?.bucket).toBe("override-traces");
    expect(overridden.credentials?.endpoint).toBe("https://s3.example.invalid");
    expect(overridden.overrides).toEqual(["TRACE_R2_BUCKET"]);
  });

  it("keeps the legacy file's TRACE_R2_* keys ahead of exported AWS_* credentials", () => {
    writeLegacyEnv();
    const setup = resolveS3Setup({
      env: {
        ...env,
        AWS_ACCESS_KEY_ID: "shell-aws-key",
        AWS_SECRET_ACCESS_KEY: "shell-aws-secret",
      },
      homeDir: home,
    });
    expect(setup.credentials).toMatchObject({
      accessKeyId: "legacy-key",
      secretAccessKey: "legacy-secret",
    });
    expect(setup.overrides).toEqual([]);
    // Without the bucket's own keys, the AWS names are the fallback.
    const dir = path.join(home, ".config", "dev-trace");
    writeFileSync(
      path.join(dir, "env"),
      'TRACE_R2_ENDPOINT="https://legacy.example.invalid"\nTRACE_R2_BUCKET="legacy-traces"\n',
    );
    clearTraceEnvCache();
    const fallback = resolveS3Setup({
      env: { ...env, AWS_ACCESS_KEY_ID: "k", AWS_SECRET_ACCESS_KEY: "s" },
      homeDir: home,
    });
    expect(fallback.credentials?.accessKeyId).toBe("k");
    expect(fallback.overrides).toEqual([
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
    ]);
  });

  it("does not patch an incomplete profile from the legacy file", () => {
    writeLegacyEnv();
    writeConfig({
      version: 2,
      stores: {
        s3: { endpoint: "https://s3.example.invalid", bucket: "half" },
      },
    });
    const selection = selectTraceStorage({ env, homeDir: home });
    expect(selection.mode).toBe("none");
    expect(selection.error).toContain("invalid");
    expect(() => resolveS3Setup({ env, homeDir: home })).toThrow(/invalid/);
  });

  it("keeps bucket credentials inert when hosted is selected", async () => {
    writeLegacyEnv();
    writeConfig({
      version: 2,
      "current-store": "hosted",
      stores: { s3: bucketProfile },
    });
    const selection = selectTraceStorage({ env, homeDir: home });
    expect(selection).toMatchObject({
      mode: "hosted",
      explicit: true,
      hosted: { origin: DEFAULT_HOSTED_ORIGIN },
    });
    expect(selection.s3?.credentials?.bucket).toBe("profile-traces");
    // A read-only override reaches the bucket without changing the selection.
    const s3 = await resolveTraceStorage({
      env,
      homeDir: home,
      override: "s3",
    });
    expect(s3?.kind).toBe("s3");
    expect(selectTraceStorage({ env, homeDir: home }).mode).toBe("hosted");
  });

  it("reads the version-1 file as consent and still prefers an existing bucket", () => {
    writeLegacyEnv();
    writeConfig({
      version: 1,
      repositories: [
        {
          repositoryId: 7,
          name: "acme/widgets",
          store: "https://app.dev.fast",
          allowedAt: "2026-09-01T00:00:00Z",
        },
      ],
    });
    const selection = selectTraceStorage({ env, homeDir: home });
    expect(selection.mode).toBe("s3");
    expect(selection.config.source).toBe("v1");
    expect(selection.config.config?.repositories).toHaveLength(1);
  });

  it("reports a malformed file instead of selecting another destination", async () => {
    writeLegacyEnv();
    writeConfig({ version: 2, "current-store": "sideways" });
    const selection = selectTraceStorage({ env, homeDir: home });
    expect(selection.mode).toBe("none");
    expect(selection.error).toContain("invalid");
    await expect(resolveTraceStorage({ env, homeDir: home })).rejects.toThrow(
      /invalid/,
    );
  });
});
