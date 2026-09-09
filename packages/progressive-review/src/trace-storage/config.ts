import { readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  type JsonValue,
  jsonObject,
  parseJsonText,
} from "@dev.fast/review-protocol";
import { z } from "zod";

import { devReviewHome } from "../review-storage";
import { writePrivateJsonAtomic } from "../server/desktop-paths";

/**
 * The shared trace configuration at `$DEV_REVIEW_HOME/trace/config.json`.
 *
 * Version 2 holds the machine's storage selection, an optional first-class
 * direct bucket profile, and hosted repository consent records. It never
 * holds hosted tokens (those live in the auth file) and it never replaces
 * the legacy `~/.config/dev-trace` files, which stay valid on their own.
 */

export const TRACE_CONFIG_VERSION = 2;

export const traceRepositoryEntrySchema = z.object({
  repositoryId: z.number().int().positive(),
  name: z.string().min(1),
  store: z.string().min(1),
  allowedAt: z.string().optional(),
});
export type TraceRepositoryEntry = z.infer<typeof traceRepositoryEntrySchema>;

export const directCaptureSchema = z.object({
  enabled: z.boolean(),
  autoActivateRepositories: z.boolean(),
  verifiedAt: z.string().optional(),
  error: z.string().optional(),
});
export type DirectCaptureSettings = z.infer<typeof directCaptureSchema>;

export const directProfileSchema = z.object({
  endpoint: z.string().min(1),
  bucket: z.string().min(1),
  accessKeyId: z.string().min(1),
  secretAccessKey: z.string().min(1),
  region: z.string().min(1).optional(),
  capture: directCaptureSchema.optional(),
});
export type DirectProfile = z.infer<typeof directProfileSchema>;

export const traceStorageSelectionSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("direct") }),
  z.object({ mode: z.literal("hosted"), origin: z.string().min(1) }),
]);
export type TraceStorageSelection = z.infer<typeof traceStorageSelectionSchema>;

export const traceConfigSchema = z.object({
  version: z.literal(TRACE_CONFIG_VERSION),
  storage: traceStorageSelectionSchema.optional(),
  direct: directProfileSchema.optional(),
  repositories: z.array(traceRepositoryEntrySchema).optional(),
});
export type TraceConfig = z.infer<typeof traceConfigSchema>;

// The unshipped hosted alpha wrote version 1 with consent entries only. It
// is readable for status and consent, but selects nothing by itself.
const traceConfigV1Schema = z.object({
  version: z.literal(1),
  repositories: z.array(z.unknown()).optional(),
});

export type TraceConfigSource = "v2" | "v1" | "absent";

export interface TraceConfigFile {
  path: string;
  source: TraceConfigSource;
  /** Null when the file is absent or malformed. */
  config: TraceConfig | null;
  /** Unknown top-level fields, preserved across writes. */
  extra: Record<string, JsonValue>;
  /** Identifies the on-disk content a later write must still see. */
  fingerprint: string | null;
  /** Why the file could not be used. Set only for a malformed file. */
  error?: string;
}

export class TraceConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TraceConfigurationError";
  }
}

export interface TraceConfigScope {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  /** The Review home itself, when a caller already resolved it. */
  devHome?: string;
}

export function traceConfigPath(scope: TraceConfigScope = {}): string {
  const devHome =
    scope.devHome ??
    devReviewHome(scope.env ?? process.env, scope.homeDir ?? os.homedir());
  return path.join(devHome, "trace", "config.json");
}

export function readTraceConfigFile(
  scope: TraceConfigScope = {},
): TraceConfigFile {
  const filePath = traceConfigPath(scope);
  let text: string;
  let fingerprint: string;
  try {
    text = readFileSync(filePath, "utf8");
    const stats = statSync(filePath);
    fingerprint = `${stats.size}:${stats.mtimeMs}`;
  } catch {
    return {
      path: filePath,
      source: "absent",
      config: null,
      extra: {},
      fingerprint: null,
    };
  }
  const malformed = (reason: string): TraceConfigFile => ({
    path: filePath,
    source: "absent",
    config: null,
    extra: {},
    fingerprint,
    error: `Trace configuration at ${filePath} is invalid: ${reason}`,
  });

  let raw: Record<string, JsonValue> | undefined;
  try {
    raw = jsonObject(parseJsonText(text));
  } catch {
    return malformed("not valid JSON.");
  }
  if (!raw) return malformed("expected a JSON object.");

  const v2 = traceConfigSchema.safeParse(raw);
  if (v2.success) {
    return {
      path: filePath,
      source: "v2",
      config: v2.data,
      extra: unknownFields(raw, [
        "version",
        "storage",
        "direct",
        "repositories",
      ]),
      fingerprint,
    };
  }
  const v1 = traceConfigV1Schema.safeParse(raw);
  if (v1.success) {
    const repositories = (v1.data.repositories ?? []).flatMap((entry) => {
      const parsed = traceRepositoryEntrySchema.safeParse(entry);
      return parsed.success ? [parsed.data] : [];
    });
    return {
      path: filePath,
      source: "v1",
      config: { version: TRACE_CONFIG_VERSION, repositories },
      extra: unknownFields(raw, ["version", "repositories"]),
      fingerprint,
    };
  }
  const issue = v2.error.issues[0];
  const where = issue?.path.length ? ` at ${issue.path.join(".")}` : "";
  return malformed(`${issue?.message ?? "unsupported contents"}${where}.`);
}

/**
 * Replaces the configuration atomically with private permissions. The
 * write is refused when the file changed since it was read, so two
 * concurrent editors cannot silently drop each other's changes.
 */
export async function writeTraceConfigFile(
  file: TraceConfigFile,
  config: TraceConfig,
): Promise<void> {
  if (currentFingerprint(file.path) !== file.fingerprint) {
    throw new TraceConfigurationError(
      `Trace configuration at ${file.path} changed while it was being updated. Re-run the command.`,
    );
  }
  // JSON serialization drops undefined members, so absent sections and
  // absent optional fields leave no trace in the file.
  const document = {
    ...file.extra,
    version: TRACE_CONFIG_VERSION,
    storage: config.storage,
    direct: config.direct,
    repositories: config.repositories,
  };
  await writePrivateJsonAtomic(file.path, document);
}

function currentFingerprint(filePath: string): string | null {
  try {
    const stats = statSync(filePath);
    return `${stats.size}:${stats.mtimeMs}`;
  } catch {
    return null;
  }
}

function unknownFields(
  raw: Record<string, JsonValue>,
  known: readonly string[],
) {
  return Object.fromEntries(
    Object.entries(raw).filter(([key]) => !known.includes(key)),
  );
}

/** Direct profiles compare on destination, credentials, and capture settings. */
export function sameDirectProfile(a: DirectProfile, b: DirectProfile): boolean {
  return (
    a.endpoint === b.endpoint &&
    a.bucket === b.bucket &&
    a.accessKeyId === b.accessKeyId &&
    a.secretAccessKey === b.secretAccessKey &&
    (a.region ?? "auto") === (b.region ?? "auto") &&
    (a.capture?.enabled ?? false) === (b.capture?.enabled ?? false) &&
    (a.capture?.autoActivateRepositories ?? false) ===
      (b.capture?.autoActivateRepositories ?? false)
  );
}
