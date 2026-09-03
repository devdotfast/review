// Legacy machine trace settings.
//
// A past release kept S3/R2 credentials in ~/.config/dev-trace/env and a
// machine flag beside them. The hosted trace store replaced both: a user logs
// in with `review login` and allows one repository with `review trace allow`.
// This module only reports and clears what those releases left behind, so the
// install status stays truthful on an upgraded machine.

import { readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { jsonString, parseJsonText } from "@dev.fast/review-protocol";
import { z } from "zod";

import { writeFileAtomicAsync } from "./atomic-write";

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

const traceMachineSettingsSchema = z.object({
  version: z.literal(1),
  enabled: z.boolean(),
  autoActivateRepositories: z.literal(true),
  verifiedAt: z.string().optional(),
  error: z.string().optional(),
});
type TraceMachineSettings = z.infer<typeof traceMachineSettingsSchema>;

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
    let quoted: string | undefined;
    try {
      quoted = jsonString(parseJsonText(raw));
    } catch {
      quoted = undefined;
    }
    values[match[1]] = quoted ?? raw.replace(/^["']|["']$/g, "");
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
  const status: TraceMachineStatus = {
    enabled: settings?.enabled === true,
    configured: credentials !== null,
    autoActivateRepositories:
      settings?.enabled === true && settings.autoActivateRepositories === true,
    envPath,
    settingsPath,
  };
  if (credentials) {
    status.endpoint = credentials.endpoint;
    status.bucket = credentials.bucket;
    status.region = credentials.region;
    status.accessKeyIdPrefix = credentials.key.slice(0, 6);
  }
  if (settings?.verifiedAt) status.verifiedAt = settings.verifiedAt;
  if (settings?.error) status.error = settings.error;
  return status;
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
