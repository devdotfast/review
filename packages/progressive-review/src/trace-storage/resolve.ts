import {
  type TraceConfigFile,
  TraceConfigurationError,
  readTraceConfigFile,
} from "./config";
import { DirectTraceStorage } from "./direct";
import {
  type DirectConfigScope,
  type DirectSetup,
  clearTraceEnvCache,
  isDirectMockMode,
  resolveDirectSetup,
} from "./direct-config";
import { HostedTraceStorage } from "./hosted";
import type { TraceStorage, TraceStorageKind } from "./types";

/**
 * Selects the remote trace store for this machine.
 *
 * | Configuration                                  | Selection                     |
 * | ---------------------------------------------- | ----------------------------- |
 * | No explicit mode; bucket credentials resolve    | direct (legacy behavior)      |
 * | No explicit mode; nothing configured           | none                          |
 * | Explicit direct                                | direct; missing creds = error |
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
  /** The direct setup, resolved even when hosted is selected (inert then). */
  direct: DirectSetup | null;
  hosted: { origin: string } | null;
  /** A configuration error. The selection must not be used for transfers. */
  error?: string;
}

export function selectTraceStorage(
  scope: DirectConfigScope = {},
): TraceStorageSelection {
  const env = scope.env ?? process.env;
  const config = readTraceConfigFile(scope);
  if (config.error) {
    return {
      mode: "none",
      explicit: false,
      config,
      direct: null,
      hosted: null,
      error: config.error,
    };
  }
  let direct: DirectSetup | null;
  try {
    direct = resolveDirectSetup(scope);
  } catch (error) {
    return {
      mode: "none",
      explicit: false,
      config,
      direct: null,
      hosted: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  const mock = isDirectMockMode(env);
  const selection = config.config?.storage;

  if (selection?.mode === "hosted") {
    return {
      mode: "hosted",
      explicit: true,
      config,
      direct,
      hosted: { origin: selection.origin },
    };
  }
  if (selection?.mode === "direct") {
    if (!direct.credentials && !mock) {
      return {
        mode: "direct",
        explicit: true,
        config,
        direct,
        hosted: null,
        error:
          "Direct trace storage is selected but no bucket credentials are configured. Run `review trace storage use direct --endpoint <url> --bucket <name> --key <id> --secret <secret>` or Review Agent Setup.",
      };
    }
    return { mode: "direct", explicit: true, config, direct, hosted: null };
  }
  if (direct.credentials || mock) {
    return { mode: "direct", explicit: false, config, direct, hosted: null };
  }
  return { mode: "none", explicit: false, config, direct, hosted: null };
}

export interface ResolveTraceStorageInput extends DirectConfigScope {
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
  if (mode === "direct") return directStorage(selection, input);
  return hostedStorage(selection, input);
}

/**
 * Names the destination a capture attempt was started for, so a detached
 * `review trace sync` can refuse to run once the selection changed.
 */
export function traceStorageExpectation(scope: DirectConfigScope = {}): string {
  const selection = selectTraceStorage(scope);
  if (selection.error || selection.mode === "none") return "none";
  if (selection.mode === "hosted") {
    return `hosted:${selection.hosted?.origin ?? ""}`;
  }
  const storage = directStorage(selection, scope);
  return `direct:${storage?.cacheIdentity() ?? ""}`;
}

function directStorage(
  selection: TraceStorageSelection,
  scope: DirectConfigScope,
): TraceStorage | null {
  const env = scope.env ?? process.env;
  if (isDirectMockMode(env)) return DirectTraceStorage.fromEnvironment(scope);
  const credentials = selection.direct?.credentials;
  if (!credentials) {
    throw new TraceConfigurationError(
      "Direct trace storage was requested but no bucket credentials are configured.",
    );
  }
  return DirectTraceStorage.fromCredentials(credentials, env);
}

async function hostedStorage(
  selection: TraceStorageSelection,
  input: ResolveTraceStorageInput,
): Promise<TraceStorage | null> {
  const origin = selection.hosted?.origin;
  if (!origin) {
    throw new TraceConfigurationError(
      "Hosted trace storage is not configured. Run `review trace storage use hosted`.",
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
export function isTraceStorageConfigured(
  scope: DirectConfigScope = {},
): boolean {
  const selection = selectTraceStorage(scope);
  return !selection.error && selection.mode !== "none";
}

export { clearTraceEnvCache };
