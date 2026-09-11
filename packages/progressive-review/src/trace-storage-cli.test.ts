import { execFileSync } from "node:child_process";
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

import type { JsonValue } from "@dev.fast/review-protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { collectingWritable } from "./cli-output";
import {
  checkReviewTraceDoctor,
  clearTraceEnvCache,
} from "./review-agent-traces";
import { writeStoreAuth } from "./store-auth";
import { StoreClient } from "./store-client";
import { traceMachineStatus } from "./trace-machine-setup";
import {
  legacyRetiredPath,
  runReviewTraceConfigMigrate,
  runReviewTraceStorageUse,
} from "./trace-storage-cli";
import { readTraceConfigFile, traceConfigPath } from "./trace-storage/config";
import { selectTraceStorage } from "./trace-storage/resolve";
import { S3TraceStorage } from "./trace-storage/s3";
import { resolveS3Setup } from "./trace-storage/s3-config";
import { allowTraceRepository } from "./trace-user-config";

/** Runs `action` with process.env and HOME temporarily replaced by `env`. */
async function withProcessEnv<T>(
  env: NodeJS.ProcessEnv,
  action: () => Promise<T>,
): Promise<T> {
  const previous = { ...process.env };
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, env, { HOME: env.HOME ?? previous.HOME });
  clearTraceEnvCache();
  try {
    return await action();
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, previous);
    clearTraceEnvCache();
  }
}

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

  async function migrate(
    options: { dryRun?: boolean; keepLegacy?: boolean; json?: boolean } = {},
  ) {
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

  it("migrates once, retires the legacy files beside their originals, and is idempotent", async () => {
    writeLegacy();
    const before = readFileSync(envPath, "utf8");
    const settingsBefore = readFileSync(settingsPath, "utf8");
    const retiredEnv = legacyRetiredPath(envPath);
    const retiredSettings = legacyRetiredPath(settingsPath);
    const first = await migrate();
    expect(first.code).toBe(0);
    expect(first.stdout).toContain("Wrote ");
    expect(first.stdout).toContain("Retired ");

    const configPath = traceConfigPath({ env, homeDir: home });
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
    const written = JSON.parse(readFileSync(configPath, "utf8"));
    expect(written).toMatchObject({
      version: 2,
      "current-store": "s3",
      stores: {
        s3: {
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
      },
    });
    // The legacy files moved aside unchanged; the originals are gone.
    expect(existsSync(envPath)).toBe(false);
    expect(existsSync(settingsPath)).toBe(false);
    expect(readFileSync(retiredEnv, "utf8")).toBe(before);
    expect(readFileSync(retiredSettings, "utf8")).toBe(settingsBefore);
    expect(statSync(retiredEnv).mode & 0o777).toBe(0o600);

    // Migration acceptance: the new file alone yields the same setup.
    clearTraceEnvCache();
    const setup = resolveS3Setup({ env, homeDir: home });
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
      storageMode: "s3",
    });
    // The doctor reports the profile as its source once the legacy files
    // are gone, instead of demanding the env file.
    delete env.TRACE_R2_MODE;
    vi.spyOn(S3TraceStorage.prototype, "doctor").mockResolvedValue({
      reachable: true,
    });
    const doctor = await withProcessEnv(env, () => checkReviewTraceDoctor());
    expect(doctor).toMatchObject({
      ok: true,
      reachable: true,
      envPath: configPath,
      config: { bucket: "legacy-traces" },
    });
    env.TRACE_R2_MODE = "mock";

    writeLegacy();
    clearTraceEnvCache();
    const second = await migrate({ json: true });
    expect(second.code).toBe(0);
    expect(JSON.parse(second.stdout.trim()).status).toBe("unchanged");
  });

  it("never retires legacy files on a dry run, even when the profile already matches", async () => {
    writeLegacy();
    expect((await migrate({ keepLegacy: true })).code).toBe(0);
    const before = readFileSync(envPath, "utf8");
    const result = await migrate({ dryRun: true, json: true });
    expect(result.code).toBe(0);
    expect(existsSync(envPath)).toBe(true);
    expect(readFileSync(envPath, "utf8")).toBe(before);
    expect(existsSync(legacyRetiredPath(envPath))).toBe(false);
    expect(JSON.parse(result.stdout.trim())).toMatchObject({
      status: "preview",
      dryRun: true,
      retired: [],
    });
    expect(result.stderr).toContain("nothing would be written");
  });

  it("leaves the legacy files in place with --keep-legacy", async () => {
    writeLegacy();
    const before = readFileSync(envPath, "utf8");
    const result = await migrate({ keepLegacy: true, json: true });
    expect(result.code).toBe(0);
    expect(readFileSync(envPath, "utf8")).toBe(before);
    expect(existsSync(legacyRetiredPath(envPath))).toBe(false);
    expect(JSON.parse(result.stdout.trim()).retired).toEqual([]);
    expect(result.stderr).toContain("left unchanged");
  });

  it("keeps disabled capture disabled", async () => {
    writeLegacy({ version: 1, enabled: false, autoActivateRepositories: true });
    expect((await migrate()).code).toBe(0);
    const file = readTraceConfigFile({ env, homeDir: home });
    expect(file.config?.stores?.s3?.capture).toEqual({
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
      stores: {
        s3: {
          endpoint: "https://other.example.invalid",
          bucket: "other",
          accessKeyId: "k",
          secretAccessKey: "s",
        },
      },
    };
    writeFileSync(configPath, JSON.stringify(other));
    const conflict = await migrate();
    expect(conflict.code).toBe(1);
    expect(conflict.stderr).toContain("different s3 store");
    expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual(other);

    const hosted = { version: 2, "current-store": "hosted" };
    writeFileSync(configPath, JSON.stringify(hosted));
    const hostedResult = await migrate();
    expect(hostedResult.code).toBe(1);
    expect(hostedResult.stderr).toContain("Hosted storage is selected");
    expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual(hosted);
  });

  it("writes nothing when the bucket is unreachable", async () => {
    writeLegacy();
    delete env.TRACE_R2_MODE;
    vi.spyOn(S3TraceStorage.prototype, "doctor").mockResolvedValue({
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
      client?: StoreClient;
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
      const result = await use({ mode: "s3" });
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('Storage: S3/R2 bucket "legacy-traces"');
      expect(result.stdout).toContain("Capture: enabled");
      const file = readTraceConfigFile({ env, homeDir: home });
      expect(file.config).toEqual({ version: 2, "current-store": "s3" });
      expect(readFileSync(envPath, "utf8")).toBe(legacyEnv);
    });

    it("writes a complete profile from flags and selects direct", async () => {
      const result = await use({
        mode: "s3",
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
        mode: "s3",
        bucket: "flag-traces",
        region: "eu-west-1",
        captureEnabled: true,
      });
      const file = readTraceConfigFile({ env, homeDir: home });
      expect(file.config?.["current-store"]).toBe("s3");
      expect(file.config?.stores?.s3).toEqual({
        endpoint: "https://s3.example.invalid",
        bucket: "flag-traces",
        accessKeyId: "flag-key-id",
        secretAccessKey: "flag-secret-value",
        region: "eu-west-1",
        capture: { enabled: true, autoActivateRepositories: true },
      });
      expect(selectTraceStorage({ env, homeDir: home })).toMatchObject({
        mode: "s3",
        explicit: true,
      });
    });

    it("rejects partial flags and missing credentials", async () => {
      const partial = await use({ mode: "s3", bucket: "only-bucket" });
      expect(partial.code).toBe(1);
      expect(partial.stderr).toContain(
        "--endpoint, --bucket, --key, and --secret",
      );
      delete env.TRACE_R2_MODE;
      const missing = await use({ mode: "s3" });
      expect(missing.code).toBe(1);
      expect(missing.stderr).toContain("No S3/R2 credentials are configured");
      expect(existsSync(traceConfigPath({ env, homeDir: home }))).toBe(false);
    });

    describe("hosted", () => {
      const origin = "https://app.dev.fast";
      const storeId = "0123456789abcdef0123456789abcdef";

      function storeClient(body: JsonValue) {
        return new StoreClient({
          origin,
          token: "token",
          fetch: vi.fn<typeof fetch>(
            async () =>
              new Response(JSON.stringify(body), {
                status: 200,
                headers: { "content-type": "application/json" },
              }),
          ),
        });
      }

      async function githubCheckout(): Promise<void> {
        execFileSync("git", ["init", "--quiet"], { cwd: home });
        execFileSync(
          "git",
          ["remote", "add", "origin", "git@github.com:acme/app.git"],
          { cwd: home },
        );
      }

      it("requires a login for the origin", async () => {
        await githubCheckout();
        const result = await use({ mode: "hosted" });
        expect(result.code).toBe(1);
        expect(result.stderr).toContain("review login --origin");
        expect(existsSync(traceConfigPath({ env, homeDir: home }))).toBe(false);
      });

      it("refuses without consent and when the store speaks an older contract", async () => {
        await githubCheckout();
        await writeStoreAuth(
          {
            origin,
            token: "token",
            login: "dev",
            savedAt: "2026-09-02T00:00:00Z",
          },
          env,
        );
        const active = {
          repositoryId: 42,
          storeId,
          displayName: "acme/app",
          status: "active",
          createdAt: "2026-09-02T12:00:00Z",
        };
        const noConsent = await use({
          mode: "hosted",
          client: storeClient(active),
        });
        expect(noConsent.code).toBe(1);
        expect(noConsent.stderr).toContain("not allowed for trace publication");
        expect(
          readTraceConfigFile({ env, homeDir: home }).config?.["current-store"],
        ).toBeUndefined();

        await allowTraceRepository(
          { repositoryId: 42, name: "acme/app", origin },
          path.join(home, ".dev"),
        );
        const olderContractStore = {
          repositoryId: 42,
          displayName: "acme/app",
        };
        const old = await use({
          mode: "hosted",
          client: storeClient(olderContractStore),
        });
        expect(old.code).toBe(1);
        expect(old.stderr).toContain("does not serve the trace store contract");
        expect(
          readTraceConfigFile({ env, homeDir: home }).config?.["current-store"],
        ).toBeUndefined();

        writeLegacy();
        const selected = await use({
          mode: "hosted",
          client: storeClient(active),
          json: true,
        });
        expect(selected.code).toBe(0);
        expect(JSON.parse(selected.stdout.trim())).toMatchObject({
          event: "trace.storage.use",
          mode: "hosted",
          origin,
          repositoryId: 42,
          storeId,
        });
        expect(selected.stderr).toContain(
          "Bucket credentials stay saved and inactive",
        );
        const file = readTraceConfigFile({ env, homeDir: home });
        expect(file.config?.["current-store"]).toBe("hosted");
        // The default origin needs no store entry.
        expect(file.config?.stores?.hosted).toBeUndefined();
        expect(file.config?.repositories).toHaveLength(1);
        expect(readFileSync(envPath, "utf8")).toBe(legacyEnv);

        // Switching back keeps the consent entry and selects direct again.
        const back = await use({ mode: "s3" });
        expect(back.code).toBe(0);
        const after = readTraceConfigFile({ env, homeDir: home });
        expect(after.config?.["current-store"]).toBe("s3");
        expect(after.config?.repositories).toHaveLength(1);
      });
    });

    it("keeps a saved profile's capture settings when re-selecting direct", async () => {
      writeLegacy({
        version: 1,
        enabled: false,
        autoActivateRepositories: true,
      });
      expect((await migrate()).code).toBe(0);
      const result = await use({
        mode: "s3",
        endpoint: "https://s3.example.invalid",
        bucket: "rotated",
        key: "new-key",
        secret: "new-secret",
      });
      expect(result.code).toBe(0);
      const file = readTraceConfigFile({ env, homeDir: home });
      expect(file.config?.stores?.s3?.bucket).toBe("rotated");
      expect(file.config?.stores?.s3?.capture?.enabled).toBe(false);
      expect(result.stdout).toContain("Capture: disabled");
    });
  });
});
