import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { parseJsonText } from "@dev.fast/review-protocol";
import { z } from "zod";

import { writeFileAtomicAsync } from "./atomic-write";
import { clearTraceEnvCache } from "./review-agent-traces";
import {
  type S3CaptureSettings,
  type S3Profile,
  type TraceConfigFile,
  TraceConfigurationError,
  emptyTraceConfig,
  hostedCaptureEnabled,
  readTraceConfigFile,
  writeTraceConfigFile,
} from "./trace-storage/config";
import {
  type TraceStorageMode,
  selectTraceStorage,
} from "./trace-storage/resolve";
import { S3TraceStorage } from "./trace-storage/s3";
import {
  type S3CredentialsSource,
  type S3Setup,
  S3_DEFAULT_REGION,
  resolveS3Setup,
  traceEnvPath,
  traceSettingsPath,
} from "./trace-storage/s3-config";

export { traceEnvPath, traceSettingsPath };

export interface TraceCredentialsInput {
  endpoint?: string;
  bucket?: string;
  key?: string;
  secret?: string;
  // SigV4 signing region. R2 accepts "auto"; AWS S3 needs the bucket's
  // real region.
  region?: string;
}

export type TraceCaptureSource = "profile" | "settings";

export interface TraceMachineStatus {
  enabled: boolean;
  configured: boolean;
  autoActivateRepositories: boolean;
  envPath: string;
  settingsPath: string;
  endpoint?: string;
  bucket?: string;
  region?: string;
  accessKeyIdPrefix?: string;
  verifiedAt?: string;
  error?: string;
  /** The shared trace configuration file, present or not. */
  configPath?: string;
  /** The selected trace store after applying the selection rules. */
  storageMode?: TraceStorageMode;
  /** Where the bucket credentials came from before environment overrides. */
  credentialsSource?: S3CredentialsSource;
  /** Which file holds the capture settings that are in effect. */
  captureSource?: TraceCaptureSource;
}

const traceMachineSettingsSchema = z.object({
  version: z.literal(1),
  enabled: z.boolean(),
  autoActivateRepositories: z.literal(true),
  verifiedAt: z.string().optional(),
  error: z.string().optional(),
});
type TraceMachineSettings = z.infer<typeof traceMachineSettingsSchema>;

/** The bucket credentials in the setup flow's field names. */
export async function readTraceCredentials(
  homeDir = os.homedir(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<Required<TraceCredentialsInput> | null> {
  const credentials = resolveS3Setup({ homeDir, env }).credentials;
  if (!credentials) return null;
  return {
    endpoint: credentials.endpoint,
    bucket: credentials.bucket,
    key: credentials.accessKeyId,
    secret: credentials.secretAccessKey,
    region: credentials.region,
  };
}

/**
 * The capture settings in effect: the profile's when the version-2 profile
 * carries them, otherwise the legacy settings file.
 */
async function readCaptureSettings(
  setup: S3Setup,
  settingsPath: string,
): Promise<{
  settings: S3CaptureSettings | null;
  source: TraceCaptureSource;
}> {
  if (setup.profile?.capture) {
    return { settings: setup.profile.capture, source: "profile" };
  }
  const legacy = await readSettings(settingsPath);
  return {
    settings: legacy
      ? {
          enabled: legacy.enabled,
          autoActivateRepositories: legacy.autoActivateRepositories,
          verifiedAt: legacy.verifiedAt,
          error: legacy.error,
        }
      : null,
    source: "settings",
  };
}

export async function traceMachineStatus(
  input: {
    homeDir?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<TraceMachineStatus> {
  const homeDir = input.homeDir ?? os.homedir();
  const env = input.env ?? process.env;
  const envPath = traceEnvPath(homeDir, env);
  const settingsPath = traceSettingsPath(homeDir, env);
  const selection = selectTraceStorage({ homeDir, env });
  if (!selection.s3) {
    return {
      enabled: false,
      configured: false,
      autoActivateRepositories: false,
      envPath,
      settingsPath,
      configPath: selection.config.path,
      storageMode: selection.mode,
      error: selection.error,
    };
  }
  const setup = selection.s3;
  const credentials = setup.credentials;
  const { settings, source } = await readCaptureSettings(setup, settingsPath);
  // Capture eligibility has one owner. Direct storage keeps the legacy
  // machine switch (settings file or profile capture flag). An explicit
  // hosted selection is the machine-level opt-in; per-repository consent
  // and session provenance gate every hosted publication after that.
  const hosted =
    selection.mode === "hosted" &&
    hostedCaptureEnabled(selection.config.config);
  const status: TraceMachineStatus = {
    enabled: hosted || settings?.enabled === true,
    configured: hosted || credentials !== null,
    autoActivateRepositories:
      hosted ||
      (settings?.enabled === true &&
        settings.autoActivateRepositories === true),
    envPath,
    settingsPath,
    configPath: setup.configPath,
    storageMode: selection.mode,
    credentialsSource: setup.source,
    captureSource: source,
  };
  if (credentials) {
    status.endpoint = credentials.endpoint;
    status.bucket = credentials.bucket;
    status.region = credentials.region;
    status.accessKeyIdPrefix = credentials.accessKeyId.slice(0, 6);
  }
  if (settings?.verifiedAt) status.verifiedAt = settings.verifiedAt;
  if (settings?.error) status.error = settings.error;
  if (selection.error) status.error = selection.error;
  return status;
}

/**
 * Whether this machine captures agent sessions at all. Every gate (session
 * hook, scaffold discovery, hook installation, repository enable/repair)
 * asks this instead of reading the settings file itself.
 */
export async function traceMachineEnabled(
  input: {
    homeDir?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<boolean> {
  return (await traceMachineStatus(input)).enabled;
}

export async function configureTraceMachine(input: {
  credentials?: TraceCredentialsInput;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  verify?: boolean;
}): Promise<TraceMachineStatus> {
  const homeDir = input.homeDir ?? os.homedir();
  const env = input.env ?? process.env;
  const existing = await readTraceCredentials(homeDir, env);
  const credentials = {
    endpoint: input.credentials?.endpoint ?? existing?.endpoint ?? "",
    bucket: input.credentials?.bucket ?? existing?.bucket ?? "",
    key: input.credentials?.key ?? existing?.key ?? "",
    secret: input.credentials?.secret ?? existing?.secret ?? "",
  };
  if (!Object.values(credentials).every(Boolean)) {
    throw new Error(
      "Trace setup needs an S3/R2 endpoint, bucket, access key ID, and secret access key.",
    );
  }
  const region =
    input.credentials?.region?.trim() || existing?.region || S3_DEFAULT_REGION;

  // Setup updates whichever configuration source is active: the version-2
  // profile when one exists, the legacy files when only those exist or when
  // TRACE_ENV_FILE/TRACE_SETTINGS_FILE name them explicitly, and a new
  // version-2 profile on a machine that has neither.
  const configFile = readTraceConfigFile({ homeDir, env });
  if (configFile.error) throw new TraceConfigurationError(configFile.error);
  const envPath = traceEnvPath(homeDir, env);
  const legacyPathsRequested =
    env.TRACE_ENV_FILE !== undefined || env.TRACE_SETTINGS_FILE !== undefined;
  const target: "profile" | "legacy" =
    configFile.config?.stores?.s3 ||
    (!existsSync(envPath) && !legacyPathsRequested)
      ? "profile"
      : "legacy";

  if (target === "legacy") {
    await mkdir(path.dirname(envPath), { recursive: true });
    await writeFile(
      envPath,
      [
        `export TRACE_R2_ENDPOINT=${JSON.stringify(credentials.endpoint)}`,
        `export TRACE_R2_BUCKET=${JSON.stringify(credentials.bucket)}`,
        `export TRACE_R2_ACCESS_KEY_ID=${JSON.stringify(credentials.key)}`,
        `export TRACE_R2_SECRET_ACCESS_KEY=${JSON.stringify(credentials.secret)}`,
        `export TRACE_R2_REGION=${JSON.stringify(region)}`,
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    await chmod(envPath, 0o600);
    clearTraceEnvCache();
  }

  let error: string | undefined;
  let verifiedAt: string | undefined;
  if (input.verify !== false) {
    if (env.TRACE_R2_MODE === "mock") {
      verifiedAt = new Date().toISOString();
    } else {
      const doctor = await S3TraceStorage.fromCredentials(
        {
          endpoint: credentials.endpoint,
          bucket: credentials.bucket,
          accessKeyId: credentials.key,
          secretAccessKey: credentials.secret,
          region,
        },
        env,
      ).doctor();
      if (doctor.reachable) {
        verifiedAt = new Date().toISOString();
      } else {
        error = doctor.error;
      }
    }
  }

  if (target === "legacy") {
    const settings: TraceMachineSettings = {
      version: 1,
      enabled: true,
      autoActivateRepositories: true,
    };
    if (verifiedAt) settings.verifiedAt = verifiedAt;
    if (error) settings.error = error;
    await writeSettings(traceSettingsPath(homeDir, env), settings);
  } else {
    const capture: S3CaptureSettings = {
      enabled: true,
      autoActivateRepositories: true,
    };
    if (verifiedAt) capture.verifiedAt = verifiedAt;
    if (error) capture.error = error;
    const profile: S3Profile = {
      endpoint: credentials.endpoint,
      bucket: credentials.bucket,
      accessKeyId: credentials.key,
      secretAccessKey: credentials.secret,
      region,
      capture,
    };
    await writeS3Profile(configFile, profile);
    clearTraceEnvCache();
  }
  return traceMachineStatus({ homeDir, env });
}

/**
 * Stores the profile and, when nothing is selected yet, selects direct
 * storage explicitly. An explicit hosted selection is left alone: setup
 * never silently redirects uploads.
 */
async function writeS3Profile(
  configFile: TraceConfigFile,
  profile: S3Profile,
): Promise<void> {
  const current = configFile.config ?? emptyTraceConfig();
  await writeTraceConfigFile(configFile, {
    ...current,
    "current-store": current["current-store"] ?? "s3",
    stores: { ...current.stores, s3: profile },
  });
}

export async function disableTraceMachine(
  input: {
    homeDir?: string;
    env?: NodeJS.ProcessEnv;
    removeSettings?: boolean;
  } = {},
): Promise<void> {
  const homeDir = input.homeDir ?? os.homedir();
  const env = input.env ?? process.env;
  const configFile = readTraceConfigFile({ homeDir, env });
  if (configFile.error) throw new TraceConfigurationError(configFile.error);
  if (selectTraceStorage({ homeDir, env }).mode === "hosted") {
    // The hosted store gets its own switch; consent is left intact.
    const current = configFile.config ?? emptyTraceConfig();
    await writeTraceConfigFile(configFile, {
      ...current,
      stores: {
        ...current.stores,
        hosted: { ...current.stores?.hosted, capture: { enabled: false } },
      },
    });
    return;
  }
  const profile = configFile.config?.stores?.s3;
  if (profile?.capture) {
    // Credentials stay; only capture turns off.
    await writeS3Profile(configFile, {
      ...profile,
      capture: { ...profile.capture, enabled: false },
    });
    return;
  }
  const settingsPath = traceSettingsPath(homeDir, env);
  if (input.removeSettings) {
    await rm(settingsPath, { force: true });
    return;
  }
  await writeSettings(settingsPath, {
    version: 1,
    enabled: false,
    autoActivateRepositories: true,
  });
}

/** The legacy settings file alone, as `config migrate` reports it. */
export async function readLegacyCaptureSettings(
  filePath: string,
): Promise<S3CaptureSettings | null> {
  const legacy = await readSettings(filePath);
  if (!legacy) return null;
  const capture: S3CaptureSettings = {
    enabled: legacy.enabled,
    autoActivateRepositories: legacy.autoActivateRepositories,
  };
  if (legacy.verifiedAt) capture.verifiedAt = legacy.verifiedAt;
  if (legacy.error) capture.error = legacy.error;
  return capture;
}

async function readSettings(
  filePath: string,
): Promise<TraceMachineSettings | null> {
  try {
    const parsed = traceMachineSettingsSchema.safeParse(
      parseJsonText(await readFile(filePath, "utf8")),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

async function writeSettings(
  filePath: string,
  settings: TraceMachineSettings,
): Promise<void> {
  await writeFileAtomicAsync(
    filePath,
    `${JSON.stringify(settings, null, 2)}\n`,
    {
      encoding: "utf8",
      mode: 0o600,
    },
  );
}
