import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { collectingWritable } from "./cli-output";
import { clearTraceEnvCache } from "./review-agent-traces";
import { traceMachineStatus } from "./trace-machine-setup";
import {
  runReviewTraceConfigMigrate,
  runReviewTraceStorageUse,
} from "./trace-storage-cli";
import { readTraceConfigFile, traceConfigPath } from "./trace-storage/config";
import { DirectTraceStorage } from "./trace-storage/direct";
import { resolveDirectSetup } from "./trace-storage/direct-config";
import { selectTraceStorage } from "./trace-storage/resolve";

const legacyEnv = [
  'export TRACE_R2_ENDPOINT="https://legacy.example.invalid"',
  'export TRACE_R2_BUCKET="legacy-traces"',
  'export TRACE_R2_ACCESS_KEY_ID="legacy-key-id"',
  'export TRACE_R2_SECRET_ACCESS_KEY="legacy-secret-value"',
  "",
].join("\n");

describe("trace storage commands", () => {
  let home: string;
  let env: NodeJS.ProcessEnv;
  let envPath: string;
  let settingsPath: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "trace-storage-cli-"));
    env = { DEV_REVIEW_HOME: path.join(home, ".dev"), TRACE_R2_MODE: "mock" };
    const legacyDir = path.join(home, ".config", "dev-trace");
    mkdirSync(legacyDir, { recursive: true });
    envPath = path.join(legacyDir, "env");
    settingsPath = path.join(legacyDir, "settings.json");
    clearTraceEnvCache();
  });

  afterEach(() => {
    clearTraceEnvCache();
    vi.restoreAllMocks();
    rmSync(home, { recursive: true, force: true });
  });

  function writeLegacy(
    settings: {
      version: number;
      enabled: boolean;
      autoActivateRepositories: boolean;
      verifiedAt?: string;
    } = {
      version: 1,
      enabled: true,
      autoActivateRepositories: true,
      verifiedAt: "2026-08-31T20:35:02.159Z",
    },
  ): void {
    writeFileSync(envPath, legacyEnv, { mode: 0o600 });
    writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, {
      mode: 0o600,
    });
  }

  async function migrate(options: { dryRun?: boolean; json?: boolean } = {}) {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runReviewTraceConfigMigrate({
      ...options,
      homeDir: home,
      env,
      stdout: collectingWritable(out),
      stderr: collectingWritable(err),
    });
    return { code, stdout: out.join(""), stderr: err.join("") };
  }

  it("previews a migration without writing and without exposing the secret", async () => {
    writeLegacy();
    const result = await migrate({ dryRun: true, json: true });
    expect(result.code).toBe(0);
    expect(existsSync(traceConfigPath({ env, homeDir: home }))).toBe(false);
    const event = JSON.parse(result.stdout.trim());
    expect(event).toMatchObject({
      event: "trace.config.migrate",
      status: "preview",
      dryRun: true,
      credentialsSource: "legacy-file",
      bucket: "legacy-traces",
      accessKeyIdPrefix: "legacy",
      capture: { enabled: true, autoActivateRepositories: true },
    });
    expect(result.stdout + result.stderr).not.toContain("legacy-secret-value");
    expect(result.stderr).toContain("Dry run: nothing was written.");
  });

  it("migrates once, leaves the legacy files intact, and is idempotent", async () => {
    writeLegacy();
    const before = readFileSync(envPath, "utf8");
    const first = await migrate();
    expect(first.code).toBe(0);
    expect(first.stdout).toContain("Wrote ");

    const configPath = traceConfigPath({ env, homeDir: home });
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
    const written = JSON.parse(readFileSync(configPath, "utf8"));
    expect(written).toMatchObject({
      version: 2,
      storage: { mode: "direct" },
      direct: {
        endpoint: "https://legacy.example.invalid",
        bucket: "legacy-traces",
        accessKeyId: "legacy-key-id",
        secretAccessKey: "legacy-secret-value",
        region: "auto",
        capture: {
          enabled: true,
          autoActivateRepositories: true,
          verifiedAt: "2026-08-31T20:35:02.159Z",
        },
      },
    });
    expect(readFileSync(envPath, "utf8")).toBe(before);
    expect(statSync(envPath).mode & 0o777).toBe(0o600);

    // Migration acceptance: the new file alone yields the same setup.
    rmSync(envPath);
    rmSync(settingsPath);
    clearTraceEnvCache();
    const setup = resolveDirectSetup({ env, homeDir: home });
    expect(setup.source).toBe("profile");
    expect(setup.credentials).toEqual({
      endpoint: "https://legacy.example.invalid",
      bucket: "legacy-traces",
      accessKeyId: "legacy-key-id",
      secretAccessKey: "legacy-secret-value",
      region: "auto",
    });
    expect(await traceMachineStatus({ homeDir: home, env })).toMatchObject({
      enabled: true,
      configured: true,
      autoActivateRepositories: true,
      captureSource: "profile",
      credentialsSource: "profile",
      storageMode: "direct",
    });

    writeLegacy();
    clearTraceEnvCache();
    const second = await migrate({ json: true });
    expect(second.code).toBe(0);
    expect(JSON.parse(second.stdout.trim()).status).toBe("unchanged");
  });

  it("keeps disabled capture disabled", async () => {
    writeLegacy({ version: 1, enabled: false, autoActivateRepositories: true });
    expect((await migrate()).code).toBe(0);
    const file = readTraceConfigFile({ env, homeDir: home });
    expect(file.config?.direct?.capture).toEqual({
      enabled: false,
      autoActivateRepositories: false,
    });
    expect((await traceMachineStatus({ homeDir: home, env })).enabled).toBe(
      false,
    );
  });

  it("records environment overrides as sources and persists the effective values", async () => {
    writeLegacy();
    env.TRACE_R2_BUCKET = "override-traces";
    const result = await migrate({ json: true });
    expect(result.code).toBe(0);
    const event = JSON.parse(result.stdout.trim());
    expect(event.overrides).toEqual(["TRACE_R2_BUCKET"]);
    expect(event.bucket).toBe("override-traces");
    expect(result.stderr).toContain("environment overrides: TRACE_R2_BUCKET");
  });

  it("refuses to overwrite a different profile or switch away from hosted", async () => {
    writeLegacy();
    const configPath = traceConfigPath({ env, homeDir: home });
    mkdirSync(path.dirname(configPath), { recursive: true });
    const other = {
      version: 2,
      direct: {
        endpoint: "https://other.example.invalid",
        bucket: "other",
        accessKeyId: "k",
        secretAccessKey: "s",
      },
    };
    writeFileSync(configPath, JSON.stringify(other));
    const conflict = await migrate();
    expect(conflict.code).toBe(1);
    expect(conflict.stderr).toContain("different direct profile");
    expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual(other);

    const hosted = {
      version: 2,
      storage: { mode: "hosted", origin: "https://app.dev.fast" },
    };
    writeFileSync(configPath, JSON.stringify(hosted));
    const hostedResult = await migrate();
    expect(hostedResult.code).toBe(1);
    expect(hostedResult.stderr).toContain("Hosted storage is selected");
    expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual(hosted);
  });

  it("writes nothing when the bucket is unreachable", async () => {
    writeLegacy();
    delete env.TRACE_R2_MODE;
    vi.spyOn(DirectTraceStorage.prototype, "doctor").mockResolvedValue({
      reachable: false,
      error: "head-bucket failed",
    });
    const result = await migrate();
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Cannot reach S3/R2 bucket");
    expect(result.stderr).not.toContain("legacy-secret-value");
    expect(existsSync(traceConfigPath({ env, homeDir: home }))).toBe(false);
  });

  it("fails clearly when there is nothing to migrate", async () => {
    const result = await migrate();
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("No legacy S3/R2 configuration");
  });

  describe("storage use", () => {
    async function use(input: {
      mode: string;
      origin?: string;
      endpoint?: string;
      bucket?: string;
      key?: string;
      secret?: string;
      region?: string;
      json?: boolean;
    }) {
      const out: string[] = [];
      const err: string[] = [];
      const code = await runReviewTraceStorageUse({
        ...input,
        cwd: home,
        homeDir: home,
        env,
        stdout: collectingWritable(out),
        stderr: collectingWritable(err),
      });
      return { code, stdout: out.join(""), stderr: err.join("") };
    }

    it("selects direct from an existing legacy setup without copying it", async () => {
      writeLegacy();
      const result = await use({ mode: "direct" });
      expect(result.code).toBe(0);
      expect(result.stdout).toContain(
        'Storage: direct S3/R2 bucket "legacy-traces"',
      );
      expect(result.stdout).toContain("Capture: enabled");
      const file = readTraceConfigFile({ env, homeDir: home });
      expect(file.config).toEqual({ version: 2, storage: { mode: "direct" } });
      expect(readFileSync(envPath, "utf8")).toBe(legacyEnv);
    });

    it("writes a complete profile from flags and selects direct", async () => {
      const result = await use({
        mode: "direct",
        endpoint: "https://s3.example.invalid",
        bucket: "flag-traces",
        key: "flag-key-id",
        secret: "flag-secret-value",
        region: "eu-west-1",
        json: true,
      });
      expect(result.code).toBe(0);
      expect(result.stdout).not.toContain("flag-secret-value");
      expect(JSON.parse(result.stdout.trim())).toMatchObject({
        event: "trace.storage.use",
        mode: "direct",
        bucket: "flag-traces",
        region: "eu-west-1",
        captureEnabled: true,
      });
      const file = readTraceConfigFile({ env, homeDir: home });
      expect(file.config?.storage).toEqual({ mode: "direct" });
      expect(file.config?.direct).toEqual({
        endpoint: "https://s3.example.invalid",
        bucket: "flag-traces",
        accessKeyId: "flag-key-id",
        secretAccessKey: "flag-secret-value",
        region: "eu-west-1",
        capture: { enabled: true, autoActivateRepositories: true },
      });
      expect(selectTraceStorage({ env, homeDir: home })).toMatchObject({
        mode: "direct",
        explicit: true,
      });
    });

    it("rejects partial flags and missing credentials", async () => {
      const partial = await use({ mode: "direct", bucket: "only-bucket" });
      expect(partial.code).toBe(1);
      expect(partial.stderr).toContain(
        "--endpoint, --bucket, --key, and --secret",
      );
      delete env.TRACE_R2_MODE;
      const missing = await use({ mode: "direct" });
      expect(missing.code).toBe(1);
      expect(missing.stderr).toContain("No S3/R2 credentials are configured");
      expect(existsSync(traceConfigPath({ env, homeDir: home }))).toBe(false);
    });

    it("keeps a saved profile's capture settings when re-selecting direct", async () => {
      writeLegacy({
        version: 1,
        enabled: false,
        autoActivateRepositories: true,
      });
      expect((await migrate()).code).toBe(0);
      const result = await use({
        mode: "direct",
        endpoint: "https://s3.example.invalid",
        bucket: "rotated",
        key: "new-key",
        secret: "new-secret",
      });
      expect(result.code).toBe(0);
      const file = readTraceConfigFile({ env, homeDir: home });
      expect(file.config?.direct?.bucket).toBe("rotated");
      expect(file.config?.direct?.capture?.enabled).toBe(false);
      expect(result.stdout).toContain("Capture: disabled");
    });
  });
});
