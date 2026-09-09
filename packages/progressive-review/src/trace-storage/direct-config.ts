import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { jsonString, parseJsonText } from "@dev.fast/review-protocol";

/**
 * The legacy direct-bucket configuration: `TRACE_R2_*` variables from the
 * process environment or `~/.config/dev-trace/env`, and capture settings in
 * `~/.config/dev-trace/settings.json`. Every reader of those inputs resolves
 * them here so the precedence cannot drift between modules.
 *
 * Precedence for each value: process environment, then the env file. The
 * access key and secret also accept the plain AWS names as a fallback.
 */

export interface DirectCredentials {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  // SigV4 signing region. R2 accepts "auto"; AWS S3 needs the bucket's
  // real region.
  region: string;
}

export interface DirectConfigScope {
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
}

export const DIRECT_DEFAULT_REGION = "auto";

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
  scope: DirectConfigScope = {},
): string | undefined {
  const env = scope.env ?? process.env;
  return (
    env[name] ?? readTraceEnvFile(traceEnvPath(scope.homeDir, env)).get(name)
  );
}

export function resolveDirectCredentials(
  scope: DirectConfigScope = {},
): DirectCredentials | null {
  const value = (name: string) => traceEnvValue(name, scope);
  const bucket = value("TRACE_R2_BUCKET");
  const endpoint = value("TRACE_R2_ENDPOINT");
  const accessKeyId =
    value("TRACE_R2_ACCESS_KEY_ID") ?? value("AWS_ACCESS_KEY_ID");
  const secretAccessKey =
    value("TRACE_R2_SECRET_ACCESS_KEY") ?? value("AWS_SECRET_ACCESS_KEY");
  if (!bucket || !endpoint || !accessKeyId || !secretAccessKey) return null;
  const region = value("TRACE_R2_REGION") ?? DIRECT_DEFAULT_REGION;
  return { bucket, endpoint, accessKeyId, secretAccessKey, region };
}

/** The bucket test double: object keys become files under this directory. */
export function directMockRoot(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (env.TRACE_R2_MODE !== "mock") return null;
  return env.TRACE_R2_MOCK_DIR || null;
}

export function isDirectMockMode(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.TRACE_R2_MODE === "mock";
}
