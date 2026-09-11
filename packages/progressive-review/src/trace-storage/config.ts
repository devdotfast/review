import { readFileSync, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
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
import { normalizeStoreOrigin } from "../store-origin";
import { withFileLock } from "../with-file-lock";

/**
 * The shared trace configuration at `$DEV_REVIEW_HOME/trace/config.json`.
 *
 * Version 2 names the machine's current store, holds one entry per store
 * under `stores`, and lists hosted publication consent under
 * `repositories`. It never holds hosted tokens (those live in the auth
 * file) and it never replaces the legacy `~/.config/dev-trace` files, which
 * stay valid on their own. A hosted-only machine needs nothing beyond the
 * consent list; every other field has a default or is inferred.
 */

export const TRACE_CONFIG_VERSION = 2;

/** The two stores a machine can name. */
export const traceStoreNameSchema = z.enum(["s3", "hosted"]);
export type TraceStoreName = z.infer<typeof traceStoreNameSchema>;

/** The hosted origin used when a file names none. */
export const DEFAULT_HOSTED_ORIGIN = "https://app.dev.fast";

export const s3CaptureSchema = z.object({
  enabled: z.boolean(),
  autoActivateRepositories: z.boolean(),
  verifiedAt: z.string().optional(),
  error: z.string().optional(),
});
export type S3CaptureSettings = z.infer<typeof s3CaptureSchema>;

/** Your own S3-compatible bucket. Complete or rejected; never patched from legacy files. */
export const s3ProfileSchema = z.object({
  endpoint: z.string().min(1),
  bucket: z.string().min(1),
  accessKeyId: z.string().min(1),
  secretAccessKey: z.string().min(1),
  region: z.string().min(1).optional(),
  capture: s3CaptureSchema.optional(),
});
export type S3Profile = z.infer<typeof s3ProfileSchema>;

/** The hosted store in use. The login token lives in the auth file. */
export const hostedStoreSchema = z.object({
  origin: z.string().min(1).optional(),
  /** Machine-level capture switch for the hosted store; consent stays. */
  capture: z.object({ enabled: z.boolean() }).optional(),
});

/**
 * Hosted-only consent: one repository the user allowed to publish complete
 * session transcripts, and the hosted origins it may publish to. Bucket
 * uploads never read this list.
 */
export const traceRepositoryEntrySchema = z.object({
  repositoryId: z.number().int().positive(),
  name: z.string().min(1),
  enabledOrigins: z.array(z.string().min(1)).optional(),
  allowedAt: z.string().optional(),
});
export type TraceRepositoryEntry = z.infer<typeof traceRepositoryEntrySchema>;

export const traceConfigSchema = z.object({
  version: z.literal(TRACE_CONFIG_VERSION),
  "current-store": traceStoreNameSchema.optional(),
  stores: z
    .object({
      s3: s3ProfileSchema.optional(),
      hosted: hostedStoreSchema.optional(),
    })
    .optional(),
  repositories: z.array(traceRepositoryEntrySchema).optional(),
});
export type TraceConfig = z.infer<typeof traceConfigSchema>;

/** The empty configuration every writer starts from. */
export function emptyTraceConfig(): TraceConfig {
  return { version: TRACE_CONFIG_VERSION };
}

export function currentStore(
  config: TraceConfig | null,
): TraceStoreName | undefined {
  return config?.["current-store"];
}

export function s3Store(config: TraceConfig | null): S3Profile | null {
  return config?.stores?.s3 ?? null;
}

/** The hosted origin in effect: the store entry's, or the default. */
export function hostedOrigin(config: TraceConfig | null): string {
  const origin = config?.stores?.hosted?.origin;
  if (!origin) return DEFAULT_HOSTED_ORIGIN;
  try {
    return normalizeStoreOrigin(origin);
  } catch {
    return origin;
  }
}

/** Whether hosted capture is switched on; consent alone leaves it on. */
export function hostedCaptureEnabled(config: TraceConfig | null): boolean {
  return config?.stores?.hosted?.capture?.enabled ?? true;
}

/** Whether the file names a hosted store at all, explicitly or through consent. */
export function hasHostedStore(config: TraceConfig | null): boolean {
  return (
    config?.stores?.hosted !== undefined ||
    (config?.repositories?.length ?? 0) > 0
  );
}

/** The origins one consent entry allows; absent means the default origin. */
export function enabledOriginsOf(entry: TraceRepositoryEntry): string[] {
  return entry.enabledOrigins ?? [DEFAULT_HOSTED_ORIGIN];
}

// The unshipped hosted alpha wrote version 1: a flat consent list whose
// entries each named one store origin. Each becomes an entry enabled at
// that origin. It selects nothing by itself beyond the rules above.
const traceConfigV1Schema = z.object({
  version: z.literal(1),
  repositories: z.array(z.unknown()).optional(),
});
const v1RepositorySchema = z.object({
  repositoryId: z.number().int().positive(),
  name: z.string().min(1),
  store: z.string().min(1),
  allowedAt: z.string().optional(),
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
    // Stat first: a replacement between the two calls then reads as a later
    // change and is refused, never as a matching fingerprint over new bytes.
    const stats = statSync(filePath);
    fingerprint = `${stats.size}:${stats.mtimeMs}`;
    text = readFileSync(filePath, "utf8");
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
    const both =
      v2.data.stores?.s3 !== undefined && v2.data.stores?.hosted !== undefined;
    if (both && v2.data["current-store"] === undefined) {
      return malformed(
        'both stores are configured; set "current-store" to "s3" or "hosted".',
      );
    }
    return {
      path: filePath,
      source: "v2",
      config: v2.data,
      extra: unknownFields(raw, [
        "version",
        "current-store",
        "stores",
        "repositories",
      ]),
      fingerprint,
    };
  }
  const v1 = traceConfigV1Schema.safeParse(raw);
  if (v1.success) {
    const repositories = (v1.data.repositories ?? []).flatMap((entry) => {
      const parsed = v1RepositorySchema.safeParse(entry);
      if (!parsed.success) return [];
      const { store, ...rest } = parsed.data;
      return [{ ...rest, enabledOrigins: [store] }];
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
  if (file.error) throw new TraceConfigurationError(file.error);
  await mkdir(path.dirname(file.path), { recursive: true, mode: 0o700 });
  const outcome = await withFileLock(
    `${path.resolve(file.path)}.lock`,
    {
      retryMs: 20,
      timeoutMs: 10_000,
      staleMs: 120_000,
      heartbeatMs: 5_000,
      unownedGraceMs: 1_000,
    },
    async () => {
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
        "current-store": config["current-store"],
        stores: config.stores,
        repositories: config.repositories,
      };
      await writePrivateJsonAtomic(file.path, document);
    },
  );
  if (!outcome.acquired) {
    throw new TraceConfigurationError(
      `Trace configuration at ${file.path} is busy. Re-run the command after the current update finishes.`,
    );
  }
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
export function sameS3Profile(a: S3Profile, b: S3Profile): boolean {
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
