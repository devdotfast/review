import {
  type TraceConfigFile,
  TraceConfigurationError,
  currentStore,
  hasHostedStore,
  hostedOrigin,
  readTraceConfigFile,
  s3Store,
} from "./config";
import { HostedTraceStorage } from "./hosted";
import { S3TraceStorage } from "./s3";
import {
  type S3ConfigScope,
  type S3Setup,
  clearTraceEnvCache,
  isS3MockMode,
  resolveS3Setup,
} from "./s3-config";
import type { TraceStorage, TraceStorageKind } from "./types";

/**
 * Selects the remote trace store for this machine.
 *
 * | Configuration                                  | Selection                     |
 * | ---------------------------------------------- | ----------------------------- |
 * | No explicit mode; bucket credentials resolve    | s3 (legacy behavior)      |
 * | No explicit mode; nothing configured           | none                          |
 * | Explicit s3                                | s3; missing creds = error |
 * | Explicit hosted                                | hosted; needs login + consent |
 * | Hosted selected; bucket credentials also saved  | hosted; credentials inert     |
 * | Malformed or unsupported config                | error; no fallback            |
 */

export type TraceStorageMode = TraceStorageKind | "none";

export interface TraceStorageSelection {
  mode: TraceStorageMode;
  /** True when config.json names the mode; false when inferred. */
  explicit: boolean;
  config: TraceConfigFile;
  /** The s3 setup, resolved even when hosted is selected (inert then). */
  s3: S3Setup | null;
  /** The hosted store in effect, present whenever the file names one. */
  hosted: { origin: string } | null;
  /** A configuration error. The selection must not be used for transfers. */
  error?: string;
}

export function selectTraceStorage(
  scope: S3ConfigScope = {},
): TraceStorageSelection {
  const env = scope.env ?? process.env;
  const config = readTraceConfigFile(scope);
  if (config.error) {
    return {
      mode: "none",
      explicit: false,
      config,
      s3: null,
      hosted: null,
      error: config.error,
    };
  }
  let s3: S3Setup | null;
  try {
    s3 = resolveS3Setup(scope);
  } catch (error) {
    return {
      mode: "none",
      explicit: false,
      config,
      s3: null,
      hosted: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  const mock = isS3MockMode(env);
  const file = config.config;
  const pointer = currentStore(file);
  const hosted = hasHostedStore(file) ? { origin: hostedOrigin(file) } : null;
  const hasS3 = s3Store(file) !== null || s3.credentials !== null || mock;

  // Explicit pointer.
  if (pointer === "hosted") {
    return {
      mode: "hosted",
      explicit: true,
      config,
      s3,
      hosted: hosted ?? { origin: hostedOrigin(file) },
    };
  }
  if (pointer === "s3") {
    if (!hasS3) {
      return {
        mode: "s3",
        explicit: true,
        config,
        s3,
        hosted,
        error:
          "S3 trace storage is selected but no bucket credentials are configured. Run `review trace storage use s3 --endpoint <url> --bucket <name> --key <id> --secret <secret>` or Review Agent Setup.",
      };
    }
    return { mode: "s3", explicit: true, config, s3, hosted };
  }

  // Inferred: a bucket outranks hosted, so a consent entry alone never
  // redirects an existing bucket install; hosted alone needs only consent.
  if (hasS3) return { mode: "s3", explicit: false, config, s3, hosted };
  if (hosted) return { mode: "hosted", explicit: false, config, s3, hosted };
  return { mode: "none", explicit: false, config, s3, hosted };
}

export interface ResolveTraceStorageInput extends S3ConfigScope {
  /**
   * Read-only source override for one operation. It never changes the
   * persisted selection, capture settings, or consent.
   */
  override?: TraceStorageKind;
  /** The checkout whose repository a hosted store is resolved for. */
  cwd?: string;
  /** A write resolves the hosted target live and needs a login; reads may go offline. */
  purpose?: "read" | "write";
  /** Where hosted store failures are reported; stderr by default. */
  onWarning?: (message: string) => void;
}

/**
 * The store to use, or null when no remote storage is configured. Throws a
 * TraceConfigurationError instead of silently selecting another destination
 * when the configuration is malformed or incomplete.
 */
export async function resolveTraceStorage(
  input: ResolveTraceStorageInput = {},
): Promise<TraceStorage | null> {
  const selection = selectTraceStorage(input);
  if (selection.error) throw new TraceConfigurationError(selection.error);
  const mode = input.override ?? selection.mode;
  if (mode === "none") return null;
  if (mode === "s3") return s3Storage(selection, input);
  return hostedStorage(selection, input);
}

/**
 * Names the destination a capture attempt was started for, so a detached
 * `review trace sync` can refuse to run once the selection changed.
 */
export function traceStorageExpectation(scope: S3ConfigScope = {}): string {
  const selection = selectTraceStorage(scope);
  if (selection.error || selection.mode === "none") return "none";
  if (selection.mode === "hosted") {
    return `hosted:${selection.hosted?.origin ?? ""}`;
  }
  const storage = s3Storage(selection, scope);
  return `s3:${storage?.cacheIdentity() ?? ""}`;
}

function s3Storage(
  selection: TraceStorageSelection,
  scope: S3ConfigScope,
): TraceStorage | null {
  const env = scope.env ?? process.env;
  if (isS3MockMode(env)) return S3TraceStorage.fromEnvironment(scope);
  const credentials = selection.s3?.credentials;
  if (!credentials) {
    throw new TraceConfigurationError(
      "S3 trace storage was requested but no bucket credentials are configured.",
    );
  }
  return S3TraceStorage.fromCredentials(credentials, env);
}

async function hostedStorage(
  selection: TraceStorageSelection,
  input: ResolveTraceStorageInput,
): Promise<TraceStorage | null> {
  const origin = selection.hosted?.origin;
  if (!origin) {
    throw new TraceConfigurationError(
      "Hosted trace storage is not configured. Run `review trace allow .` or `review trace storage use hosted`.",
    );
  }
  const write = input.purpose === "write";
  const storage = await HostedTraceStorage.resolve({
    cwd: input.cwd ?? process.cwd(),
    origin,
    write,
    env: input.env,
    homeDir: input.homeDir,
    onWarning: input.onWarning,
  });
  if (!storage && write) {
    throw new TraceConfigurationError(
      "Hosted trace storage needs a GitHub checkout with an onboarded store. Run `review trace onboard` and `review trace allow .`.",
    );
  }
  return storage;
}

/** Whether the selected store can be used; a configuration error counts as no. */
export function isTraceStorageConfigured(scope: S3ConfigScope = {}): boolean {
  const selection = selectTraceStorage(scope);
  return !selection.error && selection.mode !== "none";
}

export { clearTraceEnvCache };
