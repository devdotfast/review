import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { clearTraceEnvCache } from "./review-agent-traces";

const execFileAsync = promisify(execFile);

export interface TraceCredentialsInput {
  endpoint?: string;
  bucket?: string;
  key?: string;
  secret?: string;
  // SigV4 signing region. R2 accepts "auto"; AWS S3 needs the bucket's
  // real region.
  region?: string;
}

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
}

interface TraceMachineSettings {
  version: 1;
  enabled: boolean;
  autoActivateRepositories: true;
  verifiedAt?: string;
  error?: string;
}

export function traceEnvPath(
  homeDir = os.homedir(),
  env: NodeJS.ProcessEnv = process.env,
): string {
  return (
    env.TRACE_ENV_FILE ?? path.join(homeDir, ".config", "dev-trace", "env")
  );
}

export function traceSettingsPath(
  homeDir = os.homedir(),
  env: NodeJS.ProcessEnv = process.env,
): string {
  return (
    env.TRACE_SETTINGS_FILE ??
    path.join(homeDir, ".config", "dev-trace", "settings.json")
  );
}

export async function readTraceCredentials(
  homeDir = os.homedir(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<Required<TraceCredentialsInput> | null> {
  const values: Record<string, string> = {};
  const contents = await readFile(traceEnvPath(homeDir, env), "utf8").catch(
    () => "",
  );
  for (const line of contents.split("\n")) {
    const match = /^\s*(?:export\s+)?([A-Z0-9_]+)=(.*)$/.exec(line);
    if (!match) continue;
    const raw = match[2].trim();
    try {
      values[match[1]] = JSON.parse(raw) as string;
    } catch {
      values[match[1]] = raw.replace(/^["']|["']$/g, "");
    }
  }
  const credentials = {
    endpoint: env.TRACE_R2_ENDPOINT ?? values.TRACE_R2_ENDPOINT ?? "",
    bucket: env.TRACE_R2_BUCKET ?? values.TRACE_R2_BUCKET ?? "",
    key: env.TRACE_R2_ACCESS_KEY_ID ?? values.TRACE_R2_ACCESS_KEY_ID ?? "",
    secret:
      env.TRACE_R2_SECRET_ACCESS_KEY ?? values.TRACE_R2_SECRET_ACCESS_KEY ?? "",
  };
  if (!Object.values(credentials).every(Boolean)) return null;
  return {
    ...credentials,
    region: env.TRACE_R2_REGION ?? values.TRACE_R2_REGION ?? "auto",
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
  const credentials = await readTraceCredentials(homeDir, env);
  const settings = await readSettings(settingsPath);
  return {
    enabled: settings?.enabled === true,
    configured: credentials !== null,
    autoActivateRepositories:
      settings?.enabled === true && settings.autoActivateRepositories === true,
    envPath,
    settingsPath,
    ...(credentials
      ? {
          endpoint: credentials.endpoint,
          bucket: credentials.bucket,
          region: credentials.region,
          accessKeyIdPrefix: credentials.key.slice(0, 6),
        }
      : {}),
    ...(settings?.verifiedAt ? { verifiedAt: settings.verifiedAt } : {}),
    ...(settings?.error ? { error: settings.error } : {}),
  };
}

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
    input.credentials?.region?.trim() || existing?.region || "auto";

  const envPath = traceEnvPath(homeDir, env);
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

  let error: string | undefined;
  let verifiedAt: string | undefined;
  if (input.verify !== false) {
    if (env.TRACE_R2_MODE === "mock") {
      verifiedAt = new Date().toISOString();
    } else {
      try {
        await execFileAsync(
          "aws",
          [
            "--region",
            region,
            "--endpoint-url",
            credentials.endpoint,
            "s3api",
            "head-bucket",
            "--bucket",
            credentials.bucket,
          ],
          {
            timeout: 15_000,
            env: {
              ...env,
              AWS_ACCESS_KEY_ID: credentials.key,
              AWS_SECRET_ACCESS_KEY: credentials.secret,
            },
          },
        );
        verifiedAt = new Date().toISOString();
      } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause);
      }
    }
  }

  const settings: TraceMachineSettings = {
    version: 1,
    enabled: true,
    autoActivateRepositories: true,
    ...(verifiedAt ? { verifiedAt } : {}),
    ...(error ? { error } : {}),
  };
  await writeSettings(traceSettingsPath(homeDir, env), settings);
  return traceMachineStatus({ homeDir, env });
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

async function readSettings(
  filePath: string,
): Promise<TraceMachineSettings | null> {
  try {
    const value = JSON.parse(
      await readFile(filePath, "utf8"),
    ) as Partial<TraceMachineSettings>;
    return value.version === 1 && typeof value.enabled === "boolean"
      ? (value as TraceMachineSettings)
      : null;
  } catch {
    return null;
  }
}

async function writeSettings(
  filePath: string,
  settings: TraceMachineSettings,
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, {
    mode: 0o600,
  });
  await rm(filePath, { force: true });
  await import("node:fs/promises").then(({ rename }) =>
    rename(temporary, filePath),
  );
  await chmod(filePath, 0o600);
}
