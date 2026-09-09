import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { jsonString, parseJsonText } from "@dev.fast/review-protocol";

import {
  type S3Profile,
  TraceConfigurationError,
  readTraceConfigFile,
  s3Store,
} from "./config";

/**
 * The legacy direct-bucket configuration: `TRACE_R2_*` variables from the
 * process environment or `~/.config/dev-trace/env`, and capture settings in
 * `~/.config/dev-trace/settings.json`. Every reader of those inputs resolves
 * them here so the precedence cannot drift between modules.
 *
 * Precedence for each value: process environment, then the env file. The
 * access key and secret also accept the plain AWS names as a fallback.
 */

export interface S3Credentials {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  // SigV4 signing region. R2 accepts "auto"; AWS S3 needs the bucket's
  // real region.
  region: string;
}

export interface S3ConfigScope {
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
}

export const S3_DEFAULT_REGION = "auto";

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

const envFileCache = new Map<string, Map<string, string>>();

export function clearTraceEnvCache(): void {
  envFileCache.clear();
}

/** Parses one `export NAME=value` file; a missing file reads as empty. */
export function readTraceEnvFile(envPath: string): Map<string, string> {
  const cached = envFileCache.get(envPath);
  if (cached) return cached;
  const values = new Map<string, string>();
  try {
    for (const line of readFileSync(envPath, "utf8").split("\n")) {
      const match = /^\s*(?:export\s+)?([A-Z0-9_]+)=(.*)$/.exec(line);
      if (!match) continue;
      values.set(match[1], unquoteEnvValue(match[2]));
    }
  } catch {
    // No env file; exported variables may still be present.
  }
  envFileCache.set(envPath, values);
  return values;
}

// Setup writes JSON-encoded values; hand-written files use bare or
// shell-quoted values. Read the JSON form first so escapes round-trip.
function unquoteEnvValue(raw: string): string {
  const trimmed = raw.trim();
  try {
    const decoded = jsonString(parseJsonText(trimmed));
    if (decoded !== undefined) return decoded;
  } catch {
    // Not JSON; fall through to the quote strip.
  }
  return trimmed.replace(/^["']|["']$/g, "").trim();
}

export function traceEnvValue(
  name: string,
  scope: S3ConfigScope = {},
): string | undefined {
  const env = scope.env ?? process.env;
  return (
    env[name] ?? readTraceEnvFile(traceEnvPath(scope.homeDir, env)).get(name)
  );
}

const S3_FIELDS = [
  "endpoint",
  "bucket",
  "accessKeyId",
  "secretAccessKey",
  "region",
] as const;
type S3Field = (typeof S3_FIELDS)[number];

/** The variables that supply each field, in precedence order. */
const S3_FIELD_VARIABLES: Record<S3Field, readonly string[]> = {
  endpoint: ["TRACE_R2_ENDPOINT"],
  bucket: ["TRACE_R2_BUCKET"],
  accessKeyId: ["TRACE_R2_ACCESS_KEY_ID", "AWS_ACCESS_KEY_ID"],
  secretAccessKey: ["TRACE_R2_SECRET_ACCESS_KEY", "AWS_SECRET_ACCESS_KEY"],
  region: ["TRACE_R2_REGION"],
};

export type S3CredentialsSource =
  | "profile"
  | "legacy-file"
  | "process-env"
  | "none";

export interface S3Setup {
  credentials: S3Credentials | null;
  /** Where the base values came from before environment overrides. */
  source: S3CredentialsSource;
  /** Variables the process environment supplied, in precedence order. */
  overrides: string[];
  envPath: string;
  configPath: string;
  profile: S3Profile | null;
}

/**
 * Resolves the direct bucket setup. A complete version-2 profile is the
 * base; otherwise the legacy env file is. Process environment variables
 * override either. An incomplete profile is a configuration error, never
 * patched from the legacy file. `ignoreProfile` reads the legacy inputs
 * only, which migration needs to describe what it would persist.
 */
export function resolveS3Setup(
  scope: S3ConfigScope & { ignoreProfile?: boolean } = {},
): S3Setup {
  const env = scope.env ?? process.env;
  const envPath = traceEnvPath(scope.homeDir, env);
  const configFile = readTraceConfigFile(scope);
  if (configFile.error) throw new TraceConfigurationError(configFile.error);
  const configPath = configFile.path;
  const profile = scope.ignoreProfile ? null : s3Store(configFile.config);
  const legacy = readTraceEnvFile(envPath);

  const overrides: string[] = [];
  const resolved: Record<S3Field, string | undefined> = {
    endpoint: undefined,
    bucket: undefined,
    accessKeyId: undefined,
    secretAccessKey: undefined,
    region: undefined,
  };
  let source: S3CredentialsSource = profile ? "profile" : "none";
  for (const field of S3_FIELDS) {
    const names = S3_FIELD_VARIABLES[field];
    const fromEnv = names.find((name) => env[name] !== undefined);
    if (fromEnv !== undefined) {
      overrides.push(fromEnv);
      resolved[field] = env[fromEnv];
      continue;
    }
    if (profile) {
      resolved[field] = profile[field];
      continue;
    }
    const fromFile = names.find((name) => legacy.has(name));
    if (fromFile !== undefined) {
      resolved[field] = legacy.get(fromFile);
      if (source === "none") source = "legacy-file";
    }
  }
  if (source === "none" && overrides.length > 0) source = "process-env";

  const { endpoint, bucket, accessKeyId, secretAccessKey } = resolved;
  const credentials =
    endpoint && bucket && accessKeyId && secretAccessKey
      ? {
          endpoint,
          bucket,
          accessKeyId,
          secretAccessKey,
          region: resolved.region ?? S3_DEFAULT_REGION,
        }
      : null;
  return {
    credentials,
    source: credentials ? source : "none",
    overrides,
    envPath,
    configPath,
    profile,
  };
}

export function resolveS3Credentials(
  scope: S3ConfigScope = {},
): S3Credentials | null {
  return resolveS3Setup(scope).credentials;
}

/** The bucket test double: object keys become files under this directory. */
export function s3MockRoot(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (env.TRACE_R2_MODE !== "mock") return null;
  return env.TRACE_R2_MOCK_DIR || null;
}

export function isS3MockMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.TRACE_R2_MODE === "mock";
}
